// src/seeds/planSeed.js — REPLACE ENTIRE FILE

const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const plans = [
  {
    name: 'basic', display_name: 'Basic', price: 199,
    msg_limit: 500, rule_limit: 10, customer_limit: 100,
    booking_enabled: true, payment_link_enabled: false,
    staff_enabled: false, max_staff: 0, is_active: true
  },
  {
    name: 'pro', display_name: 'Pro', price: 399,
    msg_limit: 2000, rule_limit: 50, customer_limit: 500,
    booking_enabled: true, payment_link_enabled: true,
    staff_enabled: true, max_staff: 2, is_active: true
  },
  {
    name: 'business', display_name: 'Business', price: 699,
    msg_limit: -1, rule_limit: -1, customer_limit: -1,
    booking_enabled: true, payment_link_enabled: true,
    staff_enabled: true, max_staff: 5, is_active: true
  }
];

const seedPlans = async () => {
  try {
    for (const planData of plans) {
      const { data: existing, error: findErr } = await supabase
        .from('plans').select('id').eq('name', planData.name).maybeSingle();
      if (findErr) throw findErr;

      if (!existing) {
        const { error } = await supabase.from('plans').insert(planData);
        if (error) throw error;
        logger.info(`Plan created: ${planData.display_name}`);
      } else {
        const { error } = await supabase.from('plans').update(planData).eq('name', planData.name);
        if (error) throw error;
        logger.info(`Plan updated: ${planData.display_name}`);
      }
    }
    logger.info('Plan seeding complete');
  } catch (error) {
    logger.error('Plan seeding error:', error);
    throw error;
  }
};

module.exports = seedPlans;