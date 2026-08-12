const axios = require('axios');
const { decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

const META_API_BASE = 'https://graph.facebook.com/v18.0';

// TEMPORARY diagnostic logging to trace token corruption between encrypt-time
// (scripts/restoreSgTravelsWhatsapp.js) and decrypt-time (here). Remove once resolved.
const logTokenDecrypt = (fnName, encryptedAccessToken, accessToken) => {
  logger.info('[DEBUG] token decrypt', {
    fn: fnName,
    encryptedLength: encryptedAccessToken ? encryptedAccessToken.length : null,
    decryptedLength: accessToken ? accessToken.length : null,
    decryptedPreview: accessToken ? `${accessToken.slice(0, 6)}...${accessToken.slice(-6)}` : null
  });
};

/**
 * Send a text message via WhatsApp
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} to - Recipient phone number
 * @param {string} message - Message text
 * @returns {Promise<Object>}
 */
const sendTextMessage = async (phoneNumberId, encryptedAccessToken, to, message) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);
    logTokenDecrypt('sendTextMessage', encryptedAccessToken, accessToken);

    const response = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: { body: message, preview_url: false }
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    logger.error('Error sending text message:', {
      phoneNumberId,
      to,
      error: error.response?.data || error.message
    });
    throw error;
  }
};

/**
 * Send an image message via WhatsApp (image on top, reply text as caption)
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} to - Recipient phone number
 * @param {string} imageUrl - Publicly reachable image URL
 * @param {string} caption - Caption text
 * @returns {Promise<Object>}
 */
const sendImageMessage = async (phoneNumberId, encryptedAccessToken, to, imageUrl, caption) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);
    logTokenDecrypt('sendImageMessage', encryptedAccessToken, accessToken);
    const response = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'image',
        image: { link: imageUrl, caption: caption || undefined }
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (error) {
    logger.error('Error sending image message:', { phoneNumberId, to, error: error.response?.data || error.message });
    throw error;
  }
};

/**
 * Send an interactive reply-buttons message (optional image header + body + up to 3 buttons).
 * Each button's id IS its nextKeyword, so the webhook can feed it straight back
 * into the rule matcher when tapped.
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} to - Recipient phone number
 * @param {string} bodyText - Message body text
 * @param {Array} buttons - [{ title, nextKeyword }]
 * @param {string} [imageUrl] - Optional header image URL
 * @returns {Promise<Object>}
 */
const sendInteractiveButtons = async (phoneNumberId, encryptedAccessToken, to, bodyText, buttons, imageUrl) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);
    logTokenDecrypt('sendInteractiveButtons', encryptedAccessToken, accessToken);
    const interactive = {
      type: 'button',
      body: { text: (bodyText || '').slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.nextKeyword, title: (b.title || '').slice(0, 20) }
        }))
      }
    };
    if (imageUrl) {
      interactive.header = { type: 'image', image: { link: imageUrl } };
    }
    const response = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (error) {
    logger.error('Error sending interactive buttons:', { phoneNumberId, to, error: error.response?.data || error.message });
    throw error;
  }
};

/**
 * Send an interactive list message (single section, tappable rows).
 * Each option becomes a row whose id is its index (as a string) and whose
 * title is the option text, modeled on sendInteractiveButtons.
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} to - Recipient phone number
 * @param {string} bodyText - Message body text
 * @param {string} buttonLabel - Text on the list-opening button
 * @param {Array<string>} options - Option labels, one per row
 * @returns {Promise<Object>}
 */
const sendListMessage = async (phoneNumberId, encryptedAccessToken, to, bodyText, buttonLabel, options) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);
    logTokenDecrypt('sendListMessage', encryptedAccessToken, accessToken);
    const interactive = {
      type: 'list',
      body: { text: (bodyText || '').slice(0, 1024) },
      action: {
        button: (buttonLabel || '').slice(0, 20),
        sections: [
          {
            rows: options.map((opt, index) => ({
              id: String(index),
              title: (opt || '').slice(0, 24)
            }))
          }
        ]
      }
    };
    logger.info('[DEBUG] sendListMessage interactive payload:', { phoneNumberId, to, interactive: JSON.stringify(interactive) });
    const response = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    logger.info('[DEBUG] sendListMessage response:', { phoneNumberId, to, data: JSON.stringify(response.data) });
    return response.data;
  } catch (error) {
    logger.error('Error sending list message:', { phoneNumberId, to, error: error.response?.data || error.message });
    throw error;
  }
};

/**
 * Send a WhatsApp list message where each row chains to a specific rule by keyword.
 * Unlike sendListMessage (index-based, used by the booking flow's choice questions),
 * each row's id is the rule's nextKeyword.
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} to - Recipient phone number
 * @param {string} bodyText - Message body text
 * @param {string} buttonLabel - Text on the list-opening button
 * @param {Array<{label: string, description?: string, nextKeyword: string}>} options - Rule list options
 * @returns {Promise<Object>}
 */
const sendRuleListMessage = async (phoneNumberId, encryptedAccessToken, to, bodyText, buttonLabel, options) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);
    logTokenDecrypt('sendRuleListMessage', encryptedAccessToken, accessToken);
    const interactive = {
      type: 'list',
      body: { text: (bodyText || '').slice(0, 1024) },
      action: {
        button: (buttonLabel || 'Choose').slice(0, 20),
        sections: [
          {
            rows: options.map((opt) => ({
              id: opt.nextKeyword,
              title: (opt.label || '').slice(0, 24),
              ...(opt.description ? { description: opt.description.slice(0, 72) } : {})
            }))
          }
        ]
      }
    };
    const response = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (error) {
    logger.error('Error sending rule list message:', { phoneNumberId, to, error: error.response?.data || error.message });
    throw error;
  }
};

/**
 * Send a template message via WhatsApp
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} to - Recipient phone number
 * @param {string} templateName - Template name
 * @param {string} languageCode - Language code (default: 'en')
 * @param {Array} components - Template components
 * @returns {Promise<Object>}
 */
const sendTemplateMessage = async (
  phoneNumberId,
  encryptedAccessToken,
  to,
  templateName,
  languageCode = 'en',
  components = []
) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);
    logTokenDecrypt('sendTemplateMessage', encryptedAccessToken, accessToken);

    const response = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components: components
        }
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    logger.error('Error sending template message:', {
      phoneNumberId,
      to,
      templateName,
      error: error.response?.data || error.message
    });
    throw error;
  }
};

/**
 * Mark a message as read
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} metaMessageId - Meta message ID to mark as read
 */
const markMessageAsRead = async (phoneNumberId, encryptedAccessToken, metaMessageId) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);
    logTokenDecrypt('markMessageAsRead', encryptedAccessToken, accessToken);

    await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: metaMessageId
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    // Do not throw - just log warning
    logger.warn('Failed to mark message as read:', {
      phoneNumberId,
      metaMessageId,
      error: error.response?.data || error.message
    });
  }
};

module.exports = {
  sendTextMessage,
  sendImageMessage,
  sendInteractiveButtons,
  sendListMessage,
  sendRuleListMessage,
  sendTemplateMessage,
  markMessageAsRead,
  META_API_BASE
};
