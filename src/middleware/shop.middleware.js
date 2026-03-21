const { errorResponse } = require('../utils/response');

const requireShop = (req, res, next) => {
  // Superadmin bypasses shop check
  if (req.user.role === 'superadmin') {
    return next();
  }

  // Check if user has a shopId
  if (!req.user.shopId) {
    return errorResponse(res, 403, 'No shop associated with this account. Please create your shop first.');
  }

  next();
};

module.exports = { requireShop };
