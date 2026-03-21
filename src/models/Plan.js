const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  displayName: {
    type: String,
    required: true
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  msgLimit: {
    type: Number,
    required: true,
    default: -1
  },
  ruleLimit: {
    type: Number,
    required: true,
    default: -1
  },
  customerLimit: {
    type: Number,
    required: true,
    default: -1
  },
  bookingEnabled: {
    type: Boolean,
    default: true
  },
  paymentLinkEnabled: {
    type: Boolean,
    default: false
  },
  staffEnabled: {
    type: Boolean,
    default: false
  },
  maxStaff: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

module.exports = mongoose.model('Plan', planSchema);
