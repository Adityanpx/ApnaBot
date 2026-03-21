const { Server } = require('socket.io');
const config = require('../config/env');
const authService = require('./auth.service');
const logger = require('../utils/logger');

let io = null;

/**
 * Initialize Socket.io with the HTTP server
 * @param {http.Server} httpServer - The Node.js HTTP server instance
 */
const initialize = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: [config.FRONTEND_URL, config.ADMIN_URL],
      methods: ['GET', 'POST']
    }
  });

  // Socket.io authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      
      if (!token) {
        return next(new Error('Authentication required'));
      }

      // Verify the token
      const decoded = await authService.verifyAccessToken(token);
      
      if (!decoded) {
        return next(new Error('Invalid token'));
      }

      // Attach user info to socket
      socket.user = {
        userId: decoded.userId,
        shopId: decoded.shopId,
        role: decoded.role
      };

      next();
    } catch (error) {
      logger.error('Socket authentication error:', error);
      next(new Error('Authentication failed'));
    }
  });

  // Handle socket connections
  io.on('connection', (socket) => {
    const { userId, shopId, role } = socket.user;

    if (role === 'superadmin') {
      socket.join('admin');
      logger.info(`Super admin ${userId} connected to socket`);
    } else if (shopId) {
      socket.join(`shop:${shopId}`);
      logger.info(`Shop ${shopId} connected to socket`);
    }

    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: ${socket.id}`);
    });
  });

  logger.info('Socket.io initialized');
  return io;
};

/**
 * Emit an event to a specific shop's room
 * @param {string} shopId - The shop ID
 * @param {string} event - The event name
 * @param {any} data - The data to emit
 */
const emitToShop = (shopId, event, data) => {
  if (!io) {
    logger.warn('Socket.io not initialized, cannot emit to shop');
    return;
  }
  io.to(`shop:${shopId}`).emit(event, data);
};

/**
 * Emit an event to the admin room
 * @param {string} event - The event name
 * @param {any} data - The data to emit
 */
const emitToAdmin = (event, data) => {
  if (!io) {
    logger.warn('Socket.io not initialized, cannot emit to admin');
    return;
  }
  io.to('admin').emit(event, data);
};

/**
 * Get the Socket.io instance
 * @returns {Server|null} The Socket.io instance
 */
const getIO = () => {
  return io;
};

module.exports = {
  initialize,
  emitToShop,
  emitToAdmin,
  getIO
};
