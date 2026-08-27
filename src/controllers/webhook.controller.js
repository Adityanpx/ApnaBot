const crypto = require('crypto');
const config = require('../config/env');
const tenantService = require('../services/tenant.service');
const chatbotService = require('../services/chatbot.service');
const smartFallbackService = require('../services/smartFallback.service');
const usageService = require('../services/usage.service');
const bookingService = require('../services/booking.service');
const socketService = require('../services/socket.service');
const { addToWhatsappQueue, addToWhatsappQueueAndWait } = require('../queues/whatsapp.queue');
const businessService = require('../services/business.service');
const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const { applyMessageTemplate } = require('../utils/messageTemplating');
const { LANGUAGE_CATALOG, isValidLanguageCode } = require('../utils/languageCatalog');
const { getLocalizedText } = require('../utils/localization');
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
 * Insert a message row. Throws on failure — used at call sites that were
 * never wrapped in try/catch pre-migration, so an insert failure still
 * propagates to the outer handler's catch (logged, already-sent-200).
 * @param {Object} fields - snake_case row fields
 * @returns {Promise<Object>} camelCase row
 */
const saveMessage = async (fields) => {
  const { data, error } = await supabase.from('messages').insert(fields).select().single();
  if (error) throw error;
  return toCamelCase(data);
};

/**
 * Insert a message row, swallowing failure — used at the carousel call sites
 * that were already wrapped in try/catch pre-migration, falling back to the
 * input fields (camelCased) so downstream reads still work; `.id` will be
 * undefined, same as the old fallback having no `_id`.
 * @param {Object} fields - snake_case row fields
 * @param {string} context - label for the log line
 * @returns {Promise<Object>} camelCase row (persisted) or camelCased fields (fallback)
 */
const createMessageSoft = async (fields, context) => {
  const { data, error } = await supabase.from('messages').insert(fields).select().single();
  if (error) {
    logger.error(`Error creating ${context} message record:`, { message: error.message, stack: error.stack });
    return toCamelCase(fields);
  }
  return toCamelCase(data);
};

/**
 * Find-or-create the customer row for an inbound message, then bump their
 * lastMessageAt/totalMessages. Supabase has no atomic upsert-with-$inc, so
 * this is a read-then-write — a tiny race window under true concurrent
 * double-taps from the same customer, acceptable at current traffic.
 * @param {string} businessId
 * @param {string} customerNumber
 * @param {string} [profileName] - WhatsApp profile name from the webhook's contacts array
 * @returns {Promise<Object>} camelCase customer row
 */
const upsertCustomerForInboundMessage = async (businessId, customerNumber, profileName) => {
  const { data: existing, error: findErr } = await supabase
    .from('customers').select('*')
    .eq('business_id', businessId).eq('whatsapp_number', customerNumber).maybeSingle();
  if (findErr) throw findErr;

  const nowIso = new Date().toISOString();

  if (existing) {
    const updateFields = {
      last_message_at: nowIso,
      total_messages: (existing.total_messages || 0) + 1
    };
    // Only backfill the name from WhatsApp if we don't already have one —
    // a business owner's manual edit must win over a self-reported profile
    // name that the customer can change at any time.
    if (!existing.name && profileName) {
      updateFields.name = profileName;
    }
    const { data, error } = await supabase.from('customers').update(updateFields).eq('id', existing.id).select().single();
    if (error) throw error;
    return toCamelCase(data);
  }

  const { data, error } = await supabase.from('customers').insert({
    business_id: businessId,
    whatsapp_number: customerNumber,
    name: profileName || null,
    first_seen_at: nowIso,
    last_message_at: nowIso,
    total_messages: 1
  }).select().single();
  if (error) throw error;
  return toCamelCase(data);
};

/**
 * Build the numbered-menu list options for a business's enabled menu, in the
 * {label, nextKeyword} shape sendRuleListMessage expects. Shared by the
 * Step 12.5 greeting handler and the "no rule matched" fallback.
 * @param {Array} menuItems - business.menuItems
 * @param {string} [languageCode] - customer.preferredLanguage
 * @returns {Promise<Array<{label: string, nextKeyword: string}>>}
 */
const buildMenuListOptions = async (menuItems, languageCode) => {
  const sortedItems = [...menuItems]
    .sort((a, b) => a.order - b.order)
    .slice(0, 10);
  const ruleIds = sortedItems.map(item => item.ruleId);
  const { data: rules, error } = await supabase.from('rules').select('id, keyword').in('id', ruleIds);
  if (error) throw error;
  const keywordByRuleId = new Map((rules || []).map(rule => [rule.id.toString(), rule.keyword]));

  return sortedItems
    .filter(item => keywordByRuleId.has(item.ruleId.toString()))
    .map(item => ({
      label: getLocalizedText(item, 'label', languageCode),
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
        const { data: updatedMsg, error } = await supabase
          .from('messages')
          .update({ status: status.status })
          .eq('meta_message_id', status.id)
          .select()
          .maybeSingle();
        if (error) {
          logger.error('Error updating message status:', error);
          continue;
        }
        if (updatedMsg) {
          try {
            socketService.emitToBusiness(updatedMsg.business_id, 'message_status', {
              messageId: updatedMsg.id,
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

    // Handle message template status updates (Meta approves/rejects/pauses a
    // template submitted via messageTemplate.controller.js's submit flow) so
    // message_templates.status doesn't stay stuck on 'pending' forever.
    if (changes?.field === 'message_template_status_update') {
      const templateEvent = value?.event; // Meta's casing: 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED'
      const metaTemplateId = value?.message_template_id;
      const templateName = value?.message_template_name;
      const rejectionReason = value?.reason; // present on rejections

      // message_templates.status has a check constraint of
      // ('draft','pending','approved','rejected') - PAUSED/DISABLED have no
      // matching value, so they're logged and skipped rather than written.
      const TEMPLATE_EVENT_TO_STATUS = { APPROVED: 'approved', REJECTED: 'rejected' };
      const mappedStatus = TEMPLATE_EVENT_TO_STATUS[templateEvent];

      if (!mappedStatus) {
        logger.warn(`Unhandled message_template_status_update event "${templateEvent}" - no matching message_templates.status value, skipping`, {
          metaTemplateId,
          templateName
        });
        return;
      }

      const updateFields = {
        status: mappedStatus,
        reviewed_at: new Date().toISOString(),
        rejection_reason: mappedStatus === 'rejected' ? (rejectionReason || null) : null
      };

      let updatedTemplate = null;
      if (metaTemplateId) {
        const { data, error } = await supabase
          .from('message_templates')
          .update(updateFields)
          .eq('meta_template_id', metaTemplateId)
          .select()
          .maybeSingle();
        if (error) {
          logger.error('Error updating message_templates by meta_template_id:', error);
          return;
        }
        updatedTemplate = data;
      }

      // Legacy fallback: submitMessageTemplate always sets meta_template_id
      // together with status 'pending', so this only matters for a row that
      // predates that flow or otherwise never got meta_template_id persisted.
      if (!updatedTemplate && templateName) {
        const { data, error } = await supabase
          .from('message_templates')
          .update(updateFields)
          .eq('name', templateName)
          .is('meta_template_id', null)
          .select()
          .maybeSingle();
        if (error) {
          logger.error('Error updating message_templates by name fallback:', error);
          return;
        }
        updatedTemplate = data;
      }

      if (!updatedTemplate) {
        logger.warn('No message_templates row found for template status update', {
          metaTemplateId,
          templateName,
          templateEvent
        });
        return;
      }

      try {
        socketService.emitToBusiness(updatedTemplate.business_id, 'template_status_update', {
          templateId: updatedTemplate.id,
          metaTemplateId: updatedTemplate.meta_template_id,
          name: updatedTemplate.name,
          status: updatedTemplate.status,
          rejectionReason: updatedTemplate.rejection_reason
        });
      } catch (socketErr) {
        logger.error('Error emitting template_status_update socket event:', socketErr);
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
    let messageText = message.text?.body || buttonReplyId || listReplyId || '';
    const phoneNumberId = value.metadata.phone_number_id;
    // Meta includes the sender's current WhatsApp display name alongside each
    // inbound message via the contacts array — capture it for first contact.
    const profileName = value.contacts?.[0]?.profile?.name || null;

    // Step 4 - Resolve tenant
    const tenant = await tenantService.resolveBusinessByPhoneNumberId(phoneNumberId);
    if (!tenant) {
      logger.warn(`No business found for phoneNumberId: ${phoneNumberId}`);
      return;
    }

    // Step 5 - Check business active
    if (!tenant.isActive) {
      logger.warn(`Business ${tenant.businessId} is inactive`);
      return;
    }

    // Step 6 - Check subscription
    if (!tenant.subscription || tenant.subscription.status !== 'active') {
      logger.warn(`Business ${tenant.businessId} has no active subscription`);
      return;
    }

    // Step 7 - Check usage limit
    const msgLimit = tenant.plan?.msg_limit || 500;
    const usageCheck = await usageService.checkUsageLimit(tenant.businessId, msgLimit);
    if (!usageCheck.allowed) {
      logger.warn(`Usage limit reached for business ${tenant.businessId}`);
      return;
    }

    // Step 8 - Upsert customer
    const customer = await upsertCustomerForInboundMessage(tenant.businessId, customerNumber, profileName);

    if (customer.isBlocked) {
      logger.warn(`Blocked customer ${customerNumber}`);
      return;
    }

    // Step 9 - Save inbound message
    const inboundMsg = await saveMessage({
      business_id: tenant.businessId,
      customer_id: customer.id,
      customer_number: customerNumber,
      direction: 'inbound',
      type: messageType,
      content: messageText,
      meta_message_id: metaMessageId,
      status: 'delivered',
      is_read: false
    });

    // Step 10 - Increment usage (fire and forget)
    usageService.incrementUsage(tenant.businessId, 'inbound');

    // ADD THIS — Emit usage_update to Flutter dashboard
    usageService.checkUsageLimit(tenant.businessId, tenant.plan?.msg_limit || 500)
      .then(usageCheck => {
        socketService.emitToBusiness(tenant.businessId.toString(), 'usage_update', {
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
    const activeSession = await bookingService.getBookingSession(tenant.businessId, customerNumber);
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
        await bookingService.deleteBookingSession(tenant.businessId, customerNumber);

        const escapeBusinessDoc = await businessService.getBusinessById(tenant.businessId);
        const escapeHasMenu = !!(escapeBusinessDoc?.isMenuEnabled && escapeBusinessDoc.menuItems?.length > 0);

        // Cancellation confirmation message
        const cancelText = escapeHasMenu
          ? 'Booking cancelled.'
          : "Booking cancelled. Type 'hi' to see what I can help with.";
        const cancelMsg = await saveMessage({
          business_id: tenant.businessId,
          customer_id: customer.id,
          customer_number: customerNumber,
          direction: 'outbound',
          type: 'text',
          content: cancelText,
          status: 'sent',
          is_read: true
        });
        await addToWhatsappQueue({
          businessId: tenant.businessId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: cancelText,
          type: 'text',
          messageId: cancelMsg.id
        });
        usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
          logger.error('Error incrementing outbound usage:', err)
        );
        try {
          socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
            customer,
            message: cancelMsg,
            customerNumber
          });
        } catch (socketError) {
          logger.error('Error emitting socket event:', socketError);
        }

        // If the business has a menu, follow up with the same welcome/menu send
        // Step 12.5 does for a greeting.
        if (escapeHasMenu) {
          const menuListOptions = await buildMenuListOptions(escapeBusinessDoc.menuItems, customer.preferredLanguage);
          const menuReplyText = applyMessageTemplate(
            getLocalizedText(escapeBusinessDoc, 'welcomeMessage', customer.preferredLanguage) || 'How can we help you today?',
            tenant
          );

          const menuOutboundMsg = await saveMessage({
            business_id: tenant.businessId,
            customer_id: customer.id,
            customer_number: customerNumber,
            direction: 'outbound',
            type: 'text',
            content: menuReplyText,
            status: 'sent',
            is_read: true
          });
          await addToWhatsappQueue({
            businessId: tenant.businessId,
            phoneNumberId: tenant.phoneNumberId,
            encryptedAccessToken: tenant.accessToken,
            to: customerNumber,
            message: menuReplyText,
            type: 'text',
            listOptions: menuListOptions,
            listButtonLabel: 'Menu',
            messageId: menuOutboundMsg.id
          });
          usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
            logger.error('Error incrementing outbound usage:', err)
          );
          try {
            socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
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
      // field, resolve its id back to the option's text before handing off.
      // Plain text answers pass through untouched.
      let resolvedReply = messageText;
      const currentField = activeSession.fields[activeSession.step];
      const replyId = listReplyId !== null ? listReplyId : buttonReplyId;
      if (currentField && currentField.fieldType === 'vehicle_carousel' && buttonReplyId && buttonReplyId.startsWith('vehicle_')) {
        // Tapped "Book this" on a vehicle carousel message — id is
        // 'vehicle_<index>'; pass the bare index straight through.
        resolvedReply = buttonReplyId.slice('vehicle_'.length);
      } else if (currentField && (currentField.fieldType === 'buttons' || currentField.fieldType === 'list') && replyId !== null) {
        // id is "{step}:{index}" (see sendInteractiveButtons/sendListMessage
        // mapping in the worker) — the step it was generated for, not just
        // the option's index. Two different questions can have an option at
        // the same index (e.g. travelDate's "Other date" and pickupTime's
        // "Other time" are both index 2), so a bare index would let a stale
        // tap from an earlier, already-answered question get misresolved
        // against whatever field is currently active.
        const options = currentField.options || [];
        const sepIdx = replyId.indexOf(':');
        const tappedStep = sepIdx === -1 ? NaN : parseInt(replyId.slice(0, sepIdx), 10);
        const tappedIndex = sepIdx === -1 ? NaN : parseInt(replyId.slice(sepIdx + 1), 10);

        if (tappedStep !== activeSession.step) {
          // Stale tap from an earlier question (or a malformed id) — don't
          // resolve it as an answer to the current question. Silently ignore
          // it and re-send the current question's prompt so the customer
          // sees the bot is still waiting here, without advancing
          // session.step or touching session.collected.
          const resendMsg = await saveMessage({
            business_id: tenant.businessId,
            customer_id: customer.id,
            customer_number: customerNumber,
            direction: 'outbound',
            type: 'text',
            content: currentField.label,
            status: 'sent',
            triggered_rule_id: activeSession.ruleId,
            is_read: true
          });
          const resendJobData = {
            businessId: tenant.businessId,
            phoneNumberId: tenant.phoneNumberId,
            encryptedAccessToken: tenant.accessToken,
            to: customerNumber,
            message: currentField.label,
            type: 'text',
            step: activeSession.step,
            messageId: resendMsg.id
          };
          if (currentField.fieldType === 'buttons') {
            resendJobData.interactiveButtons = options;
          } else {
            resendJobData.interactiveList = options;
            resendJobData.listButtonLabel = 'Choose';
          }
          await addToWhatsappQueue(resendJobData);

          usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
            logger.error('Error incrementing outbound usage:', err)
          );
          try {
            socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
              customer,
              message: resendMsg,
              customerNumber
            });
          } catch (socketError) {
            logger.error('Error emitting socket event:', socketError);
          }

          logger.info(`Ignored stale button/list tap for ${customerNumber} (tapped step ${tappedStep}, current step ${activeSession.step})`);
          return; // Do not advance the session or run rule matching
        }

        if (!Number.isNaN(tappedIndex) && options[tappedIndex] !== undefined) {
          resolvedReply = options[tappedIndex];
        }
      }

      // Process booking step
      const stepResult = await bookingService.processBookingStep(
        tenant.businessId,
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
          const refreshedSession = await bookingService.getBookingSession(tenant.businessId, customerNumber);
          const refreshedField = refreshedSession?.fields[refreshedSession.step];
          if (refreshedField && refreshedField.fieldType === 'vehicle_carousel') {
            carouselOptions = refreshedField.options || [];
          }
        }

        if (carouselOptions) {
          let sentCount = 0;
          try {
            // Intro message (question text or the stale-vehicle re-prompt)
            const introText = nextField ? nextField.label : stepResult;
            const introMsg = await createMessageSoft({
              business_id: tenant.businessId,
              customer_id: customer.id,
              customer_number: customerNumber,
              direction: 'outbound',
              type: 'text',
              content: introText,
              status: 'sent',
              triggered_rule_id: activeSession.ruleId,
              is_read: true
            }, 'carousel intro');

            // Awaited-to-completion (not just enqueued) so this intro message
            // is guaranteed to land at WhatsApp before the vehicle messages
            // below, even though the worker processes jobs with concurrency: 5.
            try {
              await addToWhatsappQueueAndWait({
                businessId: tenant.businessId,
                phoneNumberId: tenant.phoneNumberId,
                encryptedAccessToken: tenant.accessToken,
                to: customerNumber,
                message: introText,
                type: 'text',
                messageId: introMsg.id
              });
            } catch (sendError) {
              logger.error('Error sending carousel intro message', {
                businessId: tenant.businessId,
                customerNumber,
                message: sendError.message,
                stack: sendError.stack
              });
            }

            usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
              logger.error('Error incrementing outbound usage:', err)
            );

            try {
              socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
                customer,
                message: introMsg,
                customerNumber
              });
            } catch (socketError) {
              logger.error('Error emitting socket event:', socketError);
            }

            // One message per vehicle option: image + caption + "Book this" button
            logger.info('Sending vehicle carousel', { businessId: tenant.businessId, customerNumber, optionCount: carouselOptions.length });
            for (const option of carouselOptions) {
              const captionParts = [option.name];
              if (option.seats) captionParts.push(`${option.seats} seats`);
              captionParts.push(`₹${option.fare}`);
              const caption = captionParts.join(' • ');

              const vehicleMsg = await createMessageSoft({
                business_id: tenant.businessId,
                customer_id: customer.id,
                customer_number: customerNumber,
                direction: 'outbound',
                type: 'text',
                content: caption,
                status: 'sent',
                triggered_rule_id: activeSession.ruleId,
                is_read: true
              }, 'carousel vehicle');

              // Awaited-to-completion so vehicle messages send in the same
              // order they're constructed, regardless of worker concurrency.
              try {
                await addToWhatsappQueueAndWait({
                  businessId: tenant.businessId,
                  phoneNumberId: tenant.phoneNumberId,
                  encryptedAccessToken: tenant.accessToken,
                  to: customerNumber,
                  message: caption,
                  type: 'text',
                  imageUrl: option.photoUrl || null,
                  buttons: [{ title: 'Book this', nextKeyword: `vehicle_${option.index}` }],
                  messageId: vehicleMsg.id
                });
                sentCount++;
              } catch (sendError) {
                logger.error('Error sending carousel vehicle message', {
                  businessId: tenant.businessId,
                  customerNumber,
                  optionIndex: option.index,
                  optionName: option.name,
                  message: sendError.message,
                  stack: sendError.stack
                });
              }

              usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
                logger.error('Error incrementing outbound usage:', err)
              );

              try {
                socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
                  customer,
                  message: vehicleMsg,
                  customerNumber
                });
              } catch (socketError) {
                logger.error('Error emitting socket event:', socketError);
              }
            }

            logger.info('Vehicle carousel send complete', {
              businessId: tenant.businessId,
              customerNumber,
              totalOptions: carouselOptions.length,
              sentCount
            });

            // Escape hatch: let the customer opt out of the carousel if their
            // preferred vehicle isn't listed.
            const otherOptionsText = "Don't see the vehicle you want?";
            const otherOptionsMsg = await createMessageSoft({
              business_id: tenant.businessId,
              customer_id: customer.id,
              customer_number: customerNumber,
              direction: 'outbound',
              type: 'text',
              content: otherOptionsText,
              status: 'sent',
              triggered_rule_id: activeSession.ruleId,
              is_read: true
            }, 'carousel other-options');

            // Awaited-to-completion so this message lands after the last
            // vehicle message, preserving the constructed order.
            try {
              await addToWhatsappQueueAndWait({
                businessId: tenant.businessId,
                phoneNumberId: tenant.phoneNumberId,
                encryptedAccessToken: tenant.accessToken,
                to: customerNumber,
                message: otherOptionsText,
                type: 'text',
                buttons: [{ title: 'Other options', nextKeyword: 'vehicle_other' }],
                messageId: otherOptionsMsg.id
              });
            } catch (sendError) {
              logger.error('Error sending carousel "other options" message', {
                businessId: tenant.businessId,
                customerNumber,
                message: sendError.message,
                stack: sendError.stack
              });
            }

            usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
              logger.error('Error incrementing outbound usage:', err)
            );

            try {
              socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
                customer,
                message: otherOptionsMsg,
                customerNumber
              });
            } catch (socketError) {
              logger.error('Error emitting socket event:', socketError);
            }
          } catch (error) {
            logger.error('Fatal error in vehicle carousel send block', {
              businessId: tenant.businessId,
              customerNumber,
              message: error.message,
              stack: error.stack
            });
          }

          return; // Do not run rule matching
        }

        const replyText = nextField ? nextField.label : stepResult;

        // Save outbound message to DB
        const outboundMsg = await saveMessage({
          business_id: tenant.businessId,
          customer_id: customer.id,
          customer_number: customerNumber,
          direction: 'outbound',
          type: 'text',
          content: replyText,
          status: 'sent',
          triggered_rule_id: activeSession.ruleId,
          is_read: true
        });

        // Queue outbound message via addToWhatsappQueue
        const outboundJobData = {
          businessId: tenant.businessId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: replyText,
          type: 'text',
          messageId: outboundMsg.id
        };
        if (nextField && (nextField.fieldType === 'buttons' || nextField.fieldType === 'list')) {
          // nextField's step isn't always activeSession.step + 1 — bailing
          // out of the vehicle carousel to the generic vehicleType list
          // reuses the SAME step instead of advancing. Re-fetch the session
          // (already saved by processBookingStep) to get the step this
          // question truly lives at, so outbound ids line up with what
          // inbound resolution will later compare against session.step.
          const stepSession = await bookingService.getBookingSession(tenant.businessId, customerNumber);
          outboundJobData.step = stepSession ? stepSession.step : activeSession.step;
          if (nextField.fieldType === 'buttons') {
            outboundJobData.interactiveButtons = nextField.options || [];
          } else {
            outboundJobData.interactiveList = nextField.options || [];
            outboundJobData.listButtonLabel = 'Choose';
          }
        }
        await addToWhatsappQueue(outboundJobData);

        // Increment outbound usage (fire and forget)
        usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
          logger.error('Error incrementing outbound usage:', err)
        );

        // Emit socket event
        try {
          socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
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

    // Step 12.6 - Dynamic language selection. Runs only once Step 12's
    // booking-session handling has fallen through (no active session, or it
    // just expired) so an in-progress booking is never hijacked mid-flow.
    if (customer.preferredLanguage === null && !(buttonReplyId && buttonReplyId.startsWith('lang_'))) {
      const languageBusinessDoc = await businessService.getBusinessById(tenant.businessId);
      const enabledLanguages = languageBusinessDoc?.enabledLanguages?.length ? languageBusinessDoc.enabledLanguages : ['en'];

      if (enabledLanguages.length === 1) {
        // Nothing to ask - set it directly and fall through to greeting/rule
        // matching this same turn.
        const { data: updatedCustomer, error: langErr } = await supabase
          .from('customers')
          .update({ preferred_language: enabledLanguages[0] })
          .eq('id', customer.id)
          .select()
          .single();
        if (langErr) throw langErr;
        customer.preferredLanguage = toCamelCase(updatedCustomer).preferredLanguage;
      } else {
        // 2 or 3 languages enabled - ask, then wait for the reply.
        const languageButtons = enabledLanguages.map((code) => ({
          title: (LANGUAGE_CATALOG[code]?.name || code).slice(0, 20),
          nextKeyword: `lang_${code}`
        }));
        const languageChoiceLine = 'Choose your language / अपनी भाषा चुनें';
        const welcomeMessage = getLocalizedText(languageBusinessDoc, 'welcomeMessage', 'en');
        const languagePromptText = applyMessageTemplate(
          welcomeMessage ? `${welcomeMessage}\n\n${languageChoiceLine}` : languageChoiceLine,
          tenant
        );

        const languagePromptMsg = await saveMessage({
          business_id: tenant.businessId,
          customer_id: customer.id,
          customer_number: customerNumber,
          direction: 'outbound',
          type: 'text',
          content: languagePromptText,
          status: 'sent',
          is_read: true
        });
        await addToWhatsappQueue({
          businessId: tenant.businessId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: languagePromptText,
          type: 'text',
          buttons: languageButtons,
          messageId: languagePromptMsg.id
        });
        usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
          logger.error('Error incrementing outbound usage:', err)
        );
        try {
          socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
            customer,
            message: languagePromptMsg,
            customerNumber
          });
        } catch (socketError) {
          logger.error('Error emitting socket event:', socketError);
        }

        logger.info(`Sent language picker for business ${tenant.businessId}, customer ${customerNumber}`);
        return; // Do not run greeting or rule matching this turn
      }
    }

    if (buttonReplyId && buttonReplyId.startsWith('lang_')) {
      // Customer tapped a language-picker button - validate (defends
      // against a stale/tampered id), persist, then fall through to the
      // greeting/rule-matching flow below as if the customer had just said
      // "hi" - the language picker only ever fires on a new customer's
      // first-ever message (Step 12.6 only runs when preferredLanguage is
      // null), so treating the tap as a greeting reproduces the normal
      // "hi" experience (menu, rules, buttons and all) via Step 12.5 /
      // Step 13, instead of sending a separate, simpler welcome message
      // that skips rule matching.
      const tappedCode = buttonReplyId.slice('lang_'.length);
      const langBusinessDoc = await businessService.getBusinessById(tenant.businessId);
      const enabledLanguages = langBusinessDoc?.enabledLanguages?.length ? langBusinessDoc.enabledLanguages : ['en'];

      if (!isValidLanguageCode(tappedCode) || !enabledLanguages.includes(tappedCode)) {
        logger.warn(`Ignoring language selection tap with invalid/stale code "${tappedCode}" for business ${tenant.businessId}, customer ${customerNumber}`);
        return; // Do not run rule matching
      }

      const { data: updatedCustomer, error: langErr } = await supabase
        .from('customers')
        .update({ preferred_language: tappedCode })
        .eq('id', customer.id)
        .select()
        .single();
      if (langErr) throw langErr;
      customer.preferredLanguage = toCamelCase(updatedCustomer).preferredLanguage;

      logger.info(`Set preferred language ${tappedCode} for business ${tenant.businessId}, customer ${customerNumber}; falling through to greeting`);
      messageText = 'hi';
      // No return - fall through to Step 12.5 / Step 13 below, which will
      // greet with the business's welcomeMessage/menu if configured, or
      // otherwise run rule matching against 'hi' exactly like a real
      // greeting message would.
    }

    // Step 12.5 - Greeting -> welcome message / menu (exact match only, so
    // real rule keywords still take priority over this).
    const normalizedText = (messageText || '').trim().toLowerCase();
    if (GREETING_KEYWORDS.has(normalizedText)) {
      const businessDoc = await businessService.getBusinessById(tenant.businessId);

      const hasMenu = !!(businessDoc?.isMenuEnabled && businessDoc.menuItems?.length > 0);
      const localizedWelcomeMessage = getLocalizedText(businessDoc, 'welcomeMessage', customer.preferredLanguage);

      if (businessDoc && (localizedWelcomeMessage || hasMenu)) {
        let greetingReplyText = localizedWelcomeMessage || '';
        let menuListOptions = [];

        if (hasMenu) {
          menuListOptions = await buildMenuListOptions(businessDoc.menuItems, customer.preferredLanguage);

          if (!greetingReplyText) {
            greetingReplyText = 'How can we help you today?';
          }
        }

        greetingReplyText = applyMessageTemplate(greetingReplyText, tenant);

        // Save outbound message
        const greetingOutboundMsg = await saveMessage({
          business_id: tenant.businessId,
          customer_id: customer.id,
          customer_number: customerNumber,
          direction: 'outbound',
          type: 'text',
          content: greetingReplyText,
          status: 'sent',
          is_read: true
        });

        // Queue outbound message the same way Step 16 does
        const greetingJobData = {
          businessId: tenant.businessId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: greetingReplyText,
          type: 'text',
          listOptions: menuListOptions,
          listButtonLabel: 'Menu',
          messageId: greetingOutboundMsg.id
        };
        await addToWhatsappQueue(greetingJobData);

        // Increment outbound usage (fire and forget)
        usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
          logger.error('Error incrementing outbound usage:', err)
        );

        // Emit socket event
        try {
          socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
            customer,
            message: greetingOutboundMsg,
            customerNumber
          });
        } catch (socketError) {
          logger.error('Error emitting new_message socket event for greeting:', socketError);
        }

        logger.info(`Sent welcome message for business ${tenant.businessId}, customer ${customerNumber}`);
        return; // Do not run rule matching or fallback
      }
    }

    // Step 13 - Run rule matching
    const matchedRule = await chatbotService.findMatchingRule(tenant.businessId, messageText);

    // Step 14 — Prepare reply based on rule type
    let replyText = null;
    let triggeredRuleId = null;
    let bookingField = null; // set when booking_trigger fires, for interactive rendering below
    let fallbackMenuListOptions = null; // set when no rule matched and business has an enabled menu

    if (matchedRule) {
      triggeredRuleId = matchedRule.id;

      if (matchedRule.replyType === 'text') {
        // Simple text reply (may also carry an image and/or buttons).
        const localizedReply = getLocalizedText(matchedRule, 'reply', customer.preferredLanguage);
        replyText = applyMessageTemplate(localizedReply, tenant);

      } else if (matchedRule.replyType === 'booking_trigger') {
        // Start booking flow — ask first question
        const firstField = await bookingService.startBookingSession(
          tenant.businessId,
          customerNumber,
          matchedRule.id
        );
        bookingField = firstField;
        replyText = firstField.label;

      } else if (matchedRule.replyType === 'payment_trigger') {
        replyText = applyMessageTemplate(matchedRule.reply, tenant) || 'Please complete your payment.';
      }
    } else {
      // No rule matched — try an AI-generated fallback (opt-in per business),
      // falling back to the static reply on any failure or timeout.
      let smartReply = null;
      if (tenant.enableSmartFallback) {
        try {
          smartReply = await Promise.race([
            smartFallbackService.getSmartFallbackReply(tenant.businessId, messageText),
            new Promise((resolve) => setTimeout(() => resolve(null), 4000))
          ]);
        } catch (smartFallbackError) {
          logger.error('Error generating smart fallback reply:', smartFallbackError);
          smartReply = null;
        }
      }

      replyText = smartReply || applyMessageTemplate(tenant.fallbackReply, tenant) || 'Thank you for your message. We will get back to you soon.';

      // Attach the numbered menu (if the business has one enabled) regardless of
      // whether replyText above came from the AI smart fallback or the
      // static fallbackReply — gives the customer a way to reach a real
      // rule instead of a dead-end message.
      const fallbackBusinessDoc = await businessService.getBusinessById(tenant.businessId);
      const fallbackHasMenu = !!(fallbackBusinessDoc?.isMenuEnabled && fallbackBusinessDoc.menuItems?.length > 0);

      if (fallbackHasMenu) {
        fallbackMenuListOptions = await buildMenuListOptions(fallbackBusinessDoc.menuItems, customer.preferredLanguage);
      }
    }

    // Step 15 - Save outbound message
    const outboundMsg = await saveMessage({
      business_id: tenant.businessId,
      customer_id: customer.id,
      customer_number: customerNumber,
      direction: 'outbound',
      type: 'text',
      content: replyText,
      status: 'sent',
      triggered_rule_id: triggeredRuleId,
      is_read: true
    });

    // Step 16 - Queue outbound message. Localize matchedRule's buttons/list
    // options display text only — nextKeyword is untouched, it's the
    // matching key that comes back as button_reply.id/list_reply.id.
    const localizedButtons = (matchedRule?.buttons || []).map(b => ({
      ...b,
      title: getLocalizedText(b, 'title', customer.preferredLanguage)
    }));
    const localizedListOptions = (matchedRule?.listOptions || []).map(o => ({
      ...o,
      label: getLocalizedText(o, 'label', customer.preferredLanguage),
      description: getLocalizedText(o, 'description', customer.preferredLanguage)
    }));

    const outboundJobData = {
      businessId: tenant.businessId,
      phoneNumberId: tenant.phoneNumberId,
      encryptedAccessToken: tenant.accessToken,
      to: customerNumber,
      message: replyText,
      type: 'text',
      imageUrl: matchedRule?.replyImageUrl || null,
      buttons: localizedButtons,
      listOptions: fallbackMenuListOptions || localizedListOptions,
      messageId: outboundMsg.id
    };
    if (fallbackMenuListOptions) {
      outboundJobData.listButtonLabel = 'Menu';
    }
    if (bookingField && (bookingField.fieldType === 'buttons' || bookingField.fieldType === 'list')) {
      // startBookingSession always creates the session at step 0.
      outboundJobData.step = 0;
      if (bookingField.fieldType === 'buttons') {
        outboundJobData.interactiveButtons = bookingField.options || [];
      } else {
        outboundJobData.interactiveList = bookingField.options || [];
        outboundJobData.listButtonLabel = 'Choose';
      }
    }
    await addToWhatsappQueue(outboundJobData);

    // ADD THIS — Emit new_message to Flutter app with full customer object
    try {
      socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
        customer,
        message: outboundMsg,
        customerNumber
      });
    } catch (socketError) {
      logger.error('Error emitting new_message socket event:', socketError);
    }

    // Step 17 - Increment outbound usage (fire and forget)
    usageService.incrementUsage(tenant.businessId, 'outbound');

    logger.info(`Processed webhook for business ${tenant.businessId}, customer ${customerNumber}`);

  } catch (error) {
    logger.error('Error processing webhook:', error);
    // Already sent 200, so we just log the error
  }
};

module.exports = {
  verifyWebhook,
  receiveWebhook
};
