function applyMessageTemplate(text, business, customer) {
  if (!text) return text;
  let result = text.replace(/\{\{businessName\}\}/g, business.displayName || business.name || '');
  result = result.replace(/\{\{customerName\}\}/g, (customer?.name || '').trim() || 'there');
  return result;
}

module.exports = { applyMessageTemplate };
