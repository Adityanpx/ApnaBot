/**
 * scripts/renameShopToBusiness.js
 *
 * Database-level migration for the shop -> business terminology rename.
 *
 * ****************************************************************************
 * * MUST BE RUN BEFORE DEPLOYING THE CORRESPONDING CODE RENAME.             *
 * *                                                                          *
 * * This script renames fields/collections/indexes directly in MongoDB so   *
 * * that renamed application code (shopId -> businessId, Shop -> Business,  *
 * * businessType -> businessCategory, etc.) finds the data already in its   *
 * * new shape when it deploys. Running the code rename first — before this  *
 * * script — will break the app, since the old code reads/writes the old    *
 * * field and collection names.                                            *
 * *                                                                          *
 * * SIDE EFFECT: this invalidates live state that embeds the old field      *
 * * names.                                                                  *
 * *   - Active booking sessions held in Redis (booking_session:*) key off   *
 * *     data shaped around shopId; users mid-booking will need to restart.  *
 * *   - Logged-in JWTs that carry a shopId claim will no longer resolve     *
 * *     correctly once shopId is renamed to businessId at the DB layer;     *
 * *     affected users will need to log in again.                          *
 * * Plan a maintenance window / expect a wave of re-logins and restarted    *
 * * booking flows after running this.                                      *
 * ****************************************************************************
 *
 * --- What this does (in order) ---
 *   a. Renames field shopId -> businessId on every collection that has it:
 *      bookings, broadcasts, customers, messages, messagetemplates,
 *      rentalpackages, routefares, rules, subscriptions, usages, users,
 *      vehicles.
 *   b. Renames field businessType -> businessCategory on the shops and
 *      businesstypetemplates collections.
 *   c. Renames the shops collection itself to businesses.
 *   d. Drops old indexes that reference shopId on each collection from (a)
 *      and lets the app recreate the new indexes on next boot (this script
 *      does not hand-create any new indexes).
 *   e. Flushes Redis keys whose names embed shopId/shop terminology:
 *      subscription:*, rules:*, usage:*, distance:*, booking_session:*,
 *      tenant:*.
 *
 * Every step is idempotent: if a field/collection has already been renamed,
 * that step is logged as skipped rather than erroring, so this script is
 * safe to re-run (e.g. after a partial failure).
 *
 * --- Usage (PowerShell) ---
 *
 *   $env:MONGODB_URI = 'your-connection-string'
 *   $env:REDIS_URL = 'your-redis-url'
 *
 *   # Dry run (default) — logs exactly what would change, writes nothing:
 *   node scripts/renameShopToBusiness.js
 *   node scripts/renameShopToBusiness.js --dry-run
 *
 *   # Apply for real:
 *   node scripts/renameShopToBusiness.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Redis } = require('ioredis');

// Requiring the models (rather than hardcoding collection name strings)
// verifies the actual collection names via mongoose's pluralization instead
// of assuming them.
const Booking = require('../src/models/Booking');
const Broadcast = require('../src/models/Broadcast');
const Customer = require('../src/models/Customer');
const Message = require('../src/models/Message');
const MessageTemplate = require('../src/models/MessageTemplate');
const RentalPackage = require('../src/models/RentalPackage');
const RouteFare = require('../src/models/RouteFare');
const Rule = require('../src/models/Rule');
const Subscription = require('../src/models/Subscription');
const Usage = require('../src/models/Usage');
const User = require('../src/models/User');
const Vehicle = require('../src/models/Vehicle');
const Shop = require('../src/models/Shop');
const BusinessTypeTemplate = require('../src/models/BusinessTypeTemplate');

const SHOP_ID_COLLECTIONS = [
  Booking,
  Broadcast,
  Customer,
  Message,
  MessageTemplate,
  RentalPackage,
  RouteFare,
  Rule,
  Subscription,
  Usage,
  User,
  Vehicle,
].map((Model) => Model.collection.name);

const SHOPS_COLLECTION = Shop.collection.name; // 'shops'
const BUSINESS_TYPE_TEMPLATES_COLLECTION = BusinessTypeTemplate.collection.name; // 'businesstypetemplates'
const BUSINESSES_COLLECTION = 'businesses';

const REDIS_KEY_PATTERNS = [
  'subscription:*',
  'rules:*',
  'usage:*',
  'distance:*',
  'booking_session:*',
  'tenant:*',
];

const MONGODB_URI = process.env.MONGODB_URI;
const REDIS_URL = process.env.REDIS_URL;
const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;

if (!MONGODB_URI || !REDIS_URL) {
  console.error('Missing MONGODB_URI or REDIS_URL env var.');
  process.exit(1);
}

async function renameFieldEverywhere(db, collectionName, oldField, newField) {
  const collection = db.collection(collectionName);
  const matching = await collection.countDocuments({ [oldField]: { $exists: true } });

  if (matching === 0) {
    console.log(`  [skip] ${collectionName}: no documents with "${oldField}" (already renamed or empty).`);
    return { collection: collectionName, matched: 0, updated: 0 };
  }

  console.log(`  [${DRY_RUN ? 'would update' : 'updating'}] ${collectionName}: ${matching} document(s) with "${oldField}" -> "${newField}".`);

  if (DRY_RUN) {
    return { collection: collectionName, matched: matching, updated: 0 };
  }

  const result = await collection.updateMany({ [oldField]: { $exists: true } }, { $rename: { [oldField]: newField } });
  console.log(`  [done] ${collectionName}: ${result.modifiedCount} document(s) updated.`);
  return { collection: collectionName, matched: matching, updated: result.modifiedCount };
}

async function dropShopIdIndexes(db, collectionName) {
  const collection = db.collection(collectionName);
  const indexes = await collection.indexes();
  const staleIndexes = indexes.filter((idx) => Object.prototype.hasOwnProperty.call(idx.key, 'shopId'));

  if (staleIndexes.length === 0) {
    console.log(`  [skip] ${collectionName}: no indexes reference "shopId".`);
    return [];
  }

  const names = staleIndexes.map((idx) => idx.name);
  console.log(`  [${DRY_RUN ? 'would drop' : 'dropping'}] ${collectionName}: index(es) ${names.join(', ')}.`);

  if (!DRY_RUN) {
    for (const name of names) {
      await collection.dropIndex(name);
    }
  }

  return names.map((name) => `${collectionName}.${name}`);
}

async function renameShopsCollection(db) {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  const names = new Set(collections.map((c) => c.name));

  if (!names.has(SHOPS_COLLECTION)) {
    if (names.has(BUSINESSES_COLLECTION)) {
      console.log(`  [skip] "${SHOPS_COLLECTION}" collection not found, "${BUSINESSES_COLLECTION}" already exists (already renamed).`);
    } else {
      console.log(`  [skip] Neither "${SHOPS_COLLECTION}" nor "${BUSINESSES_COLLECTION}" collection exists — nothing to rename.`);
    }
    return false;
  }

  if (names.has(BUSINESSES_COLLECTION)) {
    console.error(`  [error] Both "${SHOPS_COLLECTION}" and "${BUSINESSES_COLLECTION}" collections exist. Refusing to rename automatically — resolve manually.`);
    throw new Error(`Both ${SHOPS_COLLECTION} and ${BUSINESSES_COLLECTION} exist`);
  }

  console.log(`  [${DRY_RUN ? 'would rename' : 'renaming'}] "${SHOPS_COLLECTION}" -> "${BUSINESSES_COLLECTION}".`);

  if (!DRY_RUN) {
    await db.collection(SHOPS_COLLECTION).rename(BUSINESSES_COLLECTION);
  }

  return true;
}

async function scanDeletePattern(redis, pattern) {
  let cursor = '0';
  let matched = 0;
  let deleted = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = nextCursor;

    if (keys.length > 0) {
      matched += keys.length;
      if (!DRY_RUN) {
        deleted += await redis.unlink(...keys);
      }
    }
  } while (cursor !== '0');

  return { pattern, matched, deleted };
}

async function main() {
  console.log(DRY_RUN ? 'DRY RUN — no writes will be made. Pass --apply to run for real.\n' : 'LIVE RUN — database and cache will be modified.\n');

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');
  const db = mongoose.connection.db;

  console.log(`\nStep a: rename field shopId -> businessId (${SHOP_ID_COLLECTIONS.length} collections)`);
  const fieldRenameResults = [];
  for (const collectionName of SHOP_ID_COLLECTIONS) {
    fieldRenameResults.push(await renameFieldEverywhere(db, collectionName, 'shopId', 'businessId'));
  }

  console.log('\nStep b: rename field businessType -> businessCategory (shops, businesstypetemplates)');
  const businessTypeRenameResults = [];
  businessTypeRenameResults.push(await renameFieldEverywhere(db, SHOPS_COLLECTION, 'businessType', 'businessCategory'));
  businessTypeRenameResults.push(await renameFieldEverywhere(db, BUSINESS_TYPE_TEMPLATES_COLLECTION, 'businessType', 'businessCategory'));

  console.log('\nStep c: rename shops collection -> businesses');
  const collectionRenamed = await renameShopsCollection(db);

  console.log('\nStep d: drop stale shopId indexes');
  let droppedIndexes = [];
  for (const collectionName of SHOP_ID_COLLECTIONS) {
    droppedIndexes = droppedIndexes.concat(await dropShopIdIndexes(db, collectionName));
  }

  console.log('\nStep e: flush Redis keys embedding shopId/shop terminology');
  const redis = new Redis(REDIS_URL, {
    tls: REDIS_URL.startsWith('rediss://') ? {} : undefined,
  });

  const redisResults = [];
  for (const pattern of REDIS_KEY_PATTERNS) {
    const result = await scanDeletePattern(redis, pattern);
    console.log(`  [${DRY_RUN ? 'would delete' : 'deleted'}] ${pattern}: ${DRY_RUN ? result.matched : result.deleted} key(s).`);
    redisResults.push(result);
  }

  console.log(`\n${DRY_RUN ? '=== DRY RUN SUMMARY ===' : '=== SUMMARY ==='}`);
  console.log('\nDocuments updated (shopId -> businessId):');
  for (const r of fieldRenameResults) {
    console.log(`  ${r.collection}: ${DRY_RUN ? r.matched + ' would be updated' : r.updated + ' updated'}`);
  }
  console.log('\nDocuments updated (businessType -> businessCategory):');
  for (const r of businessTypeRenameResults) {
    console.log(`  ${r.collection}: ${DRY_RUN ? r.matched + ' would be updated' : r.updated + ' updated'}`);
  }
  console.log(`\nCollection rename (shops -> businesses): ${collectionRenamed ? (DRY_RUN ? 'would rename' : 'renamed') : 'skipped'}`);
  console.log(`\nIndexes ${DRY_RUN ? 'that would be dropped' : 'dropped'} (${droppedIndexes.length}):`);
  droppedIndexes.forEach((name) => console.log(`  ${name}`));
  console.log('\nRedis keys:');
  for (const r of redisResults) {
    console.log(`  ${r.pattern}: ${DRY_RUN ? r.matched + ' would be deleted' : r.deleted + ' deleted'}`);
  }

  redis.disconnect();
  await mongoose.disconnect();

  console.log(DRY_RUN ? '\nDry run complete. Re-run with --apply to make these changes.' : '\nMigration complete.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
