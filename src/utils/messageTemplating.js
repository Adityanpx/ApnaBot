function applyMessageTemplate(text, business) {
  if (!text) return text;
  return text.replace(/\{\{businessName\}\}/g, business.displayName || business.name || '');
}

module.exports = { applyMessageTemplate };
