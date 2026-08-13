const User = require('../models/User');
const { verifyAccessToken } = require('../services/auth.service');
const { errorResponse } = require('../utils/response');

const protect = async (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse(res, 401, 'No token provided');
    }

    const token = authHeader.split(' ')[1];

    // Verify token
    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (err) {
      return errorResponse(res, 401, 'Invalid or expired token');
    }

    // Find user by decoded.userId
    const user = await User.findById(decoded.userId);
    if (!user) {
      return errorResponse(res, 401, 'User not found');
    }

    // Check if user is active
    if (user.isActive === false) {
      return errorResponse(res, 403, 'Account is deactivated');
    }

    // Attach user to request
    req.user = {
      userId: user._id,
      businessId: user.businessId,
      role: user.role,
      permissions: user.permissions,
      name: user.name,
      email: user.email
    };

    next();
  } catch (error) {
    next(error);
  }
};

const requireBusiness = (req, res, next) => {
  if (!req.user.businessId) {
    return errorResponse(res, 403, 'No business found. Please create a business first.');
  }
  next();
};

module.exports = { protect, requireBusiness };
