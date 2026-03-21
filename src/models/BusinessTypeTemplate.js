const mongoose = require('mongoose');

const businessTypeTemplateSchema = new mongoose.Schema({
  businessType: {
    type: String,
    required: true,
    unique: true,
    enum: ['tailor', 'salon', 'garage', 'cab', 'coaching', 'gym', 'medical', 'general']
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
      required: {
        type: Boolean,
        default: true
      },
      order: {
        type: Number,
        required: true
      }
    }
  ]
}, { timestamps: true });

// Note: businessType already has unique:true in schema definition

module.exports = mongoose.model('BusinessTypeTemplate', businessTypeTemplateSchema);
