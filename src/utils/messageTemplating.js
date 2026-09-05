function applyMessageTemplate(text, business, customer) {
  if (!text) return text;
  let result = text.replace(/\{\{businessName\}\}/g, business.displayName || business.name || '');
  result = result.replace(/\{\{customerName\}\}/g, (customer?.name || '').trim() || 'there');
  result = result.replace(/\{\{businessAddress\}\}/g, business.address || '');
  result = result.replace(/\{\{businessHours\}\}/g, business.businessHours || '');
  return result;
}

function applyMessageTemplateWithFooter(text, business, customer) {
  const result = applyMessageTemplate(text, business, customer);
  if (result && business.footerMessage) {
    return `${result}\n\n${business.footerMessage}`;
  }
  return result;
}

module.exports = { applyMessageTemplate, applyMessageTemplateWithFooter };
