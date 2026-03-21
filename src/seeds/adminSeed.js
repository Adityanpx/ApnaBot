// src/seeds/adminSeed.js — REPLACE ENTIRE FILE

const User = require('../models/User');
const logger = require('../utils/logger');

const seedAdmin = async () => {
  try {
    const existing = await User.findOne({ role: 'superadmin' });

    if (existing) {
      logger.info('Superadmin already exists, skipping seed');
      return;
    }

    const admin = new User({
      name: 'Super Admin',
      email: process.env.ADMIN_EMAIL || 'admin@apnabot.com',
      passwordHash: process.env.ADMIN_PASSWORD || 'admin123456',
      role: 'superadmin',
      shopId: null,
      permissions: {
        canViewChats: true,
        canManageRules: true,
        canManageBookings: true,
        canViewCustomers: true,
        canManageBilling: true
      },
      isActive: true
    });

    await admin.save(); // pre-save hook hashes the password

    logger.info(`Superadmin created: ${admin.email}`);
  } catch (error) {
    logger.error('Admin seeding error:', error);
    throw error;
  }
};

module.exports = seedAdmin;
