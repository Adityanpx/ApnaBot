const crypto = require('crypto');
const config = require('../config/env');
const tenantService = require('../services/tenant.service');
const chatbotService = require('../services/chatbot.service');
const usageService = require('../services/usage.service');
const bookingService = require('../services/booking.service');
const socketService = require('../services/socket.service');
const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
const Customer = require('../models/Customer');
const Message = require('../models/Message');
const logger = require('../utils/logger');
const redis = require('../config/redis');

/**
 * GET /api/webhook/verify
 * Meta webhook verification
 */
const verifyWebhook = async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.WEBHOOK_VERIFY_TOKEN) {
    logger.info('Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  return res.status(403).send('Forbidden');
};

/**
 * POST /api/webhook/receive
 * Main webhook handler for WhatsApp events
 */
const receiveWebhook = async (req, res) => {
  // Step 1 - Return 200 immediately
  res.status(200).json({ status: 'ok' });

  // Everything below runs async
  try {
    // Step 2 - Verify Meta signature
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      logger.warn('Missing webhook signature');
      return;
    }

    const expectedSignature = 'sha256=' + crypto
      .createHmac('sha256', config.META_APP_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (signature !== expectedSignature) {
      logger.warn('Invalid webhook signature');
      return;
    }

    // Step 3 - Parse payload
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Handle status updates
    const statuses = value?.statuses;
    if (statuses) {
      for (const status of statuses) {
        const updatedMsg = await Message.findOneAndUpdate(
          { metaMessageId: status.id },
          { status: status.status },
          { new: true }
        );
        if (updatedMsg) {
          try {
            socketService.emitToShop(updatedMsg.shopId.toString(), 'message_status', {
              messageId: updatedMsg._id,
              metaMessageId: status.id,
              status: status.status
            });
          } catch (socketErr) {
            logger.error('Error emitting message_status socket event:', socketErr);
          }
        }
      }
      return;
    }

    // Check for messages
    const messages = value?.messages;
    if (!messages) {
      return;
    }

    const message = messages[0];
    const metaMessageId = message.id;
    const customerNumber = message.from;
    const messageType = message.type;
    const messageText = message.text?.body || '';
    const phoneNumberId = value.metadata.phone_number_id;

    // Step 4 - Resolve tenant
    const tenant = await tenantService.resolveShopByPhoneNumberId(phoneNumberId);
    if (!tenant) {
      logger.warn(`No shop found for phoneNumberId: ${phoneNumberId}`);
      return;
    }

    // Step 5 - Check shop active
    if (!tenant.isActive) {
      logger.warn(`Shop ${tenant.shopId} is inactive`);
      return;
    }

    // Step 6 - Check subscription
    if (!tenant.subscription || tenant.subscription.status !== 'active') {
      logger.warn(`Shop ${tenant.shopId} has no active subscription`);
      return;
    }

    // Step 7 - Check usage limit
    const msgLimit = tenant.plan?.msgLimit || 500;
    const usageCheck = await usageService.checkUsageLimit(tenant.shopId, msgLimit);
    if (!usageCheck.allowed) {
      logger.warn(`Usage limit reached for shop ${tenant.shopId}`);
      return;
    }

    // Step 8 - Upsert customer
    const customer = await Customer.findOneAndUpdate(
      { shopId: tenant.shopId, whatsappNumber: customerNumber },
      {
        $setOnInsert: { firstSeenAt: new Date() },
        $set: { lastMessageAt: new Date() },
        $inc: { totalMessages: 1 }
      },
      { upsert: true, new: true }
    );

    if (customer.isBlocked) {
      logger.warn(`Blocked customer ${customerNumber}`);
      return;
    }

    // Step 9 - Save inbound message
    const inboundMsg = await Message.create({
      shopId: tenant.shopId,
      customerId: customer._id,
      customerNumber,
      direction: 'inbound',
      type: messageType,
      content: messageText,
      metaMessageId,
      status: 'delivered',
      isRead: false
    });

    // Step 10 - Increment usage (fire and forget)
    usageService.incrementUsage(tenant.shopId, 'inbound');

    // ADD THIS — Emit usage_update to Flutter dashboard
    usageService.checkUsageLimit(tenant.shopId, tenant.plan?.msgLimit || 500)
      .then(usageCheck => {
        socketService.emitToShop(tenant.shopId.toString(), 'usage_update', {
          msgCount: usageCheck.current,
          limit: usageCheck.limit
        });
      })
      .catch(err => logger.error('Error emitting usage_update:', err));

    // Step 11 - Skip non-text messages
    if (messageType !== 'text') {
      logger.info('Non-text message received, skipping chatbot');
      return;
    }

    // Step 12 - Check active booking session
    const sessionKey = `booking_session:${tenant.shopId}:${customerNumber}`;
    const session = await redis.get(sessionKey);
    if (session) {
      logger.info(`Active booking session for ${customerNumber}`);
      // Process booking step
      const replyText = await bookingService.processBookingStep(
        tenant.shopId,
        customerNumber,
        messageText,
        tenant
      );

      if (replyText === null) {
        // Session expired - fall through to rule matching below
        logger.info(`Booking session expired for ${customerNumber}`);
      } else {
        // Save outbound message to DB
        const outboundMsg = await Message.create({
          shopId: tenant.shopId,
          customerId: customer._id,
          customerNumber,
          direction: 'outbound',
          type: 'text',
          content: replyText,
          status: 'sent',
          triggeredRuleId: session.ruleId,
          isRead: true
        });

        // Queue outbound message via addToWhatsappQueue
        await addToWhatsappQueue({
          shopId: tenant.shopId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: replyText,
          type: 'text',
          messageId: outboundMsg._id
        });

        // Increment outbound usage (fire and forget)
        usageService.incrementUsage(tenant.shopId, 'outbound').catch(err =>
          logger.error('Error incrementing outbound usage:', err)
        );

        // Emit socket event
        try {
          socketService.emitToShop(tenant.shopId.toString(), 'new_message', {
            customer,
            message: outboundMsg,
            customerNumber
          });
        } catch (socketError) {
          logger.error('Error emitting socket event:', socketError);
        }

        return; // Do not run rule matching
      }
    }

    // Step 13 - Run rule matching
    const matchedRule = await chatbotService.findMatchingRule(tenant.shopId, messageText);

    // Step 14 — Prepare reply based on rule type
    let replyText = null;
    let triggeredRuleId = null;

    if (matchedRule) {
      triggeredRuleId = matchedRule._id;

      if (matchedRule.replyType === 'text') {
        // Simple text reply
        replyText = matchedRule.reply;

      } else if (matchedRule.replyType === 'booking_trigger') {
        // Start booking flow — ask first question
        const firstQuestion = await bookingService.startBookingSession(
          tenant.shopId,
          customerNumber,
          matchedRule._id
        );
        replyText = firstQuestion;

      } else if (matchedRule.replyType === 'payment_trigger') {
        // Generate UPI deep link and send it
        try {
          const Shop = require('../models/Shop');
          const shop = await Shop.findById(tenant.shopId).select('upiId name');

          if (shop && shop.upiId) {
            // Build UPI deep link
            const upiParams = new URLSearchParams({
              pa: shop.upiId,
              pn: shop.name || 'Shop',
              tn: 'Payment'
            });
            const upiLink = `upi://pay?${upiParams.toString()}`;

            replyText = matchedRule.reply
              ? `${matchedRule.reply}\n\nPay here: ${upiLink}`
              : `Please complete your payment:\n\n${upiLink}`;

            // Increment payment link usage
            usageService.incrementUsage(tenant.shopId, 'paymentLink').catch(err =>
              logger.error('Error incrementing paymentLink usage:', err)
            );
          } else {
            // Shop has no UPI ID configured — fall back to reply text
            replyText = matchedRule.reply || 'Please contact us to arrange payment.';
            logger.warn(`Shop ${tenant.shopId} has payment_trigger rule but no upiId configured`);
          }
        } catch (paymentErr) {
          logger.error('Error generating payment trigger UPI link:', paymentErr);
          replyText = matchedRule.reply || 'Please contact us to arrange payment.';
        }
      }
    } else {
      // No rule matched — send fallback reply
      replyText = tenant.fallbackReply || 'Thank you for your message. We will get back to you soon.';
    }

    // Step 15 - Save outbound message
    const outboundMsg = await Message.create({
      shopId: tenant.shopId,
      customerId: customer._id,
      customerNumber,
      direction: 'outbound',
      type: 'text',
      content: replyText,
      status: 'sent',
      triggeredRuleId,
      isRead: true
    });

    // Step 16 - Queue outbound message
    await addToWhatsappQueue({
      shopId: tenant.shopId,
      phoneNumberId: tenant.phoneNumberId,
      encryptedAccessToken: tenant.accessToken,
      to: customerNumber,
      message: replyText,
      type: 'text',
      messageId: outboundMsg._id
    });

    // ADD THIS — Emit new_message to Flutter app with full customer object
    try {
      socketService.emitToShop(tenant.shopId.toString(), 'new_message', {
        customer,
        message: outboundMsg,
        customerNumber
      });
    } catch (socketError) {
      logger.error('Error emitting new_message socket event:', socketError);
    }

    // Step 17 - Increment outbound usage (fire and forget)
    usageService.incrementUsage(tenant.shopId, 'outbound');

    logger.info(`Processed webhook for shop ${tenant.shopId}, customer ${customerNumber}`);

  } catch (error) {
    logger.error('Error processing webhook:', error);
    // Already sent 200, so we just log the error
  }
};

module.exports = {
  verifyWebhook,
  receiveWebhook
};
