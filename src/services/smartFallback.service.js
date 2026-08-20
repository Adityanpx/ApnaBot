const Anthropic = require('@anthropic-ai/sdk');
const chatbotService = require('./chatbot.service');
const businessService = require('./business.service');
const logger = require('../utils/logger');

const MODEL = 'claude-sonnet-4-6';
const REQUEST_TIMEOUT_MS = 3500;

let client = null;
const getClient = () => {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    client = new Anthropic({ timeout: REQUEST_TIMEOUT_MS });
  }
  return client;
};

/**
 * Generate an AI-assisted fallback reply when no rule matched the customer's
 * message. Either points the customer at the closest matching rule keyword,
 * or gives a brief, generic, non-committal acknowledgment. Never invents
 * prices, policies, or facts that aren't in the business's own rule list.
 *
 * @param {string} businessId
 * @param {string} customerMessage
 * @returns {Promise<string|null>} generated reply, or null on any failure
 */
const getSmartFallbackReply = async (businessId, customerMessage) => {
  try {
    const anthropic = getClient();
    if (!anthropic) return null;

    const [rules, business] = await Promise.all([
      chatbotService.getRulesFromCache(businessId),
      businessService.getBusinessById(businessId)
    ]);

    if (!business) return null;

    const activeRules = (rules || []).filter(rule => rule.isActive);
    const ruleSummaries = activeRules.map(rule => {
      const label = (rule.reply || '').slice(0, 40).replace(/\s+/g, ' ').trim();
      return `- "${rule.keyword}": ${label}`;
    });

    const rulesBlock = ruleSummaries.length > 0
      ? ruleSummaries.join('\n')
      : '(no keyword rules configured)';

    const systemPrompt = `You are helping a WhatsApp chatbot for a small Indian business reply to a customer whose message didn't match any of the business's configured keyword rules.

Business name: ${business.name}
Business type: ${business.businessCategory}

The ONLY facts you may reference are these keyword rules (keyword: short label of what replying with that keyword gets the customer):
${rulesBlock}

Instructions:
- If the customer's message plausibly matches the intent behind one of these keywords, reply with a short, friendly message suggesting that exact keyword. For example: "For pricing info, just reply 'price'!"
- If nothing plausibly matches, give a brief, generic, friendly acknowledgment WITHOUT inventing any facts, prices, timings, addresses, or policies — something like "Thanks for reaching out! Could you tell me a bit more, or try one of our menu options?"
- Hard constraint: never state a price, timing, address, or policy that isn't verbatim in the rule list above.
- Keep the reply short — this is a WhatsApp message, not an essay.`;

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: 'user', content: customerMessage || '' }]
    });

    const textBlock = response.content?.find(block => block.type === 'text');
    const text = textBlock?.text?.trim();

    return text || null;
  } catch (error) {
    logger.error('Error in getSmartFallbackReply:', error);
    return null;
  }
};

module.exports = {
  getSmartFallbackReply
};
