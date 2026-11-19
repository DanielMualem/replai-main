# Gemini Token Optimization Reference

## Current Setup

- **Model**: `gemini-3-flash-preview` (configurable per business via `gemini_model` column)
- **SDK**: `@google/genai` (Google GenAI SDK)
- **Config**: `src/config.js`
- **Main Gemini logic**: `src/services/gemini.js`

### Latest Model Availability

- **`gemini-3-flash-preview`** — near-Pro-level reasoning at Flash pricing, currently in preview
- **`gemini-3-flash-preview`** — stable production choice (current default)
- **`gemini-3-flash-lite`** — cheaper, for simple tasks (good for auxiliary calls)
- Legacy `gemini-2.0-flash` retiring March 31, 2026

---

## Current Token Usage Per Message

Every incoming user message triggers 2-3 Gemini API calls:

### Call 1: Main Reply (`generateReply` in gemini.js)

System instruction is rebuilt from scratch each request:

| Component | Size | Changes how often? |
|---|---|---|
| Scraped website context | up to **30,000 chars** | Only on re-scrape |
| Business system prompt | 100-500 chars | Rarely |
| Reasoning suppression rules | ~400 chars | Never |
| Escalation rules | ~400-600 chars | Rarely |
| Scheduling prompt + tool declarations | ~600-800 chars | Never (tools cached in service-cache) |
| Date/time injection | ~100 chars | Daily |
| Customer memory | 0-500 chars | Per conversation |
| Upcoming appointments | 0-500 chars | Per customer |
| Conversation history | up to ~12,000 chars (40 msgs) | Every message |

**Total system instruction per request**: typically 1,500-35,000+ characters.

The **scraped context dominates** — ~30K chars sent identically with every message to the same business. 100 messages/day = same 30K chars sent 100 times.

If scheduling is configured, may enter a function-calling loop (up to `SCHEDULING_MAX_ITERATIONS` = 5 rounds), each round adding ~200-400 tokens.

### Call 2: Customer Fact Extraction (`extractCustomerFacts` — async, every message)

- Input: user message (first 2,000 chars) + assistant reply (first 2,000 chars)
- Uses same model as main reply
- Timeout: 15s, retries: 1
- ~300-600 tokens per call

### Call 3: Conversation Summarization (`summarizeConversation` — only on escalation)

- Input: last 10 messages
- Timeout: 15s, retries: 1
- ~400-800 tokens per call
- Infrequent (only when customer escalates to human)

### Daily Token Estimates

| Business Type | Messages/day | Estimated Daily Tokens |
|---|---|---|
| Low-volume (no bookings) | 5 | ~22,000 |
| Medium (some bookings) | 30 | ~135,000 |
| High-volume (10+ bookings) | 100 | ~450,000 |

---

## Optimization 1: Context Caching (HIGH IMPACT)

### What It Is

Gemini context caching stores content once and references it across requests. Cached tokens cost **only 10% of standard input token rate** on Gemini 2.5+.

### Two Modes

1. **Implicit caching** — automatic, already enabled on Gemini 2.5+, no guaranteed savings
2. **Explicit caching** — manual, guaranteed 90% cost reduction on cached tokens

### Requirements

- Gemini 2.5 Flash: minimum **1,024 tokens** cached content
- Gemini 2.5 Pro: minimum **2,048 tokens**
- TTL: configurable (default 1 hour, recommend 24h for ReplAI)
- Pricing: one-time creation cost (standard rate) + per-use cost (10% rate) + hourly storage cost

### The Constraint

When using cached content, you **cannot** specify `systemInstruction` or `tools` separately in the request — they must be baked into the cache.

This means you need to split the system prompt into:

```
CACHED (static, per business):          SENT PER REQUEST (dynamic):
├─ Business system prompt               ├─ Current date/time
├─ Scraped website context (30K!)       ├─ Customer memory
├─ Scheduling tool declarations         ├─ Upcoming appointments
├─ Escalation rules                     └─ Conversation history + user message
└─ Reasoning suppression rules
```

Dynamic parts (date/time, customer memory, appointments) get injected as conversation messages (e.g., a system-context "user" message at the start of the conversation).

### Implementation

```javascript
// In gemini.js — create/update cache per business
const cache = await ai.caches.create({
  model: 'gemini-3-flash-preview',
  config: {
    systemInstruction: businessSystemPrompt + scrapedContext + schedulingPrompt + escalationRules,
    tools: schedulingToolDeclarations,
    displayName: `business-${businessId}`,
    ttl: '86400s' // 24 hours
  }
});

// Store cache.name in memory (per business)
businessCacheMap.set(businessId, cache.name);

// On every message — use cache (pay 10% for the cached portion)
const response = await ai.models.generateContent({
  model: 'gemini-3-flash-preview',
  contents: [
    { role: 'user', parts: [{ text: dynamicContext }] },  // date, memory, appointments
    ...conversationHistory,
    { role: 'user', parts: [{ text: userMessage }] }
  ],
  config: { cachedContent: cache.name }
});
```

### Cache Lifecycle

- **Create**: on business creation, after scrape completion, on config changes
- **Invalidate**: on re-scrape, scheduling config update, business system prompt change
- **TTL**: 24 hours (matches `SERVICES_CACHE_TTL_MS`)
- **Storage**: in-memory map `businessId → cacheName`, similar to `service-cache.js`

### Cache API Operations (`ai.caches`)

- `create()` — create new cached context
- `get()` — retrieve cache details
- `list()` — list all caches
- `update()` — update TTL or other properties
- `delete()` — remove a cache

### Expected Impact

**~70-80% reduction in input token costs** for the cached portion (system prompt + scraped context + tools). For a business with 30K chars of scraped context, this saves ~7,500 tokens × 90% = ~6,750 tokens per message.

### Key Files to Modify

- `src/services/gemini.js` — split system instruction into static/dynamic, use `cachedContent`
- `src/services/scheduling/tools.js` — tool declarations need to go into the cache
- `src/services/scraper/index.js` — invalidate cache after scrape completes
- `src/routes/admin.js` — invalidate cache on business config changes
- New: `src/services/gemini-cache.js` — cache lifecycle management (create, invalidate, lookup)

---

## Optimization 2: Conversation History Summarization (MEDIUM-HIGH IMPACT)

### Current State

Up to **40 raw messages** replayed every request (~8,000-12,000 chars).

### Proposed Change

After N messages (e.g., 10), summarize older messages into a compact context paragraph. Keep only the last 6-8 raw messages + the summary.

```
[Summary: Customer asked about haircuts ($30), availability on Tuesday,
booked for 2pm. Mentioned they prefer shorter styles.]
+ last 6-8 raw messages
```

### Implementation

- In `gemini.js`, before building the chat, check if history exceeds threshold
- If so, call `summarizeConversation()` on the older portion
- Store the summary as a prefixed message in the conversation
- Could use the cheaper `gemini-3-flash-lite` for summarization

### Expected Impact

~15-20% reduction in input tokens (history portion). Most effective for long conversations.

### Key Files

- `src/services/gemini.js` — add summarization logic before replay
- `src/services/db.js` — possibly store summaries alongside conversations

---

## Optimization 3: Lighter Model for Auxiliary Calls (MEDIUM IMPACT)

### Current State

All Gemini calls use the same model (`gemini-3-flash-preview` by default), including fact extraction and conversation summarization.

### Proposed Change

- **Main reply**: `gemini-3-flash-preview` (or `gemini-3-flash-preview`)
- **Fact extraction**: `gemini-3-flash-lite` (simpler task, structured JSON output)
- **Conversation summarization**: `gemini-3-flash-lite`

### Implementation

Add a config option like `GEMINI_AUX_MODEL` (default `gemini-3-flash-lite`), use it for `extractCustomerFacts()` and `summarizeConversation()`.

### Expected Impact

~30-40% cost reduction on auxiliary calls. Since aux calls happen on every message, this compounds.

### Key Files

- `src/config.js` — add `auxGeminiModel` config
- `src/services/gemini.js` — use aux model for `extractCustomerFacts()` and `summarizeConversation()`

---

## Optimization 4: Reduce Fact Extraction Frequency (MEDIUM IMPACT)

### Current State

`extractCustomerFacts()` fires on **every single message**, even short ones like "ok" or "thanks".

### Proposed Change

- Only extract facts every 3-5 messages
- Skip extraction if message is very short (< 20 chars)
- Skip if customer already has a complete profile (name + language known)
- Could batch multiple messages into a single extraction call

### Implementation

Track a message counter per customer conversation. Only call extraction when counter hits threshold or when the message seems substantive.

### Expected Impact

Eliminate 60-80% of auxiliary API calls.

### Key Files

- `src/services/gemini.js` — add conditional logic around `extractCustomerFacts()`
- `src/services/db.js` — may need a message counter or check existing customer profile completeness

---

## Optimization 5: Scraped Context Budget Tuning (LOW-MEDIUM IMPACT)

### Current State

`SCRAPER_CONTEXT_MAX_CHARS` = 30,000. This is the single largest token consumer.

### Proposed Changes

- Test reducing to 15,000-20,000 chars — measure if AI quality drops meaningfully
- Prioritize FAQ content (most likely to answer questions) over general page content
- Consider topic-based retrieval: only include relevant scraped sections based on the user's question (lightweight RAG approach)

### Expected Impact

~15-30% reduction in cached content size. Compounded with context caching, reduces both cache creation cost and per-request cost.

### Key Files

- `src/config.js` — adjust default
- `src/services/scraper/context.js` — adjust budget allocation

---

## Impact Summary

| Optimization | Token Reduction | Implementation Effort |
|---|---|---|
| Context caching (scraped data + system prompt) | ~70-80% of input tokens | Medium |
| Conversation history summarization | ~15-20% of input tokens | Medium |
| Lighter model for auxiliary calls | ~30-40% cost on aux calls | Low |
| Reduce fact extraction frequency | Eliminate 60-80% of aux calls | Low |
| Reduce scraped context budget | ~15-30% of cached content | Low |

### Implementation Priority

1. **Context caching** — highest impact, medium effort, do first
2. **Lighter aux model** — easy win, do alongside caching
3. **Reduce fact extraction frequency** — easy win, do alongside caching
4. **Conversation summarization** — good for long conversations, do second
5. **Context budget tuning** — test and measure, do last

---

## Existing Optimizations (Already in Place)

- **Thinking disabled**: `thinkingConfig: { thinkingBudget: 0 }` prevents Gemini 2.5 reasoning tokens
- **History trimming**: 40-message cap via `MAX_CONVERSATION_MESSAGES`
- **Scraped context budgeting**: 30K char cap with smart allocation by page type
- **Service caching**: 24h TTL for scheduling services (avoids repeated `get_services` calls)
- **Slot ID compression**: short IDs (s1, s2...) replace full provider slot objects
- **Fact extraction truncation**: inputs capped at 2,000 chars each
- **Async non-blocking**: fact extraction and summarization don't block reply delivery
- **Chain-of-thought stripping**: `stripLeakedReasoning()` as defense-in-depth

## References

- [Gemini Context Caching](https://ai.google.dev/gemini-api/docs/caching)
- [Caching API Reference](https://ai.google.dev/api/caching)
- [@google/genai Caches SDK](https://googleapis.github.io/js-genai/release_docs/classes/caches.Caches.html)
- [Gemini Models](https://ai.google.dev/gemini-api/docs/models)
- [Implicit Caching Blog Post](https://developers.googleblog.com/en/gemini-2-5-models-now-support-implicit-caching/)
