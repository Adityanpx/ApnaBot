const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
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
    enum: ['text', 'image', 'document', 'audio', 'interactive'],
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
messageSchema.index({ businessId: 1, customerId: 1 });
messageSchema.index({ businessId: 1, createdAt: -1 });
messageSchema.index({ metaMessageId: 1 }, { sparse: true });

module.exports = mongoose.model('Message', messageSchema);
