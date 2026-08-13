const mongoose = require('mongoose');

const routeFareSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  fromCity: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  toCity: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  tripType: {
    type: String,
    enum: ['oneway', 'round_trip', 'outstation', 'local'],
    default: 'oneway'
  },
  vehicleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vehicle',
    required: true
  },
  fare: {
    type: Number,
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

// Indexes
routeFareSchema.index({ businessId: 1 });
routeFareSchema.index(
  { businessId: 1, fromCity: 1, toCity: 1, tripType: 1, vehicleId: 1 },
  { unique: true }
);

module.exports = mongoose.model('RouteFare', routeFareSchema);
