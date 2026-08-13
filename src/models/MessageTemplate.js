const mongoose = require('mongoose');

const messageTemplateSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  category: {
    type: String,
    enum: ['MARKETING', 'UTILITY'],
    default: 'MARKETING'
  },
  language: {
    type: String,
    default: 'en'
  },
  bodyText: {
    type: String,
    required: true
  },
  variableCount: {
    type: Number,
    default: 0
  },
  metaTemplateId: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['draft', 'pending', 'approved', 'rejected'],
    default: 'draft'
  },
  rejectionReason: {
    type: String,
    default: null
  },
  submittedAt: {
    type: Date,
    default: null
  },
  reviewedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

// Indexes
messageTemplateSchema.index({ businessId: 1 });
messageTemplateSchema.index({ businessId: 1, status: 1 });

module.exports = mongoose.model('MessageTemplate', messageTemplateSchema);
