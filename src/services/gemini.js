const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const logger = require('../logger');
const db = require('./db');
const { executeSchedulingFunction, buildSchedulingSystemPrompt } = require('./scheduling/tools');
const scheduling = require('./scheduling');
const geminiCache = require('./gemini-cache');
const { canAccess } = require('../middleware/plan-gate');

if (!config.geminiApiKey) {
  logger.warn('GEMINI_API_KEY not set — AI responses will fail');
}

const genAI = config.geminiApiKey ? new GoogleGenAI({ apiKey: config.geminiApiKey }) : null;

// Per-business rate limiting: businessId → { count, windowStart }
const businessRateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkBusinessRateLimit(business) {
  const now = Date.now();
  const limit = config.geminiRateLimitPerBusiness;
  const entry = businessRateLimits.get(business.id);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    businessRateLimits.set(business.id, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= limit) {
    return false;
  }

  entry.count++;
  return true;
}

function isRetryable(err) {
  if (err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') return true;
  const status = err.status || err.httpCode || (err.response && err.response.status);
  return status === 429 || status === 503;
}

async function withRetry(fn, { retries = config.geminiRetries, label = 'gemini' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isRetryable(err)) {
        const delayMs = 1000 * Math.pow(2, attempt);
        logger.warn({ attempt: attempt + 1, retries, error: err.message, delayMs, label }, 'Gemini call failed, retrying');
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

function buildCustomerMemoryPrompt(facts) {
  const lines = [];
  if (facts.name) lines.push(`- Name: ${facts.name}`);
  if (facts.gender) lines.push(`- Gender: ${facts.gender}`);
  if (facts.language) lines.push(`- Preferred language: ${facts.language}`);
  if (facts.notes && facts.notes.length > 0) {
    lines.push(`- Key facts: ${facts.notes.join('; ')}`);
  }
  if (lines.length === 0) return null;
  return '\n\nYou have the following information about this customer from previous conversations. Use it to personalize your responses (e.g. greet them by name, reference past interactions), but do not explicitly tell them you have a memory system:\n' + lines.join('\n');
}

/**
 * Strip leaked chain-of-thought reasoning from model replies.
 * Handles both labeled prefixes (THOUGHT: ...) and unlabeled English
 * reasoning blocks that precede Hebrew/Arabic customer-facing text.
 */
function stripLeakedReasoning(reply) {
  if (!reply) return reply;

  // 1. Strip labeled reasoning prefixes (THOUGHT: ..., THINKING: ..., etc.)
  reply = reply.replace(/^(?:THOUGHT|THINKING|REASONING|INTERNAL|ANALYSIS|STRATEGY|PLAN|NOTE):\s*/i, '');

  // 2. Detect unlabeled reasoning: English text block followed by Hebrew/Arabic text.
  //    Find the first Hebrew (U+0590–U+05FF) or Arabic (U+0600–U+06FF) character.
  const rtlMatch = reply.match(/[\u0590-\u05FF\u0600-\u06FF]/);
  if (rtlMatch) {
    const rtlIndex = reply.indexOf(rtlMatch[0]);
    // Only strip if the RTL text doesn't start at the beginning
    if (rtlIndex > 0) {
      const leadingText = reply.slice(0, rtlIndex);
      // Check if the leading text looks like reasoning (English sentences, not a name/greeting)
      const reasoningPatterns = /(?:I (?:need|should|cannot|will|must|have to|am going)|This (?:means|indicates|suggests)|The (?:booking|slot|customer|user|appointment|service|system|error|issue|problem|request)|Since |Because |However |Therefore |Let me |First,? |Next,? |After |Before |Unfortunately|Based on|In order to|It (?:seems|appears|looks|means))/i;
      if (reasoningPatterns.test(leadingText) && leadingText.length >= 20) {
        reply = reply.slice(rtlIndex);
      }
    }
  }

  return reply.trim();
}

// Patterns that indicate a booking confirmation — Hebrew and English
const BOOKING_CONFIRMATION_PATTERNS = [
  /נקבע בהצלחה/,       // "was set successfully"
  /התור נקבע/,          // "the appointment was set"
  /הוזמן בהצלחה/,       // "was booked successfully"
  /שריינתי לך/,         // "I reserved for you"
  /התור שלך נקבע/,      // "your appointment was set"
  /הזמנתי לך/,          // "I booked for you"
  /נרשמת בהצלחה/,       // "you were registered successfully"
  /(?:appointment|booking) (?:has been |is )(?:confirmed|booked|scheduled|created)/i,
  /(?:successfully|have) (?:booked|scheduled|reserved|created) (?:your|the|an?) (?:appointment|booking)/i,
  /(?:you're|you are) (?:all )?\bset\b/i,
  /(?:I've|I have) (?:booked|scheduled|reserved|confirmed)/i,
];

function detectHallucinatedBooking(reply) {
  if (!reply) return false;
  return BOOKING_CONFIRMATION_PATTERNS.some((pattern) => pattern.test(reply));
}

/**
 * Check if the AI's reply mentions a different time than what was actually booked.
 * Returns the mismatched time string found in the reply, or null if no mismatch.
 */
function detectBookingTimeMismatch(reply, bookingResult) {
  if (!reply || !bookingResult || !bookingResult.formatted_start_time) return null;

  // Only check replies that look like booking confirmations
  if (!detectHallucinatedBooking(reply)) return null;

  const normalizedBooked = bookingResult.formatted_start_time.replace(/^(\d):/, '0$1:');
  const normalizedEnd = bookingResult.formatted_end_time
    ? bookingResult.formatted_end_time.replace(/^(\d):/, '0$1:')
    : null;

  // Extract all HH:MM patterns from the reply
  const timeMatches = reply.match(/\b(\d{1,2}:\d{2})\b/g);
  if (!timeMatches || timeMatches.length === 0) return null;

  // Check if any mentioned time doesn't match the booked time
  for (const mentioned of timeMatches) {
    const normalizedMentioned = mentioned.replace(/^(\d):/, '0$1:');
    if (normalizedMentioned !== normalizedBooked) {
      if (normalizedEnd && normalizedMentioned === normalizedEnd) continue;
      return normalizedMentioned;
    }
  }

  return null;
}

async function initializeChat(business, dynamicParts, history, dynamicCtx) {
  const { customerMemoryPrompt, knowledgeBase, conversationSummary, now } = dynamicCtx;

  // Try cached path first
  if (config.geminiCacheEnabled) {
    try {
      const cacheResult = await geminiCache.getOrCreateCache(genAI, business);
      if (cacheResult) {
        // Inject dynamic context as a synthetic user/model pair at the start of history
        const dynamicMsg = {
          role: 'user',
          parts: [{ text: `[SYSTEM CONTEXT]\n${dynamicParts.join('\n')}` }],
        };
        const ack = { role: 'model', parts: [{ text: 'Understood.' }] };
        const fullHistory = [dynamicMsg, ack, ...history];

        const chat = genAI.chats.create({
          model: business.gemini_model || config.defaultGeminiModel,
          config: {
            cachedContent: cacheResult.cacheName,
            thinkingConfig: { thinkingLevel: config.geminiThinkingLevel },
            httpOptions: { timeout: config.geminiTimeoutMs },
          },
          history: fullHistory,
        });
        logger.debug({ businessId: business.id }, 'Gemini cache hit');
        return { chat, usedCache: true };
      }
    } catch (err) {
      logger.warn({ businessId: business.id, error: err.message }, 'Gemini cache path failed — falling back to non-cached');
    }
  }

  // Non-cached fallback — reuse buildStaticSystemParts + append dynamic parts
  const { systemInstruction: staticInstruction, tools } = geminiCache.buildStaticSystemParts(business);

  const dynamicSystemParts = [`\nCurrent date and time in Israel: ${now}.`];
  if (customerMemoryPrompt) dynamicSystemParts.push(customerMemoryPrompt);
  if (knowledgeBase) dynamicSystemParts.push(knowledgeBase);
  if (conversationSummary) dynamicSystemParts.push(`\n\nSummary of earlier conversation:\n${conversationSummary}`);

  const fullSystemInstruction = staticInstruction + dynamicSystemParts.join('');

  const chat = genAI.chats.create({
    model: business.gemini_model || config.defaultGeminiModel,
    config: {
      systemInstruction: fullSystemInstruction,
      ...(tools && { tools }),
      thinkingConfig: { thinkingLevel: config.geminiThinkingLevel },
      httpOptions: { timeout: config.geminiTimeoutMs },
    },
    history,
  });
  return { chat, usedCache: false };
}

function buildMessageParts(userMessage, media) {
  if (media && media.length > 0) {
    const parts = [];
    for (const item of media) {
      parts.push({ inlineData: { data: item.base64, mimeType: item.mimeType } });
    }
    if (userMessage) parts.push({ text: userMessage });
    return parts;
  }
  return userMessage;
}

async function runSchedulingLoop(chat, messageParts, business, customerPhone, hasScheduling) {
  let result = await withRetry(() => chat.sendMessage({ message: messageParts }), { label: 'generateReply' });
  let iterations = 0;
  let bookAppointmentCalled = false;
  let bookAppointmentResult = null;

  // Lazily initialised once on first function call round
  let provider;

  // Process ALL function calls in a response (Gemini may return multiple in one turn)
  async function processFunctionCalls(fnCalls) {
    if (!provider) provider = scheduling.getProvider(business);
    const responses = [];
    for (const functionCall of fnCalls) {
      logger.info({ businessId: business.id, customerPhone, function: functionCall.name, iteration: iterations }, 'Processing scheduling function call');

      let fnResult;
      try {
        fnResult = await executeSchedulingFunction(functionCall, provider, business, customerPhone);
      } catch (err) {
        logger.error({ businessId: business.id, error: err.message, function: functionCall.name }, 'Scheduling function call failed');
        fnResult = { error: err.message };
      }

      if (functionCall.name === 'book_appointment' && fnResult.success) {
        bookAppointmentCalled = true;
        bookAppointmentResult = fnResult;
      }

      responses.push({ functionResponse: { name: functionCall.name, response: fnResult } });
    }
    return responses;
  }

  while (result.functionCalls?.length > 0 && iterations < config.schedulingMaxIterations) {
    iterations++;
    const responses = await processFunctionCalls(result.functionCalls);

    result = await withRetry(() => chat.sendMessage({ message: responses }), { label: 'functionCall' });
  }

  // Ceiling feedback: if we hit the iteration limit with pending function calls,
  // tell the AI so it informs the customer instead of hallucinating results
  if (result.functionCalls?.length > 0 && iterations >= config.schedulingMaxIterations) {
    logger.warn({ businessId: business.id, customerPhone, iterations }, 'Scheduling hit iteration ceiling with pending function calls');
    result = await withRetry(() => chat.sendMessage({
      message: 'SYSTEM: Your function calls were NOT executed because the maximum number of scheduling steps was reached. Do NOT assume any action was completed. Inform the customer that you could not complete the request and suggest they try again or simplify their request.',
    }), { label: 'iterationCeiling' });
  }

  let reply;
  try {
    reply = result.text;
  } catch (_) {
    /* fallback */
  }
  if (!reply) {
    reply = 'I apologize, but I had trouble processing your request. Please try again.';
  }

  // Safety net: detect hallucinated booking confirmations
  if (hasScheduling && !bookAppointmentCalled && iterations < config.schedulingMaxIterations && detectHallucinatedBooking(reply)) {
    logger.warn({ businessId: business.id, customerPhone, reply: reply.slice(0, 200) }, 'Detected hallucinated booking confirmation — sending correction');

    result = await withRetry(() => chat.sendMessage({
      message: 'SYSTEM CORRECTION: You did NOT call book_appointment. The booking was NOT actually created. You MUST call book_appointment now to create the booking, or inform the customer that the booking was not completed and ask them to try again.',
    }), { label: 'hallucinationCorrection' });

    // Process any resulting function calls
    while (result.functionCalls?.length > 0 && iterations < config.schedulingMaxIterations) {
      iterations++;
      const responses = await processFunctionCalls(result.functionCalls);
      result = await withRetry(() => chat.sendMessage({ message: responses }), { label: 'functionCall' });
    }

    try {
      const correctedReply = result.text;
      if (correctedReply) reply = correctedReply;
    } catch (_) {
      /* keep original reply if correction fails */
    }
  }

  // Verify booking details: if the AI confirmed a booking but mentions wrong times,
  // send a correction with the authoritative data from the booking result
  if (bookAppointmentResult && bookAppointmentResult.formatted_start_time) {
    const mismatch = detectBookingTimeMismatch(reply, bookAppointmentResult);
    if (mismatch) {
      logger.warn({ businessId: business.id, customerPhone, expected: bookAppointmentResult.formatted_start_time, mismatch }, 'Detected booking time mismatch in AI reply — sending correction');
      const correction = `SYSTEM CORRECTION: The booking was confirmed for ${bookAppointmentResult.formatted_start_time}${bookAppointmentResult.formatted_end_time ? ' - ' + bookAppointmentResult.formatted_end_time : ''}${bookAppointmentResult.service_name ? ' (' + bookAppointmentResult.service_name + ')' : ''} for ${bookAppointmentResult.customer_name}. Your previous message contained incorrect time details. Please send a corrected confirmation to the customer using ONLY these details.`;
      try {
        result = await withRetry(() => chat.sendMessage({ message: correction }), { label: 'bookingTimeCorrection' });
        const correctedReply = result.text;
        if (correctedReply) reply = correctedReply;
      } catch (_) {
        /* keep original reply if correction fails */
      }
    }
  }

  reply = stripLeakedReasoning(reply);
  return { reply, bookingResult: bookAppointmentResult };
}

async function generateReply(business, conversationHistory, userMessage, customerPhone, media) {
  if (!genAI) throw new Error('Gemini API key not configured');

  // Expired plan: return paused message without calling Gemini
  if (business.subscription_plan === 'expired') {
    return { reply: 'שירות זה מושהה כרגע. אנא פנו לבעל העסק לפרטים נוספים.\n\nThis service is currently paused. Please contact the business owner for more information.', bookingResult: null };
  }

  if (!checkBusinessRateLimit(business)) {
    logger.warn({ businessId: business.id }, 'Gemini rate limit exceeded for business');
    return { reply: 'We are experiencing high demand right now. Please try again in a few minutes.', bookingResult: null };
  }

  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

  // Build dynamic context parts (change every request)
  const dynamicParts = [`Current date and time in Israel: ${now}.`];

  let customerMemoryPrompt = null;
  if (customerPhone) {
    const memory = db.getCustomerMemory(business.id, customerPhone);
    if (memory && memory.facts) {
      customerMemoryPrompt = buildCustomerMemoryPrompt(memory.facts);
      if (customerMemoryPrompt) dynamicParts.push(customerMemoryPrompt);
    }
  }

  // Knowledge base from answered gaps (Business/Trial only)
  const knowledgeBase = canAccess(business, 'knowledge_gaps') ? buildKnowledgeBasePrompt(business.id) : null;
  if (knowledgeBase) dynamicParts.push(knowledgeBase);

  // Conversation summary from previous summarization runs
  const conv = db.getConversation(business.id, customerPhone);
  const conversationSummary = conv?.conversation_summary || null;
  if (conversationSummary) {
    dynamicParts.push(`\n\nSummary of earlier conversation:\n${conversationSummary}`);
  }

  const hasScheduling = !!buildSchedulingSystemPrompt(business);

  const history = conversationHistory.map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.source === 'human_agent' ? `[Human agent replied]: ${msg.content}` : msg.content }],
  }));

  // Initialize chat (cached or non-cached)
  const { chat, usedCache } = await initializeChat(business, dynamicParts, history,
    { customerMemoryPrompt, knowledgeBase, conversationSummary, now });

  // Build multimodal message parts when media (images/audio) are attached
  const messageParts = buildMessageParts(userMessage, media);

  // Send message, process scheduling function calls, and handle corrections
  const { reply, bookingResult } = await runSchedulingLoop(chat, messageParts, business, customerPhone, hasScheduling);

  logger.debug({ businessId: business.id, replyLength: reply.length, cached: usedCache }, 'Gemini reply generated');
  return { reply, bookingResult };
}

const EXTRACT_FACTS_PROMPT = `You are a fact extraction system. Analyze the customer message and assistant reply below, and extract or update customer facts.

Return ONLY valid JSON (no markdown, no code fences) with this exact structure:
{"name": null, "language": null, "gender": null, "notes": []}

Rules:
- "name": the customer's name if mentioned or introduced, otherwise null
- "language": the language the customer is writing in (e.g. "Hebrew", "English", "Arabic", "Russian"), otherwise null
- "gender": the customer's likely gender if inferable from their name, how they refer to themselves (e.g. masculine/feminine verb forms in Hebrew/Arabic), or explicit statements. Use "male" or "female". null if unknown.
- "notes": an array of short factual strings about the customer's interests, preferences, past inquiries, or any personally identifying info they shared (e.g. "interested in premium plan", "asked about returns policy"). Only include clear facts, not vague observations. Max 5 notes per extraction.
- NEVER include scheduling or appointment-related information in notes (e.g. booked appointments, appointment times, cancellations, availability questions, preferred time slots). Scheduling data must always come from the live provider API, not from memory.
- If nothing notable was shared, return {"name": null, "language": null, "gender": null, "notes": []}`;

async function extractCustomerFacts(business, userMessage, assistantReply) {
  if (!genAI) return null;

  try {
    const prompt = `Customer message:\n${userMessage.slice(0, 2000)}\n\nAssistant reply:\n${assistantReply.slice(0, 2000)}`;
    const result = await withRetry(() => genAI.models.generateContent({
      model: business.gemini_model || config.defaultGeminiModel,
      contents: prompt,
      config: {
        systemInstruction: EXTRACT_FACTS_PROMPT,
        thinkingConfig: { thinkingLevel: 'minimal' },
        httpOptions: { timeout: Math.min(config.geminiTimeoutMs, 15000) },
      },
    }), { retries: 1, label: 'extractFacts' });
    const text = result.text.trim();

    const parsed = JSON.parse(text);
    return parsed;
  } catch (err) {
    logger.warn({ businessId: business.id, error: err.message }, 'Failed to extract customer facts');
    return null;
  }
}

function mergeFacts(existing, extracted) {
  const merged = { ...existing };

  if (extracted.name && extracted.name !== null) {
    merged.name = extracted.name;
  }
  if (extracted.language && extracted.language !== null) {
    merged.language = extracted.language;
  }
  if (extracted.gender && extracted.gender !== null) {
    merged.gender = extracted.gender;
  }

  const existingNotes = merged.notes || [];
  const newNotes = (extracted.notes || []).filter(
    (note) => !existingNotes.some((n) => n.toLowerCase() === note.toLowerCase())
  );
  merged.notes = [...existingNotes, ...newNotes].slice(-20);

  return merged;
}

// Per-customer locks to prevent concurrent read-extract-merge-write races
const customerMemoryLocks = new Map();

async function updateCustomerMemory(business, customerPhone, userMessage, assistantReply) {
  const lockKey = `${business.id}:${customerPhone}`;

  // Wait for any in-progress call for this customer (loop handles 3+ concurrent callers)
  while (customerMemoryLocks.has(lockKey)) {
    try {
      await customerMemoryLocks.get(lockKey);
    } catch (_) {
      // Previous call failed — proceed anyway
    }
  }

  const work = (async () => {
    try {
      const extracted = await extractCustomerFacts(business, userMessage, assistantReply);
      if (!extracted) return;

      const hasContent = extracted.name || extracted.language || (extracted.notes && extracted.notes.length > 0);
      if (!hasContent) return;

      const existing = db.getCustomerMemory(business.id, customerPhone);
      const existingFacts = existing ? existing.facts : {};
      const merged = mergeFacts(existingFacts, extracted);

      db.saveCustomerMemory(business.id, customerPhone, merged);
      logger.debug({ businessId: business.id, customerPhone }, 'Customer memory updated');
    } catch (err) {
      logger.warn({ businessId: business.id, customerPhone, error: err.message }, 'Failed to update customer memory');
    } finally {
      customerMemoryLocks.delete(lockKey);
    }
  })();

  customerMemoryLocks.set(lockKey, work);
  return work;
}

const DETECT_KNOWLEDGE_GAPS_PROMPT = `You are a knowledge gap detector for a business chatbot. Analyze whether the assistant successfully answered the customer's question.

Return ONLY valid JSON:
{"has_gap": false, "gap_type": null, "question": null, "reason": null}

Rules:
- "has_gap": true if the AI failed to answer, was uncertain, or deflected
- "gap_type": "unanswered" (said it doesn't know), "uncertain" (hedged/vague), "deflected" (told customer to call/visit/contact the business), or null
- "question": the customer's core question extracted cleanly (1 sentence), or null
- "reason": brief explanation of why this is a gap, or null
- Normal greetings, thanks, and small talk are NOT gaps
- If the AI answered confidently and on-topic, return has_gap: false
- Only flag genuine information gaps where the business could provide a better answer`;

async function detectKnowledgeGaps(business, userMessage, assistantReply, customerPhone) {
  if (!genAI) return;

  try {
    const prompt = `Customer message:\n${userMessage.slice(0, 2000)}\n\nAssistant reply:\n${assistantReply.slice(0, 2000)}`;
    const result = await withRetry(() => genAI.models.generateContent({
      model: business.gemini_model || config.defaultGeminiModel,
      contents: prompt,
      config: {
        systemInstruction: DETECT_KNOWLEDGE_GAPS_PROMPT,
        thinkingConfig: { thinkingLevel: 'minimal' },
        httpOptions: { timeout: Math.min(config.geminiTimeoutMs, 15000) },
      },
    }), { retries: 1, label: 'detectKnowledgeGaps' });

    const text = result.text.trim();
    const parsed = JSON.parse(text);

    if (parsed.has_gap && parsed.question) {
      // Skip if an identical question already exists (pending or answered)
      const existing = db.findSimilarKnowledgeGap(business.id, parsed.question);
      if (existing) {
        logger.debug({ businessId: business.id, existingStatus: existing.status }, 'Knowledge gap already exists, skipping');
        return;
      }
      db.createKnowledgeGap({
        business_id: business.id,
        customer_phone: customerPhone || 'unknown',
        question: parsed.question,
        ai_response: assistantReply.slice(0, 2000),
        gap_type: parsed.gap_type || 'uncertain',
      });
      logger.debug({ businessId: business.id, gapType: parsed.gap_type, question: parsed.question }, 'Knowledge gap detected');
    }
  } catch (err) {
    logger.warn({ businessId: business.id, error: err.message }, 'Failed to detect knowledge gaps');
  }
}

function buildKnowledgeBasePrompt(businessId) {
  const gaps = db.getAnsweredKnowledgeGaps(businessId);
  if (!gaps || gaps.length === 0) return null;

  const qaPairs = gaps.map(g => `Q: ${g.question}\nA: ${g.answer}`).join('\n\n');
  return `\n\nAdditional business-provided answers to frequently asked questions:\n${qaPairs}`;
}

function detectEscalation(reply) {
  const match = reply.match(/\[ESCALATE\]\s*(.*)/);
  if (!match) return null;
  return match[1].trim() || 'Customer needs human assistance';
}

async function summarizeConversation(business, history) {
  if (!genAI || !history || history.length === 0) return null;

  const bossLang = business.boss_language || 'he';
  const langNames = { he: 'Hebrew', ar: 'Arabic', en: 'English' };
  const langName = langNames[bossLang] || 'Hebrew';

  try {
    const transcript = history.slice(-10).map((m) => `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${m.content}`).join('\n');
    const result = await withRetry(() => genAI.models.generateContent({
      model: business.gemini_model || config.defaultGeminiModel,
      contents: `Conversation:\n${transcript}`,
      config: {
        systemInstruction: `Summarize this customer conversation in 2-3 short lines for a business owner who needs context before responding. Focus on what the customer wants/needs. Be concise. Always reply in ${langName}.`,
        thinkingConfig: { thinkingLevel: 'minimal' },
        httpOptions: { timeout: Math.min(config.geminiTimeoutMs, 15000) },
      },
    }), { retries: 1, label: 'summarizeConversation' });
    return result.text?.trim() || null;
  } catch (err) {
    logger.warn({ businessId: business.id, error: err.message }, 'Failed to summarize conversation');
    return null;
  }
}

async function summarizeOlderMessages(business, olderMessages, existingSummary) {
  if (!genAI || !olderMessages || olderMessages.length === 0) return existingSummary || null;

  try {
    const transcript = olderMessages.map((m) => `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${m.content}`).join('\n');
    const prompt = existingSummary
      ? `Previous summary:\n${existingSummary}\n\nNew messages to incorporate:\n${transcript}`
      : `Conversation:\n${transcript}`;
    const systemInstruction = existingSummary
      ? 'You have an existing conversation summary and new messages. Merge them into a single updated summary (3-5 lines). Preserve key facts from the old summary and add new information. Be concise. Reply in the same language the customer used.'
      : 'Summarize this customer conversation in 3-5 lines. Capture key facts: what the customer wants, any scheduled appointments, important details. Be concise. Reply in the same language the customer used.';

    const result = await withRetry(() => genAI.models.generateContent({
      model: business.gemini_model || config.defaultGeminiModel,
      contents: prompt,
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: 'minimal' },
        httpOptions: { timeout: Math.min(config.geminiTimeoutMs, 15000) },
      },
    }), { retries: 1, label: 'summarizeOlderMessages' });
    return result.text?.trim() || existingSummary || null;
  } catch (err) {
    logger.warn({ businessId: business.id, error: err.message }, 'Failed to summarize older messages');
    return existingSummary || null;
  }
}

async function maybeSummarizeConversation(business, customerPhone, messages) {
  if (!messages || messages.length < config.conversationSummaryThreshold) return;

  try {
    const recentCount = config.conversationRecentMessages;
    const olderMessages = messages.slice(0, -recentCount);
    const recentMessages = messages.slice(-recentCount);

    if (olderMessages.length === 0) return;

    // Snapshot the message count before the async Gemini call
    const expectedMessageCount = messages.length;

    const conv = db.getConversation(business.id, customerPhone);
    const existingSummary = conv?.conversation_summary || null;

    const summary = await summarizeOlderMessages(business, olderMessages, existingSummary);
    if (!summary) return;

    // Atomic: re-check message count inside a transaction to avoid losing messages
    // that arrived during the Gemini API call. If count changed, save summary but skip trim.
    const trimmed = db.summarizeAndTrimConversation(business.id, customerPhone, summary, recentMessages, expectedMessageCount);

    if (trimmed) {
      logger.debug({ businessId: business.id, customerPhone, olderCount: olderMessages.length, recentCount: recentMessages.length }, 'Conversation summarized and trimmed');
    } else {
      logger.debug({ businessId: business.id, customerPhone }, 'Conversation summary saved (messages changed during summarization, trim skipped)');
    }
  } catch (err) {
    logger.warn({ businessId: business.id, customerPhone, error: err.message }, 'Failed to summarize conversation');
  }
}

module.exports = { generateReply, updateCustomerMemory, detectEscalation, detectKnowledgeGaps, buildCustomerMemoryPrompt, buildKnowledgeBasePrompt, mergeFacts, withRetry, isRetryable, stripLeakedReasoning, summarizeConversation, detectHallucinatedBooking, detectBookingTimeMismatch, maybeSummarizeConversation, summarizeOlderMessages };
