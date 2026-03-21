// src/controllers/staff.controller.js — CREATE THIS FILE

const User = require('../models/User');
const Subscription = require('../models/Subscription');
const { successResponse, errorResponse } = require('../utils/response');
const { buildPermissions } = require('../services/auth.service');
const logger = require('../utils/logger');

/**
 * GET /api/staff
 * List all staff members in the shop
 */
const getStaff = async (req, res, next) => {
  try {
    const shopId = req.user.shopId;

    const staff = await User.find({ shopId, role: 'staff' })
      .select('-passwordHash')
      .sort({ createdAt: -1 });

    return successResponse(res, 200, { staff, total: staff.length });
  } catch (error) {
    logger.error('Error in getStaff:', error);
    next(error);
  }
};

/**
 * POST /api/staff/invite
 * Create a staff account under this shop.
 * Validates plan staff limit before creating.
 */
const inviteStaff = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    const shopId = req.user.shopId;

    if (!name || !email || !password) {
      return errorResponse(res, 400, 'Name, email, and password are required');
    }
    if (password.length < 6) {
      return errorResponse(res, 400, 'Password must be at least 6 characters');
    }

    // Check plan allows staff
    const subscription = await Subscription.findOne({ shopId, status: 'active' })
      .populate('planId');

    if (!subscription) {
      return errorResponse(res, 403, 'No active subscription. Cannot add staff.');
    }
    if (!subscription.planId.staffEnabled) {
      return errorResponse(res, 403, 'Staff feature not available on your plan. Please upgrade.');
    }

    const maxStaff = subscription.planId.maxStaff || 0;
    const currentCount = await User.countDocuments({ shopId, role: 'staff', isActive: true });

    if (currentCount >= maxStaff) {
      return errorResponse(res, 403, `Staff limit reached (${maxStaff}). Please upgrade your plan.`);
    }

    // Check email not already registered
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return errorResponse(res, 409, 'Email is already registered');

    const staffUser = new User({
      name: name.trim(),
      email: email.toLowerCase(),
      passwordHash: password, // pre-save hook in User model hashes this
      role: 'staff',
      shopId,
      permissions: buildPermissions('staff'),
      isActive: true
    });
    await staffUser.save();

    const responseUser = staffUser.toObject();
    delete responseUser.passwordHash;

    logger.info(`Staff ${staffUser._id} created for shop ${shopId}`);
    return successResponse(res, 201, responseUser, 'Staff member added successfully');
  } catch (error) {
    logger.error('Error in inviteStaff:', error);
    next(error);
  }
};

/**
 * PUT /api/staff/:id/permissions
 * Update staff permissions — canManageRules and canManageBilling
 * are always enforced as false for staff (hard-coded protection).
 */
const updatePermissions = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { permissions } = req.body;
    const shopId = req.user.shopId;

    if (!permissions || typeof permissions !== 'object') {
      return errorResponse(res, 400, 'permissions object is required');
    }

    const staffMember = await User.findOne({ _id: id, shopId, role: 'staff' });
    if (!staffMember) return errorResponse(res, 404, 'Staff member not found');

    // Only these 3 flags are adjustable for staff
    const adjustable = ['canViewChats', 'canManageBookings', 'canViewCustomers'];
    for (const key of adjustable) {
      if (permissions[key] !== undefined) {
        staffMember.permissions[key] = Boolean(permissions[key]);
      }
    }

    // Hard enforce — staff can never have these
    staffMember.permissions.canManageRules = false;
    staffMember.permissions.canManageBilling = false;

    await staffMember.save();

    const responseUser = staffMember.toObject();
    delete responseUser.passwordHash;

    return successResponse(res, 200, responseUser, 'Permissions updated');
  } catch (error) {
    logger.error('Error in updatePermissions:', error);
    next(error);
  }
};

/**
 * DELETE /api/staff/:id
 * Permanently remove a staff member
 */
const removeStaff = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shopId = req.user.shopId;

    const staffMember = await User.findOne({ _id: id, shopId, role: 'staff' });
    if (!staffMember) return errorResponse(res, 404, 'Staff member not found');

    await User.findByIdAndDelete(id);

    logger.info(`Staff ${id} removed from shop ${shopId}`);
    return successResponse(res, 200, null, 'Staff member removed successfully');
  } catch (error) {
    logger.error('Error in removeStaff:', error);
    next(error);
  }
};

/**
 * POST /api/staff/:id/toggle
 * Activate or deactivate a staff member account
 */
const toggleStaff = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shopId = req.user.shopId;

    const staffMember = await User.findOne({ _id: id, shopId, role: 'staff' });
    if (!staffMember) return errorResponse(res, 404, 'Staff member not found');

    staffMember.isActive = !staffMember.isActive;
    await staffMember.save();

    const action = staffMember.isActive ? 'activated' : 'deactivated';
    logger.info(`Staff ${id} ${action} for shop ${shopId}`);

    const responseUser = staffMember.toObject();
    delete responseUser.passwordHash;

    return successResponse(res, 200, responseUser, `Staff member ${action}`);
  } catch (error) {
    logger.error('Error in toggleStaff:', error);
    next(error);
  }
};

module.exports = {
  getStaff,
  inviteStaff,
  updatePermissions,
  removeStaff,
  toggleStaff
};
