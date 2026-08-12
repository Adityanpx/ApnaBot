const mongoose = require('mongoose');

const broadcastSchema = new mongoose.Schema({
  shopId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true
  },
  templateId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MessageTemplate',
    required: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  audienceFilter: {
    type: String,
    enum: ['all_customers'],
    default: 'all_customers'
  },
  templateVariables: {
    type: [String],
    default: []
  },
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'sending', 'completed', 'failed', 'cancelled'],
    default: 'draft'
  },
  scheduledAt: {
    type: Date,
    default: null
  },
  totalRecipients: {
    type: Number,
    default: 0
  },
  sentCount: {
    type: Number,
    default: 0
  },
  failedCount: {
    type: Number,
    default: 0
  },
  startedAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

// Indexes
broadcastSchema.index({ shopId: 1 });
broadcastSchema.index({ shopId: 1, status: 1 });

module.exports = mongoose.model('Broadcast', broadcastSchema);
