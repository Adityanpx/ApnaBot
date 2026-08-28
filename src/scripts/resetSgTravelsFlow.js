// src/scripts/resetSgTravelsFlow.js
//
// One-time reset for SG Travels under the new business_flows model: clears
// its bookings, messages, and customers, then re-copies the current
// 'travels' business_type_templates row (default_rules + booking_fields)
// into a fresh business_flows row for it — so it starts clean instead of
// carrying over whatever it had accumulated under the old model.
//
// Does NOT touch the `rules` table (the chatbot engine's live keyword
// replies) or business_type_templates itself — only bookings, messages,
// customers, and this business's business_flows row, per the requested scope.
//
// Dry-run by default (prints what it would do). Pass --confirm to execute.
//
// Usage:
//   node src/scripts/resetSgTravelsFlow.js            (dry run)
//   node src/scripts/resetSgTravelsFlow.js --confirm   (executes)
//
// Requires .env with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see src/config/env.js).

require('dotenv').config();
const supabase = require('../config/supabase');

const CONFIRM = process.argv.includes('--confirm');

async function main() {
  const { data: candidates, error: findErr } = await supabase
    .from('businesses')
    .select('id, name, business_category')
    .ilike('name', '%SG Travels%');
  if (findErr) throw findErr;

  if (!candidates || candidates.length === 0) {
    console.error('No business found with name matching "%SG Travels%". Aborting.');
    process.exit(1);
  }
  if (candidates.length > 1) {
    console.error('Multiple businesses match "%SG Travels%" — refusing to guess. Candidates:');
    candidates.forEach(b => console.error(`  ${b.id}  ${b.name}  (${b.business_category})`));
    process.exit(1);
  }

  const business = candidates[0];
  console.log(`Found business: ${business.name} (${business.id}), category: ${business.business_category}`);

  const { count: bookingCount, error: bookingCountErr } = await supabase
    .from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', business.id);
  if (bookingCountErr) throw bookingCountErr;
  const { count: messageCount, error: messageCountErr } = await supabase
    .from('messages').select('id', { count: 'exact', head: true }).eq('business_id', business.id);
  if (messageCountErr) throw messageCountErr;
  const { count: customerCount, error: customerCountErr } = await supabase
    .from('customers').select('id', { count: 'exact', head: true }).eq('business_id', business.id);
  if (customerCountErr) throw customerCountErr;

  const { data: template, error: templateErr } = await supabase
    .from('business_type_templates')
    .select('default_rules, booking_fields')
    .eq('business_category', 'travels')
    .maybeSingle();
  if (templateErr) throw templateErr;
  if (!template) {
    console.error("No 'travels' business_type_templates row found. Aborting.");
    process.exit(1);
  }

  console.log(`Would delete: ${bookingCount || 0} booking(s), ${messageCount || 0} message(s), ${customerCount || 0} customer(s).`);
  console.log(`Would replace business_flows with: ${(template.default_rules || []).length} rule(s), ${(template.booking_fields || []).length} booking field(s) from the 'travels' template.`);

  if (!CONFIRM) {
    console.log('\nDry run only — pass --confirm to execute.');
    process.exit(0);
  }

  // Delete order respects FK references: messages/bookings reference
  // customers(id) with no cascade, so they must go first.
  const { error: msgDelErr } = await supabase.from('messages').delete().eq('business_id', business.id);
  if (msgDelErr) throw msgDelErr;
  console.log(`Deleted ${messageCount || 0} message(s).`);

  const { error: bookingDelErr } = await supabase.from('bookings').delete().eq('business_id', business.id);
  if (bookingDelErr) throw bookingDelErr;
  console.log(`Deleted ${bookingCount || 0} booking(s).`);

  const { error: customerDelErr } = await supabase.from('customers').delete().eq('business_id', business.id);
  if (customerDelErr) throw customerDelErr;
  console.log(`Deleted ${customerCount || 0} customer(s).`);

  const { error: flowDelErr } = await supabase.from('business_flows').delete().eq('business_id', business.id);
  if (flowDelErr) throw flowDelErr;

  const { error: flowInsertErr } = await supabase.from('business_flows').insert({
    business_id: business.id,
    rules: template.default_rules || [],
    booking_fields: template.booking_fields || []
  });
  if (flowInsertErr) throw flowInsertErr;
  console.log('Created fresh business_flows row from the current travels template.');

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Reset failed:', err);
  process.exit(1);
});
