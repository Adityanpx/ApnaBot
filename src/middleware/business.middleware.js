const { errorResponse } = require('../utils/response');

const requireBusiness = (req, res, next) => {
  // Superadmin bypasses business check
  if (req.user.role === 'superadmin') {
    return next();
  }

  // Check if user has a businessId
  if (!req.user.businessId) {
    return errorResponse(res, 403, 'No business associated with this account. Please create your business first.');
  }

  next();
};

module.exports = { requireBusiness };
