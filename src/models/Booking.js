const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
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
  status: {
    type: String,
    required: true,
    enum: ['pending', 'confirmed', 'completed', 'cancelled'],
    default: 'pending'
  },
  fields: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'not_required'],
    default: 'not_required'
  },
  paymentAmount: {
    type: Number,
    default: 0
  },
  paymentLink: {
    type: String,
    default: null
  },
  razorpayOrderId: {
    type: String,
    default: null
  },
  upiLink: {
    type: String,
    default: null
  },
  paymentId: {
    type: String,
    default: null
  },
  paymentDetails: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  }
}, { timestamps: true });

// Indexes
bookingSchema.index({ shopId: 1 });
bookingSchema.index({ shopId: 1, status: 1 });
bookingSchema.index({ shopId: 1, createdAt: -1 });
bookingSchema.index({ customerId: 1 });

module.exports = mongoose.model('Booking', bookingSchema);
