const mongoose = require('mongoose');

const shopSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  ownerUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  businessType: {
    type: String,
    required: true,
    enum: ['tailor', 'salon', 'garage', 'cab', 'coaching', 'gym', 'medical', 'general']
  },
  whatsappNumber: {
    type: String,
    default: null
  },
  phoneNumberId: {
    type: String,
    default: null
  },
  wabaId: {
    type: String,
    default: null
  },
  accessToken: {
    type: String,
    default: null
  },
  displayName: {
    type: String,
    default: null
  },
  profileImage: {
    type: String,
    default: null
  },
  upiId: {
    type: String,
    default: null
  },
  address: {
    type: String,
    default: null
  },
  city: {
    type: String,
    default: null
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isWhatsappConnected: {
    type: Boolean,
    default: false
  },
  webhookVerifyToken: {
    type: String,
    default: null
  },
  fallbackReply: {
    type: String,
    default: 'Thank you for your message. We will get back to you shortly.'
  }
}, { timestamps: true });

// Indexes
shopSchema.index({ phoneNumberId: 1 }, { unique: true, sparse: true });
shopSchema.index({ ownerUserId: 1 });
shopSchema.index({ businessType: 1 });

module.exports = mongoose.model('Shop', shopSchema);
