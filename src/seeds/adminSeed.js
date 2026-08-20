const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const seedAdmin = async () => {
  try {
    const { data: existing } = await supabase
      .from('users').select('id').eq('role', 'superadmin').maybeSingle();

    if (existing) {
      logger.info('Superadmin already exists, skipping seed');
      return;
    }

    const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123456', 12);

    const { data: admin, error } = await supabase.from('users').insert({
      name: 'Super Admin',
      email: process.env.ADMIN_EMAIL || 'admin@apnabot.com',
      password_hash: passwordHash,
      role: 'superadmin',
      business_id: null,
      is_verified: true, // seeded from trusted env vars, not self-registration — email-OTP verification doesn't apply
      can_view_chats: true,
      can_manage_rules: true,
      can_manage_bookings: true,
      can_view_customers: true,
      can_manage_billing: true,
      is_active: true
    }).select().single();
    if (error) throw error;

    logger.info(`Superadmin created: ${admin.email}`);
  } catch (error) {
    logger.error('Admin seeding error:', error);
    throw error;
  }
};

module.exports = seedAdmin;
