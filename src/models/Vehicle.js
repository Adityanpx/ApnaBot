const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  catalogId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'VehicleTypeCatalog',
    required: true
  },
  customName: {
    type: String,
    default: null
  },
  customPhotoUrl: {
    type: String,
    default: null
  },
  perKmRate: {
    type: Number,
    default: null
  },
  isActive: {
    type: Boolean,
    default: true
  },
  order: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

// Indexes
vehicleSchema.index({ businessId: 1 });
vehicleSchema.index({ businessId: 1, isActive: 1 });

module.exports = mongoose.model('Vehicle', vehicleSchema);
