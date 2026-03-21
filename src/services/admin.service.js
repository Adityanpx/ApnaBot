// src/services/admin.service.js — CREATE THIS FILE

const Shop = require('../models/Shop');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
const Usage = require('../models/Usage');
const Message = require('../models/Message');
const Booking = require('../models/Booking');
const logger = require('../utils/logger');

/**
 * Get platform-wide stats for admin dashboard
 */
const getPlatformStats = async () => {
  try {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalShops,
      activeShops,
      totalUsers,
      activeSubscriptions,
      totalMessagesThisMonth,
      totalBookingsThisMonth,
      revenueThisMonth
    ] = await Promise.all([
      Shop.countDocuments(),
      Shop.countDocuments({ isActive: true }),
      User.countDocuments({ role: { $in: ['owner', 'staff'] } }),
      Subscription.countDocuments({ status: 'active' }),
      Message.countDocuments({ createdAt: { $gte: startOfMonth } }),
      Booking.countDocuments({ createdAt: { $gte: startOfMonth } }),
      Subscription.aggregate([
        { $match: { status: 'active', createdAt: { $gte: startOfMonth } } },
        { $lookup: { from: 'plans', localField: 'planId', foreignField: '_id', as: 'plan' } },
        { $unwind: '$plan' },
        { $group: { _id: null, total: { $sum: '$plan.price' } } }
      ])
    ]);

    return {
      totalShops,
      activeShops,
      inactiveShops: totalShops - activeShops,
      totalUsers,
      activeSubscriptions,
      totalMessagesThisMonth,
      totalBookingsThisMonth,
      revenueThisMonth: revenueThisMonth[0]?.total || 0,
      month: currentMonth
    };
  } catch (error) {
    logger.error('Error in getPlatformStats:', error);
    throw error;
  }
};

/**
 * Get monthly revenue report
 */
const getRevenueReport = async (months = 6) => {
  try {
    const report = [];
    const now = new Date();

    for (let i = 0; i < months; i++) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const endDate = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

      const result = await Subscription.aggregate([
        {
          $match: {
            status: { $in: ['active', 'expired'] },
            createdAt: { $gte: date, $lte: endDate }
          }
        },
        { $lookup: { from: 'plans', localField: 'planId', foreignField: '_id', as: 'plan' } },
        { $unwind: '$plan' },
        {
          $group: {
            _id: null,
            revenue: { $sum: '$plan.price' },
            count: { $sum: 1 }
          }
        }
      ]);

      report.push({
        month: monthKey,
        revenue: result[0]?.revenue || 0,
        subscriptions: result[0]?.count || 0
      });
    }

    return report.reverse();
  } catch (error) {
    logger.error('Error in getRevenueReport:', error);
    throw error;
  }
};

module.exports = {
  getPlatformStats,
  getRevenueReport
};
