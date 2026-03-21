const axios = require('axios');
const { decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

const META_API_BASE = 'https://graph.facebook.com/v18.0';

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
  sendTemplateMessage,
  markMessageAsRead,
  META_API_BASE
};
