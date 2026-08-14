const mongoose = require('mongoose');

const flowPackSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  category: {
    type: String,
    required: true,
    enum: ['tailor', 'salon', 'garage', 'cab', 'coaching', 'gym', 'medical', 'general', 'photographer', 'caterer', 'tutor', 'jeweller', 'boutique', 'grocery', 'bakery', 'electronics_repair', 'real_estate', 'driving_school', 'travels', 'any']
  },
  isActive: {
    type: Boolean,
    default: true
  },
  rules: [
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
      hindiAliases: {
        type: [String],
        default: []
      },
      reply: {
        type: String,
        required: true
      },
      replyType: {
        type: String,
        enum: ['text', 'booking_trigger', 'payment_trigger'],
        default: 'text'
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
      }
    }
  ],
  order: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

module.exports = mongoose.model('FlowPack', flowPackSchema);
