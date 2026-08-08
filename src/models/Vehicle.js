const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema({
  shopId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
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
vehicleSchema.index({ shopId: 1 });
vehicleSchema.index({ shopId: 1, isActive: 1 });

module.exports = mongoose.model('Vehicle', vehicleSchema);
