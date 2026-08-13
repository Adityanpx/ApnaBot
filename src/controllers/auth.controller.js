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
const { generateResetToken, generateOtp } = require('../utils/crypto');
const redis = require('../config/redis');

const register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    
    if (!name || !email || !password) {
      return errorResponse(res, 400, 'Name, email, and password are required');
    }
    
    if (password.length < 6) {
      return errorResponse(res, 400, 'Password must be at least 6 characters');
    }
    
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return errorResponse(res, 409, 'Email already registered');
    }
    
    const user = new User({
      name,
      email: email.toLowerCase(),
      passwordHash: password,
      role: 'owner',
      businessId: null,
      permissions: buildPermissions('owner'),
      isVerified: false
    });

    await user.save();

    const otp = generateOtp();

    await redis.set(`verify-email:${user._id}`, otp, 'EX', 600);

    // DEV MODE — log OTP to terminal so you can test without email setup
    logger.info(`DEV MODE — Email verification OTP for ${user.email}: ${otp}`);

    try {
      const emailService = require('../services/email.service');
      await emailService.sendVerificationEmail(user.email, otp, user.name);
    } catch (emailError) {
      // Log but don't fail the request — OTP is saved and logged above
      logger.error('Failed to send verification email:', emailError);
    }

    const payload = {
      userId: user._id,
      businessId: user.businessId,
      role: user.role,
      permissions: user.permissions
    };

    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(user._id);

    await saveRefreshToken(user._id.toString(), refreshToken);

    return successResponse(res, 201, {
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        businessId: user.businessId,
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
    
    const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
    
    if (!user) {
      return errorResponse(res, 401, 'Invalid credentials');
    }
    
    if (user.isActive === false) {
      return errorResponse(res, 403, 'Account is deactivated');
    }
    
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return errorResponse(res, 401, 'Invalid credentials');
    }

    if (!user.isVerified) {
      return errorResponse(res, 403, 'Please verify your email before logging in', { code: 'EMAIL_NOT_VERIFIED' });
    }

    user.lastLoginAt = new Date();
    await user.save();
    
    const payload = {
      userId: user._id,
      businessId: user.businessId,
      role: user.role,
      permissions: user.permissions
    };
    
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(user._id);
    
    await saveRefreshToken(user._id.toString(), refreshToken);
    
    return successResponse(res, 200, {
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        businessId: user.businessId,
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
    
    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch (err) {
      return errorResponse(res, 401, 'Invalid refresh token');
    }
    
    const storedToken = await getRefreshToken(decoded.userId);
    if (storedToken !== refreshToken) {
      return errorResponse(res, 401, 'Refresh token expired or revoked');
    }
    
    const user = await User.findById(decoded.userId);
    if (!user || user.isActive === false) {
      return errorResponse(res, 401, 'User not found');
    }
    
    const payload = {
      userId: user._id,
      businessId: user.businessId,
      role: user.role,
      permissions: user.permissions
    };
    
    const accessToken = generateAccessToken(payload);
    
    return successResponse(res, 200, { accessToken }, 'Token refreshed');
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
    
    let userId = null;
    try {
      const decoded = verifyRefreshToken(refreshToken);
      userId = decoded.userId;
    } catch (err) {
      logger.info('Invalid refresh token during logout');
    }
    
    if (userId) {
      await deleteRefreshToken(userId);
    }
    
    return successResponse(res, 200, null, 'Logged out successfully');
  } catch (error) {
    logger.error('Logout error:', error);
    return successResponse(res, 200, null, 'Logged out successfully');
  }
};

const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return errorResponse(res, 400, 'Email is required');
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    if (user) {
      const resetToken = generateResetToken();

      // Save to Redis with 1 hour TTL
      await redis.set(`reset:${user._id}`, resetToken, 'EX', 3600);

      // DEV MODE — log token to terminal so you can test without email setup
      logger.info(`DEV MODE — Password reset token for ${email}: ${resetToken}`);

      // Send actual email (fails gracefully if email not configured)
      try {
        const emailService = require('../services/email.service');
        await emailService.sendPasswordResetEmail(user.email, resetToken, user.name);
      } catch (emailError) {
        // Log but don't fail the request — token is saved and logged above
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
    
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return errorResponse(res, 400, 'Invalid or expired reset token');
    }
    
    const storedToken = await redis.get(`reset:${user._id}`);
    if (!storedToken || storedToken !== token) {
      return errorResponse(res, 400, 'Invalid or expired reset token');
    }
    
    user.passwordHash = newPassword;
    await user.save();
    
    await redis.del(`reset:${user._id}`);
    await deleteRefreshToken(user._id.toString());
    
    return successResponse(res, 200, null, 'Password reset successfully');
  } catch (error) {
    logger.error('Reset password error:', error);
    next(error);
  }
};

const verifyEmail = async (req, res, next) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return errorResponse(res, 400, 'Email and OTP are required');
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return errorResponse(res, 404, 'User not found');
    }

    if (user.isVerified) {
      return successResponse(res, 200, null, 'Email already verified');
    }

    const storedOtp = await redis.get(`verify-email:${user._id}`);
    if (!storedOtp || storedOtp !== otp) {
      return errorResponse(res, 400, 'Invalid or expired OTP');
    }

    user.isVerified = true;
    await user.save();

    await redis.del(`verify-email:${user._id}`);

    return successResponse(res, 200, null, 'Email verified successfully');
  } catch (error) {
    logger.error('Verify email error:', error);
    next(error);
  }
};

const resendVerificationOtp = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return errorResponse(res, 400, 'Email is required');
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return errorResponse(res, 404, 'User not found');
    }

    if (user.isVerified) {
      return successResponse(res, 200, null, 'Email already verified');
    }

    const otp = generateOtp();

    await redis.set(`verify-email:${user._id}`, otp, 'EX', 600);

    // DEV MODE — log OTP to terminal so you can test without email setup
    logger.info(`DEV MODE — Email verification OTP for ${user.email}: ${otp}`);

    try {
      const emailService = require('../services/email.service');
      await emailService.sendVerificationEmail(user.email, otp, user.name);
    } catch (emailError) {
      logger.error('Failed to send verification email:', emailError);
    }

    return successResponse(res, 200, null, 'Verification code sent');
  } catch (error) {
    logger.error('Resend verification OTP error:', error);
    next(error);
  }
};

module.exports = {
  register,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerificationOtp
};