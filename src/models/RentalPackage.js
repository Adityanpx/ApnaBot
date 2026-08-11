const mongoose = require('mongoose');

const rentalPackageSchema = new mongoose.Schema({
  shopId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true
  },
  vehicleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vehicle',
    required: true
  },
  packageKey: {
    type: String,
    enum: ['6HR_60KM', '8HR_80KM', '10HR_100KM', 'ENGAGE_12HR', 'ENGAGE_24HR'],
    required: true
  },
  label: {
    type: String,
    default: null
  },
  price: {
    type: Number,
    required: true
  },
  extraKmRate: {
    type: Number,
    default: null
  },
  extraHrRate: {
    type: Number,
    default: null
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

// Indexes
rentalPackageSchema.index({ shopId: 1 });
rentalPackageSchema.index({ shopId: 1, vehicleId: 1, packageKey: 1 });

module.exports = mongoose.model('RentalPackage', rentalPackageSchema);
