const Subscription = require('../models/Subscription');
const { errorResponse } = require('../utils/response');
const redis = require('../config/redis');

const requireFeature = (featureName) => {
  return async (req, res, next) => {
    // Superadmin bypasses plan check
    if (req.user.role === 'superadmin') {
      return next();
    }

    try {
      const shopId = req.user.shopId;
      const cacheKey = `subscription:${shopId}`;

      // Try to get from cache first
      let subscription = await redis.get(cacheKey);
      
      if (subscription) {
        subscription = JSON.parse(subscription);
      } else {
        // Query DB if not in cache
        subscription = await Subscription.findOne({ 
          shopId, 
          status: 'active' 
        }).populate('planId');

        if (subscription) {
          // Cache for 5 minutes
          await redis.set(cacheKey, JSON.stringify(subscription), 'EX', 300);
        }
      }

      // Check if subscription exists and is active
      if (!subscription || subscription.status !== 'active') {
        return errorResponse(res, 403, 'No active subscription. Please subscribe to continue.');
      }

      // Get the plan
      const plan = subscription.planId || subscription.planId;

      // Check if feature is enabled
      let featureEnabled = false;
      switch (featureName) {
        case 'paymentLink':
          featureEnabled = plan.paymentLinkEnabled;
          break;
        case 'staff':
          featureEnabled = plan.staffEnabled;
          break;
        case 'booking':
          featureEnabled = plan.bookingEnabled;
          break;
        default:
          featureEnabled = false;
      }

      if (!featureEnabled) {
        return errorResponse(res, 403, 'This feature is not available on your current plan. Please upgrade.');
      }

      // Attach subscription to req
      req.subscription = {
        plan,
        subscription
      };

      next();
    } catch (error) {
      next(error);
    }
  };
};

module.exports = { requireFeature };
