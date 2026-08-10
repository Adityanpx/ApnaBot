// Stage 1 of the shop -> business rename (see docs/SHOP_TO_BUSINESS_MIGRATION.md).
// 'Business' is purely an alias for the existing Shop model: same schema, same
// Mongoose model, same underlying collection, same data. It exists so new code
// can start importing 'Business' instead of 'Shop' without any data migration.
// Do NOT diverge this file from Shop.js — Stage 2+ will do the full mechanical
// rename (schema/model/collection/fields) later.
const Shop = require('./Shop');

module.exports = Shop;
