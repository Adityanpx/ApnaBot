const mongoose = require('mongoose');

const usageSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
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
usageSchema.index({ businessId: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('Usage', usageSchema);
