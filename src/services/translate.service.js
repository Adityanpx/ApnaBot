const Anthropic = require('@anthropic-ai/sdk');
const { LANGUAGE_CATALOG } = require('../utils/languageCatalog');
const logger = require('../utils/logger');

const MODEL = 'claude-sonnet-4-6';
const REQUEST_TIMEOUT_MS = 15000;

let client = null;
const getClient = () => {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    client = new Anthropic({ timeout: REQUEST_TIMEOUT_MS });
  }
  return client;
};

const isAvailable = () => getClient() !== null;

class TranslationUnavailableError extends Error {
  constructor() {
    super('Auto-translate is temporarily unavailable. You can still type translations manually.');
    this.name = 'TranslationUnavailableError';
  }
}

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g;

const extractPlaceholders = (text) => new Set((text || '').match(PLACEHOLDER_RE) || []);

const placeholderSetsMatch = (a, b) => {
  if (a.size !== b.size) return false;
  for (const p of a) {
    if (!b.has(p)) return false;
  }
  return true;
};

const buildSystemPrompt = ({ fields, targetLanguages, businessName }) => {
  const languageNames = targetLanguages
    .map(code => `${code} (${LANGUAGE_CATALOG[code]?.name || code})`)
    .join(', ');

  const fieldsBlock = fields.map(f => {
    const lenNote = f.maxLength ? ` [must fit within ${f.maxLength} characters]` : '';
    return `- id: "${f.id}"${lenNote}\n  text: "${f.text}"`;
  }).join('\n');

  return `You are translating short WhatsApp chatbot reply text for a small Indian business named "${businessName}" to talk to its own customers.

Translate the fields below into each of these target languages: ${languageNames}.

Rules:
- Use natural, conversational Indian usage appropriate for a small business messaging its customers on WhatsApp. Avoid stiff, overly formal, or overly literal translation.
- Any token of the form {{placeholder}} must be reproduced EXACTLY as-is: the double curly braces and the inner name must be unchanged, character for character. Never translate, transliterate, or otherwise alter a placeholder.
- Where a field lists a max character length, the translation MUST fit within that many characters. Prefer a shorter natural phrasing over a literal one that runs long.
- Respond with JSON only. No prose, no markdown code fences, no explanation before or after. The JSON must have exactly this shape:
  { "<languageCode>": { "<fieldId>": "<translated text>", ... }, ... }
  with one top-level key per target language code, and one entry per field id under each.

Fields to translate:
${fieldsBlock}`;
};

/**
 * Draft translations for rule reply/button/list text. Stateless - callers
 * are responsible for persisting anything the owner approves.
 *
 * @param {{ fields: {id: string, text: string, maxLength: number|null}[], targetLanguages: string[], businessName: string }} params
 * @returns {Promise<{ translations: object, warnings: {id: string, language: string, reason: string}[] }>}
 */
const translateFields = async ({ fields, targetLanguages, businessName }) => {
  const anthropic = getClient();
  if (!anthropic) {
    throw new Error('Translation service is not configured.');
  }

  const systemPrompt = buildSystemPrompt({ fields, targetLanguages, businessName });

  let response;
  try {
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Return the JSON translations now.' }]
    });
  } catch (error) {
    logger.error('translateFields: Anthropic API call failed', {
      message: error.message,
      status: error.status,
      request_id: error.request_id
    });
    throw new TranslationUnavailableError();
  }

  const textBlock = response.content?.find(block => block.type === 'text');
  const raw = textBlock?.text?.trim() || '';

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.error('translateFields: model response was not valid JSON:', error);
    throw new Error('Translation service returned an invalid response.');
  }

  const fieldsById = new Map(fields.map(f => [f.id, f]));
  const translations = {};
  const warnings = [];

  for (const lang of targetLanguages) {
    const langResult = parsed?.[lang];
    const langTranslations = {};

    if (langResult && typeof langResult === 'object') {
      for (const [fieldId, translatedText] of Object.entries(langResult)) {
        const field = fieldsById.get(fieldId);
        if (!field || typeof translatedText !== 'string' || !translatedText) continue;

        const sourcePlaceholders = extractPlaceholders(field.text);
        const translatedPlaceholders = extractPlaceholders(translatedText);

        if (!placeholderSetsMatch(sourcePlaceholders, translatedPlaceholders)) {
          warnings.push({
            id: fieldId,
            language: lang,
            reason: 'Placeholder mismatch - translation dropped.'
          });
          continue;
        }

        if (field.maxLength && translatedText.length > field.maxLength) {
          warnings.push({
            id: fieldId,
            language: lang,
            reason: `Translation is ${translatedText.length} characters, over the ${field.maxLength} character limit.`
          });
        }

        langTranslations[fieldId] = translatedText;
      }
    }

    translations[lang] = langTranslations;
  }

  return { translations, warnings };
};

module.exports = {
  translateFields,
  isAvailable,
  TranslationUnavailableError
};
