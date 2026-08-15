const mongoose = require('mongoose');

const businessSchema = new mongoose.Schema({
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
  businessCategory: {
    type: String,
    required: true,
    enum: ['tailor', 'salon', 'garage', 'cab', 'coaching', 'gym', 'medical', 'general', 'photographer', 'caterer', 'tutor', 'jeweller', 'boutique', 'grocery', 'bakery', 'electronics_repair', 'real_estate', 'driving_school', 'travels']
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
  },
  enableSmartFallback: {
    type: Boolean,
    default: false
  },
  welcomeMessage: {
    type: String,
    default: ''
  },
  isMenuEnabled: {
    type: Boolean,
    default: false
  },
  enableDistanceFares: {
    type: Boolean,
    default: false
  },
  roundTripPerDayKm: {
    type: Number,
    default: 250
  },
  roundTripDriverDaEnabled: {
    type: Boolean,
    default: false
  },
  roundTripDriverDaAmount: {
    type: Number,
    default: 0
  },
  previewCreditsUsed: {
    type: Number,
    default: 0
  },
  previewCreditsResetAt: {
    type: Date,
    default: null
  },
  previewCreditsPurchased: {
    type: Number,
    default: 0
  },
  menuItems: {
    type: [{
      number: { type: Number, required: true },
      label: { type: String, required: true, trim: true },
      ruleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rule', required: true },
      order: { type: Number, required: true }
    }],
    default: []
  },
  disabledBookingFields: {
    type: [String],
    default: []
  }
}, { timestamps: true, collection: 'businesses' });

// Indexes
businessSchema.index({ phoneNumberId: 1 }, { unique: true, partialFilterExpression: { phoneNumberId: { $type: 'string' } } });
businessSchema.index({ ownerUserId: 1 });
businessSchema.index({ businessCategory: 1 });

module.exports = mongoose.model('Business', businessSchema);
