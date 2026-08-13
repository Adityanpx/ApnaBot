const mongoose = require('mongoose');

const rentalPackageSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
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
rentalPackageSchema.index({ businessId: 1 });
rentalPackageSchema.index({ businessId: 1, vehicleId: 1, packageKey: 1 });

module.exports = mongoose.model('RentalPackage', rentalPackageSchema);
