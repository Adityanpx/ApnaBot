const mongoose = require('mongoose');

const ruleSchema = new mongoose.Schema({
  shopId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true
  },
  keyword: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },
  matchType: {
    type: String,
    required: true,
    enum: ['exact', 'contains', 'startsWith'],
    default: 'contains'
  },
  reply: {
    type: String,
    required: true
  },
  replyType: {
    type: String,
    required: true,
    enum: ['text', 'booking_trigger', 'payment_trigger'],
    default: 'text'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  triggerCount: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

// Indexes
ruleSchema.index({ shopId: 1 });
ruleSchema.index({ shopId: 1, keyword: 1 });

module.exports = mongoose.model('Rule', ruleSchema);
