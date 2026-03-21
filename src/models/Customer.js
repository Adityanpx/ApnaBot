const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  shopId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true
  },
  whatsappNumber: {
    type: String,
    required: true
  },
  name: {
    type: String,
    default: null
  },
  firstSeenAt: {
    type: Date,
    default: Date.now
  },
  lastMessageAt: {
    type: Date,
    default: Date.now
  },
  totalMessages: {
    type: Number,
    default: 0
  },
  tags: {
    type: [String],
    default: []
  },
  notes: {
    type: String,
    default: null
  },
  isBlocked: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

// Indexes
customerSchema.index({ shopId: 1, whatsappNumber: 1 }, { unique: true });
customerSchema.index({ shopId: 1 });

module.exports = mongoose.model('Customer', customerSchema);
