const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
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
  status: {
    type: String,
    required: true,
    enum: ['pending', 'confirmed', 'completed', 'cancelled'],
    default: 'pending'
  },
  bookingCode: {
    type: String,
    default: null
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
bookingSchema.index({ businessId: 1 });
bookingSchema.index({ businessId: 1, status: 1 });
bookingSchema.index({ businessId: 1, createdAt: -1 });
bookingSchema.index({ customerId: 1 });

module.exports = mongoose.model('Booking', bookingSchema);
