// src/scripts/updateTravelsFieldTranslations.js
//
// Adds labelTranslations (mr/hi) onto the 'travels' business_type_templates
// row's booking_fields — both on the field itself and on each of its
// options — so booking.service.js can localize choice questions
// (buttons/list fields) for customers whose preferred_language is 'mr' or
// 'hi'. English customers are unaffected: getLocalizedText() only consults
// labelTranslations when a languageCode is given AND a translation exists
// for it, and falls back to the original English label/option otherwise.
//
// businessTypeSeed.js skips creation when a 'travels' template already
// exists, so `npm run seed` will NOT backfill this onto an already-seeded
// template — this direct update is required instead (same reason
// src/scripts/updateCabBookingFields.js exists for the 'cab' template).
//
// Every field this script doesn't explicitly cover — and every key on the
// fields it does (fieldKey, order, required, summaryLabel, fieldType,
// option values) — is read from the DB and passed through unchanged; only
// labelTranslations is added/overwritten.
//
// *** The mr/hi strings below are TODO placeholders — Suresh will supply
// *** the real Marathi/Hindi text. Do not run this against production data
// *** until they're filled in.
//
// Usage:
//   node src/scripts/updateTravelsFieldTranslations.js
//
// Requires .env with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REDIS_URL (see src/config/env.js).

require('dotenv').config();
const supabase = require('../config/supabase');
const redis = require('../config/redis');

// Keyed by fieldKey -> { label: {mr, hi}, options: { <English option value>: {mr, hi} } }.
// Only fields listed here are touched; everything else on booking_fields is
// left exactly as stored. Covers the four choice (buttons/list) questions
// most worth translating first: tripType, travelDate, pickupTime, vehicleType.
const FIELD_TRANSLATIONS = {
  tripType: {
    label: {
      mr: 'TODO_MR: What type of trip? Reply: One Way / Round Trip / Local Rental',
      hi: 'TODO_HI: What type of trip? Reply: One Way / Round Trip / Local Rental'
    },
    options: {
      'One Way': { mr: 'TODO_MR: One Way', hi: 'TODO_HI: One Way' },
      'Round Trip': { mr: 'TODO_MR: Round Trip', hi: 'TODO_HI: Round Trip' },
      'Local Rental': { mr: 'TODO_MR: Local Rental', hi: 'TODO_HI: Local Rental' }
    }
  },
  travelDate: {
    label: {
      mr: 'TODO_MR: When do you need the vehicle?',
      hi: 'TODO_HI: When do you need the vehicle?'
    },
    options: {
      'Today': { mr: 'TODO_MR: Today', hi: 'TODO_HI: Today' },
      'Tomorrow': { mr: 'TODO_MR: Tomorrow', hi: 'TODO_HI: Tomorrow' },
      'Other date': { mr: 'TODO_MR: Other date', hi: 'TODO_HI: Other date' }
    }
  },
  pickupTime: {
    label: {
      mr: 'TODO_MR: What time should we pick you up?',
      hi: 'TODO_HI: What time should we pick you up?'
    },
    options: {
      'Morning (8-11 AM)': { mr: 'TODO_MR: Morning (8-11 AM)', hi: 'TODO_HI: Morning (8-11 AM)' },
      'Afternoon (12-4 PM)': { mr: 'TODO_MR: Afternoon (12-4 PM)', hi: 'TODO_HI: Afternoon (12-4 PM)' },
      'Other time': { mr: 'TODO_MR: Other time', hi: 'TODO_HI: Other time' }
    }
  },
  vehicleType: {
    label: {
      mr: "TODO_MR: Vehicle preference? Hatchback / Sedan / SUV / Luxury / Tempo / Mini Bus / Bus (or say 'any')",
      hi: "TODO_HI: Vehicle preference? Hatchback / Sedan / SUV / Luxury / Tempo / Mini Bus / Bus (or say 'any')"
    },
    options: {
      'Hatchback': { mr: 'TODO_MR: Hatchback', hi: 'TODO_HI: Hatchback' },
      'Sedan': { mr: 'TODO_MR: Sedan', hi: 'TODO_HI: Sedan' },
      'SUV': { mr: 'TODO_MR: SUV', hi: 'TODO_HI: SUV' },
      'Luxury': { mr: 'TODO_MR: Luxury', hi: 'TODO_HI: Luxury' },
      'Tempo': { mr: 'TODO_MR: Tempo', hi: 'TODO_HI: Tempo' },
      'Mini Bus': { mr: 'TODO_MR: Mini Bus', hi: 'TODO_HI: Mini Bus' },
      'Bus': { mr: 'TODO_MR: Bus', hi: 'TODO_HI: Bus' }
    }
  }
};

/**
 * Merge labelTranslations onto one option (string or {value, label, ...}
 * object form), keyed by the option's English value. Options with no entry
 * in fieldTranslations.options (or fields not in FIELD_TRANSLATIONS at all)
 * are returned unchanged.
 */
function translateOption(opt, fieldTranslations) {
  const value = typeof opt === 'string' ? opt : opt.value;
  const translations = fieldTranslations.options[value];
  if (!translations) {
    return opt;
  }
  const base = typeof opt === 'string' ? { value: opt, label: opt } : { ...opt };
  return { ...base, labelTranslations: translations };
}

function translateField(field) {
  const fieldTranslations = FIELD_TRANSLATIONS[field.fieldKey];
  if (!fieldTranslations) {
    return field;
  }
  return {
    ...field,
    labelTranslations: fieldTranslations.label,
    options: (field.options || []).map(opt => translateOption(opt, fieldTranslations))
  };
}

function logBookingFields(label, fields) {
  console.log(label);
  (fields || []).forEach((f) => {
    console.log(`  ${f.fieldKey}: labelTranslations=${JSON.stringify(f.labelTranslations || null)}`);
    (f.options || []).forEach((opt) => {
      if (typeof opt !== 'string' && opt.labelTranslations) {
        console.log(`    option ${opt.value}: labelTranslations=${JSON.stringify(opt.labelTranslations)}`);
      }
    });
  });
}

async function main() {
  const { data: template, error: findErr } = await supabase
    .from('business_type_templates')
    .select('id, booking_fields')
    .eq('business_category', 'travels')
    .maybeSingle();

  if (findErr) throw findErr;
  if (!template) {
    console.error("No 'travels' business_type_templates row found.");
    process.exit(1);
  }

  logBookingFields('Before:', template.booking_fields);

  const updatedBookingFields = (template.booking_fields || []).map(translateField);

  const { error: updateErr } = await supabase
    .from('business_type_templates')
    .update({ booking_fields: updatedBookingFields })
    .eq('id', template.id);

  if (updateErr) throw updateErr;

  logBookingFields('After:', updatedBookingFields);

  // Direct writes bypass the app's normal cache-clearing path. Businesses on
  // the 'travels' template are cached under tenant:{phoneNumberId} for up to
  // 1hr — we don't know their phoneNumberIds here, so flush all tenant:*
  // keys to be safe (same approach as updateCabBookingFields.js). In-flight
  // booking sessions are unaffected either way (session.fields is a snapshot
  // taken at startBookingSession time).
  console.log('\nFlushing tenant cache...');
  const keys = await redis.keys('tenant:*');
  if (keys.length > 0) {
    await redis.del(...keys);
    console.log(`Flushed ${keys.length} tenant:* key(s).`);
  } else {
    console.log('No tenant:* keys to flush.');
  }

  console.log('\nDone. Remember: the mr/hi strings written above are TODO placeholders —');
  console.log('replace them with real translations before this reaches production customers.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
