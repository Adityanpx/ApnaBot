const { errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  logger.error('Error:', err);

  if (err.name === 'ValidationError') {
    return errorResponse(res, 400, err.message, Object.values(err.errors).map(e => e.message));
  }

  if (err.code === 11000) {
    return errorResponse(res, 409, 'Duplicate key error', Object.keys(err.keyValue));
  }

  if (err.name === 'JsonWebTokenError') {
    return errorResponse(res, 401, 'Invalid token');
  }

  if (err.name === 'TokenExpiredError') {
    return errorResponse(res, 401, 'Token expired');
  }

  return errorResponse(res, err.statusCode || 500, err.message || 'Internal Server Error');
};

module.exports = errorHandler;
