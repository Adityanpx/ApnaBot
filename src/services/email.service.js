// src/services/email.service.js — CREATE THIS FILE

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

// Create reusable transporter
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.EMAIL_PORT) || 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

/**
 * Send password reset email
 * @param {string} toEmail - Recipient email
 * @param {string} resetToken - The reset token
 * @param {string} userName - Recipient name
 */
const sendPasswordResetEmail = async (toEmail, resetToken, userName) => {
  try {
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}&email=${toEmail}`;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'ApnaBot <noreply@apnabot.com>',
      to: toEmail,
      subject: 'Reset your ApnaBot password',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a1a2e;">Password Reset Request</h2>
          <p>Hi ${userName},</p>
          <p>We received a request to reset your ApnaBot password.</p>
          <p>Click the button below to reset it. This link expires in <strong>1 hour</strong>.</p>
          <a href="${resetUrl}"
             style="display: inline-block; background: #1a1a2e; color: white;
                    padding: 12px 24px; border-radius: 6px; text-decoration: none;
                    margin: 16px 0;">
            Reset Password
          </a>
          <p style="color: #777; font-size: 13px;">
            If you did not request this, ignore this email. Your password will not change.
          </p>
          <p style="color: #777; font-size: 13px;">
            Or copy this link: ${resetUrl}
          </p>
        </div>
      `
    });

    logger.info(`Password reset email sent to ${toEmail}`);
  } catch (error) {
    logger.error('Error sending password reset email:', error);
    throw error;
  }
};

/**
 * Send subscription expiry warning email
 * @param {string} toEmail
 * @param {string} shopName
 * @param {Date} expiryDate
 */
const sendExpiryWarningEmail = async (toEmail, shopName, expiryDate) => {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'ApnaBot <noreply@apnabot.com>',
      to: toEmail,
      subject: `Your ApnaBot subscription for ${shopName} is expiring soon`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a1a2e;">Subscription Expiring Soon</h2>
          <p>Hi,</p>
          <p>Your ApnaBot subscription for <strong>${shopName}</strong> will expire on
             <strong>${expiryDate.toDateString()}</strong>.</p>
          <p>Renew now to keep your WhatsApp chatbot running without interruption.</p>
          <a href="${process.env.FRONTEND_URL}/billing"
             style="display: inline-block; background: #1a1a2e; color: white;
                    padding: 12px 24px; border-radius: 6px; text-decoration: none;
                    margin: 16px 0;">
            Renew Subscription
          </a>
        </div>
      `
    });

    logger.info(`Expiry warning email sent to ${toEmail} for shop ${shopName}`);
  } catch (error) {
    logger.error('Error sending expiry warning email:', error);
    // Don't throw — email failure should not crash the app
  }
};

module.exports = {
  sendPasswordResetEmail,
  sendExpiryWarningEmail
};
