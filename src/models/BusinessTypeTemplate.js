const mongoose = require('mongoose');

const businessTypeTemplateSchema = new mongoose.Schema({
  businessCategory: {
    type: String,
    required: true,
    unique: true,
    enum: ['tailor', 'salon', 'garage', 'cab', 'coaching', 'gym', 'medical', 'general', 'photographer', 'caterer', 'tutor', 'jeweller', 'boutique', 'grocery', 'bakery', 'electronics_repair', 'real_estate', 'driving_school', 'travels']
  },
  defaultRules: [
    {
      keyword: {
        type: String,
        required: true
      },
      matchType: {
        type: String,
        enum: ['exact', 'contains', 'startsWith'],
        default: 'contains'
      },
      reply: {
        type: String,
        required: true
      },
      replyType: {
        type: String,
        enum: ['text', 'booking_trigger', 'payment_trigger'],
        default: 'text'
      }
    }
  ],
  bookingFields: [
    {
      fieldKey: {
        type: String,
        required: true
      },
      label: {
        type: String,
        required: true
      },
      summaryLabel: {
        type: String,
        default: null
      },
      required: {
        type: Boolean,
        default: true
      },
      order: {
        type: Number,
        required: true
      },
      fieldType: {
        type: String,
        enum: ['text', 'buttons', 'list'],
        default: 'text'
      },
      options: {
        type: [String],
        default: []
      }
    }
  ]
}, { timestamps: true });

// Note: businessCategory already has unique:true in schema definition

module.exports = mongoose.model('BusinessTypeTemplate', businessTypeTemplateSchema);
