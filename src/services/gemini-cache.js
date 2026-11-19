const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');
const scraper = require('./scraper');
const { getSchedulingTools, buildSchedulingSystemPrompt } = require('./scheduling/tools');

// In-memory index: businessId → { cacheName, contentHash, model, expires }
const cacheIndex = new Map();

// Per-business creation locks to prevent duplicate concurrent cache creation
const creationLocks = new Map();

/**
 * Compute SHA-256 hash over the static content components for a business.
 * Used to detect when the cache needs recreation.
 */
function computeContentHash(systemPrompt, scrapedContext, schedulingPrompt, tools) {
  const parts = [
    systemPrompt || '',
    scrapedContext || '',
    schedulingPrompt || '',
    tools ? JSON.stringify(tools) : '',
  ];
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
}

/**
 * Build the static system instruction parts for a business.
 * These are the components that don't change between requests (no date/time,
 * no customer memory, no upcoming appointments).
 */
function buildStaticSystemParts(business) {
  const parts = [
    'Your name is Aiyelet (איילת). You are a friendly and professional female AI secretary/assistant working on behalf of the business described below. If asked your name, always say Aiyelet (איילת). Respond in the language the customer writes to you in. When communicating in Hebrew or Arabic, pay attention to the customer\'s gender. If you know the customer\'s gender from their memory profile, or can infer it from their name or how they conjugate verbs, use the appropriate grammatical gender when addressing them. If unknown, use masculine forms as is conventional.',
    business.system_prompt,
    '\nCRITICAL: Your reply must contain ONLY the message the customer will see. Never include internal thoughts, reasoning, analysis, strategy, or meta-commentary. Do not explain what you are about to do — just do it. Do not start with phrases like "THOUGHT:", "I need to", "This means", "Since the", etc.',
    '\nWhen you see messages prefixed with [Human agent replied], those were sent by a human team member, not you. Do not repeat or reference them as your own words.',
  ];

  const scrapedContext = scraper.assembleContext(business.id);
  if (scrapedContext) {
    parts.push(
      '\n\nBelow is structured content from the business website. Use it to answer questions:\n\n' +
        scrapedContext
    );
  } else if (business.scraped_data) {
    parts.push(
      '\n\nBelow is content scraped from the business website. Use it to answer questions:\n\n' +
        business.scraped_data
    );
  }

  const schedulingPrompt = buildSchedulingSystemPrompt(business);
  const hasScheduling = !!schedulingPrompt;

  const schedulingException = hasScheduling
    ? '\n- Appointment booking or scheduling requests — use the scheduling tools instead of escalating.'
    : '';
  parts.push(`\n\nIMPORTANT — Escalation rules:\nYou MUST try to help the customer yourself first using the information you have (system prompt, website content, conversation context${hasScheduling ? ', and scheduling tools' : ''}). Escalate with [ESCALATE] in these cases:\n1. The customer explicitly asks to speak with a human, manager, or representative.\n2. The customer asks about something specific you do not have information about (e.g. pricing, availability, specific services, policies not covered in your knowledge).${hasScheduling ? ' However, if the customer asks to book or schedule an appointment, use the scheduling tools (call get_services first) instead of escalating.' : ''}\n3. The customer has a complaint or issue you cannot resolve (e.g. billing dispute, technical problem, service issue).\n4. You cannot understand what the customer is asking — first politely ask the customer to rephrase or clarify their question. If after their clarification you still cannot understand what they need, escalate.\nDo NOT escalate for:\n- Greetings, general conversation, or questions you CAN answer from your knowledge.\n- Follow-up messages in an ongoing conversation where you are already helping.${schedulingException}\nWhen you do need to escalate, respond ONLY with:\n[ESCALATE] followed by a one-line reason in the same language the customer is using.\nDo not add any other text before or after the [ESCALATE] tag.\n\nOff-topic questions:\nIf the customer asks a question clearly unrelated to the business (e.g. general knowledge, trivia, math problems, personal opinions on world events), do NOT answer it and do NOT escalate. Instead, politely let them know you are here to help with the business\'s services and ask how you can assist them. Light conversation like greetings, pleasantries, and "how are you" is fine — only decline substantive off-topic questions.`);

  if (schedulingPrompt) {
    parts.push(schedulingPrompt);
  }

  const tools = getSchedulingTools(business);

  return { systemInstruction: parts.join(''), scrapedContext, schedulingPrompt, tools };
}

/**
 * Get or create a Gemini cached content for a business.
 * Returns { cacheName } on success, or null on failure/disabled.
 */
async function getOrCreateCache(genAI, business) {
  if (!config.geminiCacheEnabled || !genAI) return null;

  const businessId = business.id;
  const model = business.gemini_model || config.defaultGeminiModel;

  const { systemInstruction, tools } = buildStaticSystemParts(business);
  const contentHash = computeContentHash(systemInstruction, null, null, tools);

  // Check local index for valid cache
  const existing = cacheIndex.get(businessId);
  if (existing && existing.contentHash === contentHash && existing.model === model && existing.expires > Date.now()) {
    return { cacheName: existing.cacheName };
  }

  // Acquire per-business lock to prevent duplicate creation
  if (creationLocks.has(businessId)) {
    try {
      await creationLocks.get(businessId);
      // Re-check after awaiting — another call may have created it
      const afterLock = cacheIndex.get(businessId);
      if (afterLock && afterLock.contentHash === contentHash && afterLock.model === model && afterLock.expires > Date.now()) {
        return { cacheName: afterLock.cacheName };
      }
    } catch (_) {
      // Previous creation failed, proceed to try again
    }
  }

  const createPromise = (async () => {
    try {
      const cacheConfig = {
        model,
        config: {
          systemInstruction,
          ...(tools && { tools }),
        },
        ttl: `${config.geminiCacheTtlSeconds}s`,
      };

      const cache = await genAI.caches.create(cacheConfig);

      const entry = {
        cacheName: cache.name,
        contentHash,
        model,
        expires: Date.now() + config.geminiCacheTtlSeconds * 1000,
      };
      cacheIndex.set(businessId, entry);

      logger.info({ businessId, cacheName: cache.name, model }, 'Gemini cache created');
      return { cacheName: cache.name };
    } catch (err) {
      logger.warn({ businessId, error: err.message }, 'Failed to create Gemini cache — falling back to non-cached path');
      // Remove stale index entry if hash doesn't match
      if (existing && existing.contentHash !== contentHash) {
        cacheIndex.delete(businessId);
      }
      return null;
    } finally {
      creationLocks.delete(businessId);
    }
  })();

  creationLocks.set(businessId, createPromise);
  return createPromise;
}

/**
 * Remove a business from the local cache index.
 * The Gemini-side cache expires via its TTL naturally.
 */
function markInvalid(businessId) {
  cacheIndex.delete(businessId);
}

/**
 * Clear the entire local cache index.
 */
function markAllInvalid() {
  cacheIndex.clear();
}

// Exposed for testing
function _getCacheIndex() {
  return cacheIndex;
}

module.exports = {
  computeContentHash,
  buildStaticSystemParts,
  getOrCreateCache,
  markInvalid,
  markAllInvalid,
  _getCacheIndex,
};
