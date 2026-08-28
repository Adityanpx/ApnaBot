const { isValidLanguageCode } = require('./languageCatalog');

/**
 * Validates a labelTranslations map ({ languageCode: text }) on a booking
 * field or option. Returns an error message naming the offending language
 * code, or null if valid. 'en' is rejected — translations are only for
 * non-English languages, the field/option's own label/value carries English.
 */
const validateLabelTranslations = (translations, fieldLabel) => {
  if (translations === null || translations === undefined) return null;
  if (typeof translations !== 'object' || Array.isArray(translations)) {
    return `${fieldLabel} must be an object.`;
  }
  for (const [code, value] of Object.entries(translations)) {
    if (code === 'en' || !isValidLanguageCode(code)) {
      return `${fieldLabel} has an invalid language code "${code}".`;
    }
    if (typeof value !== 'string') {
      return `${fieldLabel} values must be strings.`;
    }
  }
  return null;
};

module.exports = { validateLabelTranslations };
