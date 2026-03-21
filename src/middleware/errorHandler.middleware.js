const { errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  logger.error('Error:', err);

  if (err.name === 'ValidationError') {
    return errorResponse(res, err.message, 400, Object.values(err.errors).map(e => e.message));
  }

  if (err.code === 11000) {
    return errorResponse(res, 'Duplicate key error', 409, Object.keys(err.keyValue));
  }

  if (err.name === 'JsonWebTokenError') {
    return errorResponse(res, 'Invalid token', 401);
  }

  if (err.name === 'TokenExpiredError') {
    return errorResponse(res, 'Token expired', 401);
  }

  return errorResponse(res, err.message || 'Internal Server Error', err.statusCode || 500);
};

module.exports = errorHandler;
