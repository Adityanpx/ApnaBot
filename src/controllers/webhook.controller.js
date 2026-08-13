const crypto = require('crypto');
const config = require('../config/env');
const tenantService = require('../services/tenant.service');
const chatbotService = require('../services/chatbot.service');
const smartFallbackService = require('../services/smartFallback.service');
const usageService = require('../services/usage.service');
const bookingService = require('../services/booking.service');
const socketService = require('../services/socket.service');
const { addToWhatsappQueue, addToWhatsappQueueAndWait } = require('../queues/whatsapp.queue');
const Customer = require('../models/Customer');
const Message = require('../models/Message');
const Shop = require('../models/Shop');
const Rule = require('../models/Rule');
const logger = require('../utils/logger');

// Exact-match greeting keywords that trigger the welcome message / menu.
// Kept as exact matches (not substring) so real rule keywords still win.
const GREETING_KEYWORDS = new Set(['hi', 'hello', 'hey', 'hii', 'hlo', 'namaste', 'start', 'menu']);

// Exact-match escape keywords that let a customer bail out of an active
// booking session instead of being stuck until the session TTL expires.
// Only checked against plain text (see the buttonReplyId/listReplyId guard
// at the call site) so an interactive tap can never coincidentally match.
const ESCAPE_KEYWORDS = new Set(['menu', 'cancel', 'exit', 'restart', 'stop']);

/**
 * Build the numbered-menu list options for a shop's enabled menu, in the
 * {label, nextKeyword} shape sendRuleListMessage expects. Shared by the
 * Step 12.5 greeting handler and the "no rule matched" fallback.
 * @param {Array} menuItems - shop.menuItems
 * @returns {Promise<Array<{label: string, nextKeyword: string}>>}
 */
const buildMenuListOptions = async (menuItems) => {
  const sortedItems = [...menuItems]
    .sort((a, b) => a.order - b.order)
    .slice(0, 10);
  const ruleIds = sortedItems.map(item => item.ruleId);
  const rules = await Rule.find({ _id: { $in: ruleIds } }).select('keyword');
  const keywordByRuleId = new Map(rules.map(rule => [rule._id.toString(), rule.keyword]));

  return sortedItems
    .filter(item => keywordByRuleId.has(item.ruleId.toString()))
    .map(item => ({
      label: item.label,
      nextKeyword: keywordByRuleId.get(item.ruleId.toString())
    }));
};

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
  console.log('WEBHOOK POST received:', JSON.stringify(req.body, null, 2));
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

    if (!req.rawBody) {
      logger.warn('Missing rawBody for signature verification');
      return;
    }

    const expectedSignature = 'sha256=' + crypto
      .createHmac('sha256', config.META_APP_SECRET)
      .update(req.rawBody)
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
    // A tapped reply-button arrives as type 'interactive'. We stored the target
    // rule's keyword as the button id (see sendInteractiveButtons), so treat that
    // id as the incoming "text" and let the normal rule matcher chain the flow.
    const buttonReplyId = message.interactive?.button_reply?.id || null;
    // A tapped list-message row arrives as type 'interactive' too, with its
    // id in list_reply instead of button_reply (see sendListMessage).
    const listReplyId = message.interactive?.list_reply?.id || null;
    const messageText = message.text?.body || buttonReplyId || listReplyId || '';
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

    // Step 11 - Skip non-text messages, EXCEPT interactive button taps (which
    // carry a keyword in button_reply.id and must chain to the next rule).
    if (messageType !== 'text' && !buttonReplyId && !listReplyId) {
      logger.info('Non-text message received, skipping chatbot');
      return;
    }

    // Step 12 - Check active booking session
    const activeSession = await bookingService.getBookingSession(tenant.shopId, customerNumber);
    if (activeSession) {
      logger.info(`Active booking session for ${customerNumber}`);

      // Escape hatch: let the customer cancel out of the booking flow with a
      // plain-text keyword instead of being stuck answering booking questions
      // until the session TTL expires. Only plain text is checked — a tapped
      // button/list reply id (e.g. an index like "2") could coincidentally
      // match one of these words, so interactive taps skip this entirely.
      const isPlainTextMessage = !buttonReplyId && !listReplyId;
      const normalizedEscapeText = isPlainTextMessage ? (message.text?.body || '').trim().toLowerCase() : '';
      if (ESCAPE_KEYWORDS.has(normalizedEscapeText)) {
        await bookingService.deleteBookingSession(tenant.shopId, customerNumber);

        const escapeShopDoc = await Shop.findById(tenant.shopId)
          .select('welcomeMessage isMenuEnabled menuItems')
          .lean();
        const escapeHasMenu = !!(escapeShopDoc?.isMenuEnabled && escapeShopDoc.menuItems?.length > 0);

        // Cancellation confirmation message
        const cancelText = escapeHasMenu
          ? 'Booking cancelled.'
          : "Booking cancelled. Type 'hi' to see what I can help with.";
        const cancelMsg = await Message.create({
          shopId: tenant.shopId,
          customerId: customer._id,
          customerNumber,
          direction: 'outbound',
          type: 'text',
          content: cancelText,
          status: 'sent',
          isRead: true
        });
        await addToWhatsappQueue({
          shopId: tenant.shopId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: cancelText,
          type: 'text',
          messageId: cancelMsg._id
        });
        usageService.incrementUsage(tenant.shopId, 'outbound').catch(err =>
          logger.error('Error incrementing outbound usage:', err)
        );
        try {
          socketService.emitToShop(tenant.shopId.toString(), 'new_message', {
            customer,
            message: cancelMsg,
            customerNumber
          });
        } catch (socketError) {
          logger.error('Error emitting socket event:', socketError);
        }

        // If the shop has a menu, follow up with the same welcome/menu send
        // Step 12.5 does for a greeting.
        if (escapeHasMenu) {
          const menuListOptions = await buildMenuListOptions(escapeShopDoc.menuItems);
          const menuReplyText = escapeShopDoc.welcomeMessage || 'How can we help you today?';

          const menuOutboundMsg = await Message.create({
            shopId: tenant.shopId,
            customerId: customer._id,
            customerNumber,
            direction: 'outbound',
            type: 'text',
            content: menuReplyText,
            status: 'sent',
            isRead: true
          });
          await addToWhatsappQueue({
            shopId: tenant.shopId,
            phoneNumberId: tenant.phoneNumberId,
            encryptedAccessToken: tenant.accessToken,
            to: customerNumber,
            message: menuReplyText,
            type: 'text',
            listOptions: menuListOptions,
            listButtonLabel: 'Menu',
            messageId: menuOutboundMsg._id
          });
          usageService.incrementUsage(tenant.shopId, 'outbound').catch(err =>
            logger.error('Error incrementing outbound usage:', err)
          );
          try {
            socketService.emitToShop(tenant.shopId.toString(), 'new_message', {
              customer,
              message: menuOutboundMsg,
              customerNumber
            });
          } catch (socketError) {
            logger.error('Error emitting socket event:', socketError);
          }
        }

        logger.info(`Booking session cancelled via escape keyword for ${customerNumber}`);
        return; // Do not process booking step, greeting, or rule matching
      }

      // If the customer tapped a button/list row for the current choice
      // field, resolve its id (a stringified option index — see
      // sendInteractiveButtons/sendListMessage mapping in the worker) back
      // to the option's text before handing off. Plain text answers pass
      // through untouched.
      let resolvedReply = messageText;
      const currentField = activeSession.fields[activeSession.step];
      const replyId = listReplyId !== null ? listReplyId : buttonReplyId;
      if (currentField && currentField.fieldType === 'vehicle_carousel' && buttonReplyId && buttonReplyId.startsWith('vehicle_')) {
        // Tapped "Book this" on a vehicle carousel message — id is
        // 'vehicle_<index>'; pass the bare index straight through.
        resolvedReply = buttonReplyId.slice('vehicle_'.length);
      } else if (currentField && (currentField.fieldType === 'buttons' || currentField.fieldType === 'list') && replyId !== null) {
        const options = currentField.options || [];
        const idx = parseInt(replyId, 10);
        if (!Number.isNaN(idx) && options[idx] !== undefined) {
          resolvedReply = options[idx];
        }
      }

      // Process booking step
      const stepResult = await bookingService.processBookingStep(
        tenant.shopId,
        customerNumber,
        resolvedReply,
        tenant
      );

      if (stepResult === null) {
        // Session expired - fall through to rule matching below
        logger.info(`Booking session expired for ${customerNumber}`);
      } else {
        // stepResult is either the next field object (choice/text question),
        // a plain string (re-prompt on bad input, or final confirmation), or
        // — specifically — the stale-vehicle re-prompt string, which needs a
        // freshly-rebuilt carousel resent alongside it.
        const nextField = typeof stepResult === 'object' ? stepResult : null;

        let carouselOptions = null;
        if (nextField && nextField.fieldType === 'vehicle_carousel') {
          carouselOptions = nextField.options || [];
        } else if (typeof stepResult === 'string' && stepResult.startsWith('Sorry, that vehicle is no longer available')) {
          const refreshedSession = await bookingService.getBookingSession(tenant.shopId, customerNumber);
          const refreshedField = refreshedSession?.fields[refreshedSession.step];
          if (refreshedField && refreshedField.fieldType === 'vehicle_carousel') {
            carouselOptions = refreshedField.options || [];
          }
        }

        if (carouselOptions) {
          try {
            // Intro message (question text or the stale-vehicle re-prompt)
            const introText = nextField ? nextField.label : stepResult;
            const introMsgShape = {
              shopId: tenant.shopId,
              customerId: customer._id,
              customerNumber,
              direction: 'outbound',
              type: 'text',
              content: introText,
              status: 'sent',
              triggeredRuleId: activeSession.ruleId,
              isRead: true
            };
            let introMsg;
            try {
              introMsg = await Message.create(introMsgShape);
            } catch (createError) {
              logger.error('Error creating carousel intro message record:', { message: createError.message, stack: createError.stack });
              introMsg = introMsgShape;
            }

            // Awaited-to-completion (not just enqueued) so this intro message
            // is guaranteed to land at WhatsApp before the vehicle messages
            // below, even though the worker processes jobs with concurrency: 5.
            try {
              await addToWhatsappQueueAndWait({
                shopId: tenant.shopId,
                phoneNumberId: tenant.phoneNumberId,
                encryptedAccessToken: tenant.accessToken,
                to: customerNumber,
                message: introText,
                type: 'text',
                messageId: introMsg._id
              });
            } catch (sendError) {
              logger.error('Error sending carousel intro message:', sendError);
            }

            usageService.incrementUsage(tenant.shopId, 'outbound').catch(err =>
              logger.error('Error incrementing outbound usage:', err)
            );

            try {
              socketService.emitToShop(tenant.shopId.toString(), 'new_message', {
                customer,
                message: introMsg,
                customerNumber
              });
            } catch (socketError) {
              logger.error('Error emitting socket event:', socketError);
            }

            // One message per vehicle option: image + caption + "Book this" button
            logger.info('Sending vehicle carousel', { customerNumber, optionCount: carouselOptions.length });
            for (const option of carouselOptions) {
              const captionParts = [option.name];
              if (option.seats) captionParts.push(`${option.seats} seats`);
              captionParts.push(`₹${option.fare}`);
              const caption = captionParts.join(' • ');

              const vehicleMsgShape = {
                shopId: tenant.shopId,
                customerId: customer._id,
                customerNumber,
                direction: 'outbound',
                type: 'text',
                content: caption,
                status: 'sent',
                triggeredRuleId: activeSession.ruleId,
                isRead: true
              };
              let vehicleMsg;
              try {
                vehicleMsg = await Message.create(vehicleMsgShape);
              } catch (createError) {
                logger.error(`Error creating carousel vehicle message record for option index ${option.index}:`, { message: createError.message, stack: createError.stack });
                vehicleMsg = vehicleMsgShape;
              }

              // Awaited-to-completion so vehicle messages send in the same
              // order they're constructed, regardless of worker concurrency.
              try {
                await addToWhatsappQueueAndWait({
                  shopId: tenant.shopId,
                  phoneNumberId: tenant.phoneNumberId,
                  encryptedAccessToken: tenant.accessToken,
                  to: customerNumber,
                  message: caption,
                  type: 'text',
                  imageUrl: option.photoUrl || null,
                  buttons: [{ title: 'Book this', nextKeyword: `vehicle_${option.index}` }],
                  messageId: vehicleMsg._id
                });
              } catch (sendError) {
                logger.error('Error sending carousel vehicle message:', sendError);
              }

              usageService.incrementUsage(tenant.shopId, 'outbound').catch(err =>
                logger.error('Error incrementing outbound usage:', err)
              );

              try {
                socketService.emitToShop(tenant.shopId.toString(), 'new_message', {
                  customer,
                  message: vehicleMsg,
                  customerNumber
                });
              } catch (socketError) {
                logger.error('Error emitting socket event:', socketError);
              }
            }

            // Escape hatch: let the customer opt out of the carousel if their
            // preferred vehicle isn't listed.
            const otherOptionsText = "Don't see the vehicle you want?";
            const otherOptionsMsgShape = {
              shopId: tenant.shopId,
              customerId: customer._id,
              customerNumber,
              direction: 'outbound',
              type: 'text',
              content: otherOptionsText,
              status: 'sent',
              triggeredRuleId: activeSession.ruleId,
              isRead: true
            };
            let otherOptionsMsg;
            try {
              otherOptionsMsg = await Message.create(otherOptionsMsgShape);
            } catch (createError) {
              logger.error('Error creating carousel other-options message record:', { message: createError.message, stack: createError.stack });
              otherOptionsMsg = otherOptionsMsgShape;
            }

            // Awaited-to-completion so this message lands after the last
            // vehicle message, preserving the constructed order.
            try {
              await addToWhatsappQueueAndWait({
                shopId: tenant.shopId,
                phoneNumberId: tenant.phoneNumberId,
                encryptedAccessToken: tenant.accessToken,
                to: customerNumber,
                message: otherOptionsText,
                type: 'text',
                buttons: [{ title: 'Other options', nextKeyword: 'vehicle_other' }],
                messageId: otherOptionsMsg._id
              });
            } catch (sendError) {
              logger.error('Error sending carousel "other options" message:', sendError);
            }

            usageService.incrementUsage(tenant.shopId, 'outbound').catch(err =>
              logger.error('Error incrementing outbound usage:', err)
            );

            try {
              socketService.emitToShop(tenant.shopId.toString(), 'new_message', {
                customer,
                message: otherOptionsMsg,
                customerNumber
              });
            } catch (socketError) {
              logger.error('Error emitting socket event:', socketError);
            }
          } catch (error) {
            logger.error('Error in vehicle carousel send block:', { message: error.message, stack: error.stack });
          }

          return; // Do not run rule matching
        }

        const replyText = nextField ? nextField.label : stepResult;

        // Save outbound message to DB
        const outboundMsg = await Message.create({
          shopId: tenant.shopId,
          customerId: customer._id,
          customerNumber,
          direction: 'outbound',
          type: 'text',
          content: replyText,
          status: 'sent',
          triggeredRuleId: activeSession.ruleId,
          isRead: true
        });

        // Queue outbound message via addToWhatsappQueue
        const outboundJobData = {
          shopId: tenant.shopId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: replyText,
          type: 'text',
          messageId: outboundMsg._id
        };
        if (nextField && nextField.fieldType === 'buttons') {
          outboundJobData.interactiveButtons = nextField.options || [];
        } else if (nextField && nextField.fieldType === 'list') {
          outboundJobData.interactiveList = nextField.options || [];
          outboundJobData.listButtonLabel = 'Choose';
        }
        await addToWhatsappQueue(outboundJobData);

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

    // Step 12.5 - Greeting -> welcome message / menu (exact match only, so
    // real rule keywords still take priority over this).
    const normalizedText = (messageText || '').trim().toLowerCase();
    if (GREETING_KEYWORDS.has(normalizedText)) {
      const shopDoc = await Shop.findById(tenant.shopId)
        .select('welcomeMessage isMenuEnabled menuItems')
        .lean();

      const hasMenu = !!(shopDoc?.isMenuEnabled && shopDoc.menuItems?.length > 0);

      if (shopDoc && (shopDoc.welcomeMessage || hasMenu)) {
        let greetingReplyText = shopDoc.welcomeMessage || '';
        let menuListOptions = [];

        if (hasMenu) {
          menuListOptions = await buildMenuListOptions(shopDoc.menuItems);

          if (!greetingReplyText) {
            greetingReplyText = 'How can we help you today?';
          }
        }

        // Save outbound message
        const greetingOutboundMsg = await Message.create({
          shopId: tenant.shopId,
          customerId: customer._id,
          customerNumber,
          direction: 'outbound',
          type: 'text',
          content: greetingReplyText,
          status: 'sent',
          isRead: true
        });

        // Queue outbound message the same way Step 16 does
        const greetingJobData = {
          shopId: tenant.shopId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: greetingReplyText,
          type: 'text',
          listOptions: menuListOptions,
          listButtonLabel: 'Menu',
          messageId: greetingOutboundMsg._id
        };
        await addToWhatsappQueue(greetingJobData);

        // Increment outbound usage (fire and forget)
        usageService.incrementUsage(tenant.shopId, 'outbound').catch(err =>
          logger.error('Error incrementing outbound usage:', err)
        );

        // Emit socket event
        try {
          socketService.emitToShop(tenant.shopId.toString(), 'new_message', {
            customer,
            message: greetingOutboundMsg,
            customerNumber
          });
        } catch (socketError) {
          logger.error('Error emitting new_message socket event for greeting:', socketError);
        }

        logger.info(`Sent welcome message for shop ${tenant.shopId}, customer ${customerNumber}`);
        return; // Do not run rule matching or fallback
      }
    }

    // Step 13 - Run rule matching
    const matchedRule = await chatbotService.findMatchingRule(tenant.shopId, messageText);

    // Step 14 — Prepare reply based on rule type
    let replyText = null;
    let triggeredRuleId = null;
    let bookingField = null; // set when booking_trigger fires, for interactive rendering below
    let fallbackMenuListOptions = null; // set when no rule matched and shop has an enabled menu

    if (matchedRule) {
      triggeredRuleId = matchedRule._id;

      if (matchedRule.replyType === 'text') {
        // Simple text reply (may also carry an image and/or buttons).
        replyText = matchedRule.reply;

      } else if (matchedRule.replyType === 'booking_trigger') {
        // Start booking flow — ask first question
        const firstField = await bookingService.startBookingSession(
          tenant.shopId,
          customerNumber,
          matchedRule._id
        );
        bookingField = firstField;
        replyText = firstField.label;

      } else if (matchedRule.replyType === 'payment_trigger') {
        replyText = matchedRule.reply || 'Please complete your payment.';
      }
    } else {
      // No rule matched — try an AI-generated fallback (opt-in per shop),
      // falling back to the static reply on any failure or timeout.
      let smartReply = null;
      if (tenant.enableSmartFallback) {
        try {
          smartReply = await Promise.race([
            smartFallbackService.getSmartFallbackReply(tenant.shopId, messageText),
            new Promise((resolve) => setTimeout(() => resolve(null), 4000))
          ]);
        } catch (smartFallbackError) {
          logger.error('Error generating smart fallback reply:', smartFallbackError);
          smartReply = null;
        }
      }

      replyText = smartReply || tenant.fallbackReply || 'Thank you for your message. We will get back to you soon.';

      // Attach the numbered menu (if the shop has one enabled) regardless of
      // whether replyText above came from the AI smart fallback or the
      // static fallbackReply — gives the customer a way to reach a real
      // rule instead of a dead-end message.
      const fallbackShopDoc = await Shop.findById(tenant.shopId)
        .select('isMenuEnabled menuItems')
        .lean();
      const fallbackHasMenu = !!(fallbackShopDoc?.isMenuEnabled && fallbackShopDoc.menuItems?.length > 0);

      if (fallbackHasMenu) {
        fallbackMenuListOptions = await buildMenuListOptions(fallbackShopDoc.menuItems);
      }
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
    const outboundJobData = {
      shopId: tenant.shopId,
      phoneNumberId: tenant.phoneNumberId,
      encryptedAccessToken: tenant.accessToken,
      to: customerNumber,
      message: replyText,
      type: 'text',
      imageUrl: matchedRule?.replyImageUrl || null,
      buttons: matchedRule?.buttons || [],
      listOptions: fallbackMenuListOptions || matchedRule?.listOptions || [],
      messageId: outboundMsg._id
    };
    if (fallbackMenuListOptions) {
      outboundJobData.listButtonLabel = 'Menu';
    }
    if (bookingField && bookingField.fieldType === 'buttons') {
      outboundJobData.interactiveButtons = bookingField.options || [];
    } else if (bookingField && bookingField.fieldType === 'list') {
      outboundJobData.interactiveList = bookingField.options || [];
      outboundJobData.listButtonLabel = 'Choose';
    }
    await addToWhatsappQueue(outboundJobData);

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
