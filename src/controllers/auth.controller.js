const User = require('../models/User');
const { 
  generateAccessToken, 
  generateRefreshToken, 
  saveRefreshToken, 
  getRefreshToken, 
  deleteRefreshToken,
  verifyRefreshToken,
  buildPermissions 
} = require('../services/auth.service');
const { errorResponse, successResponse } = require('../utils/response');
const logger = require('../utils/logger');
const { generateResetToken } = require('../utils/crypto');
const redis = require('../config/redis');

const register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    
    // Validate required fields
    if (!name || !email || !password) {
      return errorResponse(res, 400, 'Name, email, and password are required');
    }
    
    if (password.length < 6) {
      return errorResponse(res, 400, 'Password must be at least 6 characters');
    }
    
    // Check if email already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return errorResponse(res, 409, 'Email already registered');
    }
    
    // Create new user with role 'owner'
    const user = new User({
      name,
      email: email.toLowerCase(),
      passwordHash: password, // pre-save hook will hash it
      role: 'owner',
      shopId: null,
      permissions: buildPermissions('owner'),
      isVerified: true
    });
    
    await user.save();
    
    // Generate tokens
    const payload = {
      userId: user._id,
      shopId: user.shopId,
      role: user.role,
      permissions: user.permissions
    };
    
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(user._id);
    
    // Save refresh token to Redis
    await saveRefreshToken(user._id.toString(), refreshToken);
    
    return successResponse(res, 201, {
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        shopId: user.shopId,
        permissions: user.permissions
      },
      accessToken,
      refreshToken
    }, 'Registration successful');
  } catch (error) {
    logger.error('Register error:', error);
    next(error);
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return errorResponse(res, 400, 'Email and password are required');
    }
    
    // Find user by email (include passwordHash)
    const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
    
    if (!user) {
      return errorResponse(res, 401, 'Invalid credentials');
    }
    
    if (user.isActive === false) {
      return errorResponse(res, 403, 'Account is deactivated');
    }
    
    // Compare password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return errorResponse(res, 401, 'Invalid credentials');
    }
    
    // Update last login
    user.lastLoginAt = new Date();
    await user.save();
    
    // Build JWT payload
    const payload = {
      userId: user._id,
      shopId: user.shopId,
      role: user.role,
      permissions: user.permissions
    };
    
    // Generate tokens
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(user._id);
    
    // Save refresh token to Redis
    await saveRefreshToken(user._id.toString(), refreshToken);
    
    return successResponse(res, 200, {
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        shopId: user.shopId,
        permissions: user.permissions
      },
      accessToken,
      refreshToken
    }, 'Login successful');
  } catch (error) {
    logger.error('Login error:', error);
    next(error);
  }
};

const refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return errorResponse(res, 400, 'Refresh token required');
    }
    
    // Verify refresh token
    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch (err) {
      return errorResponse(res, 401, 'Invalid refresh token');
    }
    
    // Get stored token from Redis
    const storedToken = await getRefreshToken(decoded.userId);
    if (storedToken !== refreshToken) {
      return errorResponse(res, 401, 'Refresh token expired or revoked');
    }
    
    // Find user
    const user = await User.findById(decoded.userId);
    if (!user || user.isActive === false) {
      return errorResponse(res, 401, 'User not found');
    }
    
    // Generate new access token
    const payload = {
      userId: user._id,
      shopId: user.shopId,
      role: user.role,
      permissions: user.permissions
    };
    
    const accessToken = generateAccessToken(payload);
    
    return successResponse(res, 200, 'Token refreshed', { accessToken });
  } catch (error) {
    logger.error('Refresh error:', error);
    next(error);
  }
};

const logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return errorResponse(res, 400, 'Refresh token required');
    }
    
    // Try to verify token to get userId, but don't fail if invalid
    let userId = null;
    try {
      const decoded = verifyRefreshToken(refreshToken);
      userId = decoded.userId;
    } catch (err) {
      // Token invalid, but still try to clean up
      logger.info('Invalid refresh token during logout');
    }
    
    // Delete from Redis if we have userId
    if (userId) {
      await deleteRefreshToken(userId);
    }
    
    return successResponse(res, 200, 'Logged out successfully');
  } catch (error) {
    logger.error('Logout error:', error);
    // Don't fail loudly for logout
    return successResponse(res, 200, 'Logged out successfully');
  }
};

const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return errorResponse(res, 400, 'Email is required');
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    // Always return same message for security (don't reveal if email exists)
    if (user) {
      const resetToken = generateResetToken();

      // Save to Redis with 1 hour TTL
      await redis.set(`reset:${user._id}`, resetToken, 'EX', 3600);

      // Send actual email
      try {
        const emailService = require('../services/email.service');
        await emailService.sendPasswordResetEmail(user.email, resetToken, user.name);
      } catch (emailError) {
        // Log but don't fail the request — token is saved, user can retry
        logger.error('Failed to send reset email:', emailError);
      }
    }

    return successResponse(res, 200, null, 'If this email is registered, a reset link has been sent.');
  } catch (error) {
    logger.error('Forgot password error:', error);
    next(error);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    const { email, token, newPassword } = req.body;
    
    if (!email || !token || !newPassword) {
      return errorResponse(res, 400, 'Email, token, and newPassword are required');
    }
    
    if (newPassword.length < 6) {
      return errorResponse(res, 400, 'Password must be at least 6 characters');
    }
    
    // Find user
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return errorResponse(res, 400, 'Invalid or expired reset token');
    }
    
    // Get stored token from Redis
    const storedToken = await redis.get(`reset:${user._id}`);
    if (!storedToken || storedToken !== token) {
      return errorResponse(res, 400, 'Invalid or expired reset token');
    }
    
    // Update password
    user.passwordHash = newPassword; // pre-save hook will hash it
    await user.save();
    
    // Delete reset token
    await redis.del(`reset:${user._id}`);
    
    // Delete refresh token (force re-login)
    await deleteRefreshToken(user._id.toString());
    
    return successResponse(res, 200, 'Password reset successfully');
  } catch (error) {
    logger.error('Reset password error:', error);
    next(error);
  }
};

module.exports = {
  register,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword
};
