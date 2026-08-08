const mongoose = require('mongoose');

const vehicleTypeCatalogSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    required: true,
    enum: ['hatchback', 'sedan', 'suv', 'tempo_traveller', 'mini_bus', 'bus', 'other'],
    default: 'sedan'
  },
  photoUrl: {
    type: String,
    default: null
  },
  seats: {
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
vehicleTypeCatalogSchema.index({ isActive: 1, order: 1 });

module.exports = mongoose.model('VehicleTypeCatalog', vehicleTypeCatalogSchema);
