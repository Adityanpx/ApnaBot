const reportsService = require('../services/reports.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

const VALID_PERIODS = ['week', 'month'];

/**
 * GET /api/reports/summary?period=week|month
 */
const getSummary = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const { period } = req.query;
    if (!VALID_PERIODS.includes(period)) {
      return errorResponse(res, 400, `Invalid period. Must be one of: ${VALID_PERIODS.join(', ')}`);
    }

    const summary = await reportsService.getReportsSummary(businessId, period);

    return successResponse(res, 200, summary);
  } catch (error) {
    logger.error('Error in getSummary:', error);
    next(error);
  }
};

module.exports = {
  getSummary
};
