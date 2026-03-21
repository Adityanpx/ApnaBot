const jwt = require('jsonwebtoken');
const config = require('../config/env');
const redis = require('../config/redis');

const generateAccessToken = (payload) => {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRY
  });
};

const generateRefreshToken = (userId) => {
  return jwt.sign({ userId }, config.JWT_REFRESH_SECRET, {
    expiresIn: config.JWT_REFRESH_EXPIRY
  });
};

const saveRefreshToken = async (userId, token) => {
  const key = `refresh:${userId}`;
  await redis.set(key, token, 'EX', 2592000); // 30 days
};

const getRefreshToken = async (userId) => {
  const key = `refresh:${userId}`;
  return await redis.get(key);
};

const deleteRefreshToken = async (userId) => {
  const key = `refresh:${userId}`;
  await redis.del(key);
};

const verifyAccessToken = (token) => {
  return jwt.verify(token, config.JWT_SECRET);
};

const verifyRefreshToken = (token) => {
  return jwt.verify(token, config.JWT_REFRESH_SECRET);
};

/**
 * Generate both access and refresh tokens in one call
 * Called by shop.controller.js after shop creation
 */
const generateTokens = (payload) => {
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload.userId);
  return { accessToken, refreshToken };
};

/**
 * Save refresh token to Redis — wrapper used by shop.controller.js
 */
const saveTokenToRedis = async (userId, token) => {
  await saveRefreshToken(userId, token);
};

const buildPermissions = (role) => {
  if (role === 'superadmin') {
    return {
      canViewChats: true,
      canManageRules: true,
      canManageBookings: true,
      canViewCustomers: true,
      canManageBilling: true
    };
  }
  
  if (role === 'owner') {
    return {
      canViewChats: true,
      canManageRules: true,
      canManageBookings: true,
      canViewCustomers: true,
      canManageBilling: true
    };
  }
  
  if (role === 'staff') {
    return {
      canViewChats: true,
      canManageRules: false,
      canManageBookings: true,
      canViewCustomers: true,
      canManageBilling: false
    };
  }
  
  return {};
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateTokens,
  saveTokenToRedis,
  saveRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  buildPermissions
};
