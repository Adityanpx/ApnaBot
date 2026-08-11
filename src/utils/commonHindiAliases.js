/**
 * Seed dictionary of common Hindi/Hinglish phrases grouped by universal
 * concept categories (not tied to any specific shop's rule keywords).
 *
 * Not wired into matching — this is a reference list a seed script or
 * onboarding flow can use to pre-suggest hindiAliases values to shop
 * owners when they create a rule for a given concept.
 */
module.exports = {
  price: ['kimat', 'keemat', 'daam', 'rate', 'rate kya hai', 'kitna paisa', 'kitna hai', 'price kya hai'],
  booking: ['book karna hai', 'booking karni hai', 'booking kaise kare', 'slot book karna hai'],
  location: ['kaha hai', 'address kya hai', 'location kya hai', 'kaha par ho'],
  timing: ['kitne baje', 'time kya hai', 'kab khulta hai', 'kab band hota hai'],
  contact: ['number kya hai', 'contact kya hai', 'phone number do'],
  availability: ['available hai kya', 'stock hai kya', 'hai kya'],
  greeting: ['namaste', 'namaskar', 'kaise ho'],
  thanks: ['dhanyavaad', 'shukriya', 'thank you bhai']
};
