const mongoose = require('mongoose');

const ruleSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
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
  hindiAliases: {
    type: [String],
    default: []
  },
  reply: {
    type: String,
    required: true
  },
  replyImageUrl: {
    type: String,
    default: null
  },
  buttons: {
    type: [{
      title: { type: String, required: true, maxlength: 20 },
      nextKeyword: { type: String, required: true, lowercase: true, trim: true }
    }],
    default: [],
    validate: {
      validator: (arr) => arr.length <= 3,
      message: 'A rule can have at most 3 buttons.'
    }
  },
  listOptions: {
    type: [{
      label: { type: String, required: true, maxlength: 24 },
      description: { type: String, maxlength: 72, default: '' },
      nextKeyword: { type: String, required: true, lowercase: true, trim: true }
    }],
    default: [],
    validate: {
      validator: (arr) => arr.length <= 10,
      message: 'A rule can have at most 10 list options.'
    }
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
ruleSchema.index({ businessId: 1 });
ruleSchema.index({ businessId: 1, keyword: 1 });

module.exports = mongoose.model('Rule', ruleSchema);
