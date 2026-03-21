const { errorResponse } = require('../utils/response');

const requireRole = (...roles) => {
  return (req, res, next) => {
    // Check req.user exists (protect must run before this)
    if (!req.user) {
      return errorResponse(res, 401, 'Authentication required');
    }

    // Check if user's role is in the allowed roles array
    if (!roles.includes(req.user.role)) {
      return errorResponse(res, 403, 'Access denied. Insufficient permissions.');
    }

    next();
  };
};

module.exports = { requireRole };
