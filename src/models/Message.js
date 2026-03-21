const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  shopId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  customerNumber: {
    type: String,
    required: true
  },
  direction: {
    type: String,
    required: true,
    enum: ['inbound', 'outbound']
  },
  type: {
    type: String,
    required: true,
    enum: ['text', 'image', 'document', 'audio'],
    default: 'text'
  },
  content: {
    type: String,
    default: null
  },
  mediaUrl: {
    type: String,
    default: null
  },
  metaMessageId: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['sent', 'delivered', 'read', 'failed'],
    default: 'sent'
  },
  isRead: {
    type: Boolean,
    default: false
  },
  triggeredRuleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Rule',
    default: null
  }
}, { timestamps: true });

// Indexes
messageSchema.index({ shopId: 1, customerId: 1 });
messageSchema.index({ shopId: 1, createdAt: -1 });
messageSchema.index({ metaMessageId: 1 }, { sparse: true });

module.exports = mongoose.model('Message', messageSchema);
