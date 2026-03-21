// src/seeds/planSeed.js — REPLACE ENTIRE FILE

const Plan = require('../models/Plan');
const logger = require('../utils/logger');

const plans = [
  {
    name: 'basic',
    displayName: 'Basic',
    price: 199,
    msgLimit: 500,
    ruleLimit: 10,
    customerLimit: 100,
    bookingEnabled: true,
    paymentLinkEnabled: false,
    staffEnabled: false,
    maxStaff: 0,
    isActive: true
  },
  {
    name: 'pro',
    displayName: 'Pro',
    price: 399,
    msgLimit: 2000,
    ruleLimit: 50,
    customerLimit: 500,
    bookingEnabled: true,
    paymentLinkEnabled: true,
    staffEnabled: true,
    maxStaff: 2,
    isActive: true
  },
  {
    name: 'business',
    displayName: 'Business',
    price: 699,
    msgLimit: -1,       // unlimited
    ruleLimit: -1,      // unlimited
    customerLimit: -1,  // unlimited
    bookingEnabled: true,
    paymentLinkEnabled: true,
    staffEnabled: true,
    maxStaff: 5,
    isActive: true
  }
];

const seedPlans = async () => {
  try {
    for (const planData of plans) {
      const existing = await Plan.findOne({ name: planData.name });
      if (!existing) {
        await Plan.create(planData);
        logger.info(`Plan created: ${planData.displayName}`);
      } else {
        // Update existing plan with latest values
        await Plan.findOneAndUpdate({ name: planData.name }, planData);
        logger.info(`Plan updated: ${planData.displayName}`);
      }
    }
    logger.info('Plan seeding complete');
  } catch (error) {
    logger.error('Plan seeding error:', error);
    throw error;
  }
};

module.exports = seedPlans;
