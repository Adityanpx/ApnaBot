/**
 * scripts/rotateEncryptionKey.js
 *
 * One-time migration to rotate ENCRYPTION_KEY. Every shop's `accessToken`
 * is decrypted with the OLD key and re-encrypted with the NEW key, using
 * the exact AES-256-CBC scheme in utils/crypto.js. Each write is verified
 * immediately (decrypt-with-new-key and compare) before moving to the next
 * shop, so a bad key never gets silently written.
 *
 * This does NOT touch Render's ENCRYPTION_KEY env var — that's a manual
 * step you do only after this script reports 100% success (see below).
 *
 * --- Usage (PowerShell) ---
 *
 * 1. Generate a new 32-character key (run once, save the output):
 *      node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
 *
 * 2. Dry run first — decrypts everything with the old key, re-encrypts
 *    in memory, verifies, but writes NOTHING to the database:
 *      $env:MONGODB_URI = 'your-connection-string'
 *      $env:OLD_ENCRYPTION_KEY = 'current 32-char key'
 *      $env:NEW_ENCRYPTION_KEY = 'new 32-char key from step 1'
 *      node scripts/rotateEncryptionKey.js --dry-run
 *
 * 3. If the dry run reports 0 failures, run it for real:
 *      node scripts/rotateEncryptionKey.js
 *
 * 4. Only after step 3 says "All shops migrated successfully" — update
 *    ENCRYPTION_KEY on Render to the NEW_ENCRYPTION_KEY value and let it
 *    redeploy. Every shop's token is now readable with the new key; the
 *    old key is no longer used anywhere.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');

const MONGODB_URI = process.env.MONGODB_URI;
const OLD_KEY = process.env.OLD_ENCRYPTION_KEY;
const NEW_KEY = process.env.NEW_ENCRYPTION_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

if (!MONGODB_URI || !OLD_KEY || !NEW_KEY) {
  console.error('Missing MONGODB_URI, OLD_ENCRYPTION_KEY, or NEW_ENCRYPTION_KEY env var.');
  process.exit(1);
}
if (OLD_KEY.length !== 32 || NEW_KEY.length !== 32) {
  console.error(`Both keys must be exactly 32 characters. OLD_ENCRYPTION_KEY is ${OLD_KEY.length}, NEW_ENCRYPTION_KEY is ${NEW_KEY.length}.`);
  process.exit(1);
}
if (OLD_KEY === NEW_KEY) {
  console.error('OLD_ENCRYPTION_KEY and NEW_ENCRYPTION_KEY are identical — nothing to rotate.');
  process.exit(1);
}

const algorithm = 'aes-256-cbc';
const ivLength = 16;

function decryptWith(keyString, encryptedText) {
  const key = Buffer.from(keyString, 'utf-8');
  const [ivHex, encrypted] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function encryptWith(keyString, text) {
  const key = Buffer.from(keyString, 'utf-8');
  const iv = crypto.randomBytes(ivLength);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

async function main() {
  console.log(DRY_RUN ? 'DRY RUN — no writes will be made.\n' : 'LIVE RUN — database will be updated.\n');

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const Shop = mongoose.connection.collection('shops');
  const shops = await Shop.find({ accessToken: { $exists: true, $ne: null } }).toArray();
  console.log(`Found ${shops.length} shop(s) with a stored accessToken.\n`);

  let succeeded = 0;
  const failures = [];

  for (const shop of shops) {
    const label = `${shop.name || 'Unnamed shop'} (${shop._id})`;
    try {
      const plainToken = decryptWith(OLD_KEY, shop.accessToken);
      const reEncrypted = encryptWith(NEW_KEY, plainToken);

      // Verify before writing anything: decrypting the new ciphertext with
      // the new key must reproduce the exact original plaintext.
      const verify = decryptWith(NEW_KEY, reEncrypted);
      if (verify !== plainToken) {
        throw new Error('Verification mismatch after re-encryption');
      }

      if (!DRY_RUN) {
        await Shop.updateOne({ _id: shop._id }, { $set: { accessToken: reEncrypted } });
      }

      console.log(`✔ ${label}`);
      succeeded++;
    } catch (err) {
      console.error(`✘ ${label} — ${err.message}`);
      failures.push({ id: shop._id, name: shop.name, error: err.message });
    }
  }

  console.log(`\n${succeeded}/${shops.length} shop(s) migrated successfully.`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} shop(s) FAILED — do not rotate ENCRYPTION_KEY on Render yet.`);
    console.error('Likely cause: that shop\'s accessToken was already encrypted with a different key, or is corrupted.');
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  } else if (DRY_RUN) {
    console.log('\nDry run clean. Re-run without --dry-run to apply for real.');
  } else {
    console.log('\nAll shops migrated successfully. You can now update ENCRYPTION_KEY on Render to NEW_ENCRYPTION_KEY\'s value and redeploy.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed to run:', err);
  process.exit(1);
});
