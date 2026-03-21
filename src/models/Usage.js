const mongoose = require('mongoose');

const usageSchema = new mongoose.Schema({
  shopId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true
  },
  month: {
    type: String,
    required: true
  },
  msgCount: {
    type: Number,
    default: 0
  },
  inboundCount: {
    type: Number,
    default: 0
  },
  outboundCount: {
    type: Number,
    default: 0
  },
  bookingCount: {
    type: Number,
    default: 0
  },
  paymentLinkCount: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

// Indexes
usageSchema.index({ shopId: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('Usage', usageSchema);
