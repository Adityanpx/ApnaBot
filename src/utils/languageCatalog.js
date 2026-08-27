// Fixed, hardcoded catalog for v1 - not DB-driven. Extending language
// support later means adding an entry here, not a migration.
const LANGUAGE_CATALOG = {
  en: { name: 'English' },
  hi: { name: 'हिंदी' },
  mr: { name: 'मराठी' }
};

const isValidLanguageCode = (code) => Object.prototype.hasOwnProperty.call(LANGUAGE_CATALOG, code);

module.exports = { LANGUAGE_CATALOG, isValidLanguageCode };
