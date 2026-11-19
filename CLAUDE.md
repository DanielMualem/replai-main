# CLAUDE.md

> **Note:** The product has been rebranded from "ReplAI" to **Aiyelet**. The repo/directory is still named `replai` but all user-facing UI should use "Aiyelet" (or "AIyelet" for the admin header styling). Every bot instance identifies as "Aiyelet (איילת)" via a hardcoded identity preamble in `gemini-cache.js:buildStaticSystemParts()`, prepended before each business's `system_prompt`.

## Commands

- `npm start` — run the server
- `npm run dev` — run with `--watch` for auto-reload
- `npm test` — run all tests (Node.js built-in test runner)
- `npm run test:unit` — unit tests only
- `npm run test:integration` — integration tests only

## Architecture

Multi-tenant WhatsApp AI chatbot service. Each **business** gets its own WhatsApp number (Meta Cloud API) and Gemini-powered AI assistant configured via system prompt + optional scraped website data.

### Request flow

1. WhatsApp message (text, image, or voice) → `webhook.js` → `whatsapp.js` (lookup business by `phone_number_id`)
2. For image/audio messages: media downloaded eagerly from Meta API via `downloadMedia()` during buffer window
3. Conversation history loaded from SQLite → system prompt + scraped context + history sent to Gemini (with optional multimodal `inlineData` for images/audio)
4. AI reply saved and sent back via Meta Graph API. `/api/businesses/:id/chat` bypasses WhatsApp for testing (text only).

When `scheduling_config` is set, Gemini uses native function calling with 5 scheduling tools. Up to `SCHEDULING_MAX_ITERATIONS` (default 8) rounds per turn. Includes hallucination safety net (detects fake booking confirmations) and booking time mismatch detector.

### Routes (`src/routes/`)

- **webhook.js** — `GET /webhook` (Meta verification), `POST /webhook` (incoming messages, rate-limited 200/min). Verifies HMAC-SHA256 when `WHATSAPP_APP_SECRET` set (required in production).
- **calendar.js** — Public. `GET /cal/:id` (HTML landing page), `GET /cal/:id.ics` (iCalendar file). The `.ics` route must be registered before `/:id` to avoid Express greedy matching.
- **resume.js** — Public. `GET /resume/:id` (confirmation page), `POST /resume/:id` (resolve escalation). Uses unguessable UUID as auth.
- **auth.js** — Google OAuth flow at `/auth`. Session-based with httpOnly cookies (7-day expiry). CSRF state map capped at 1000 entries, cleaned hourly. `GOOGLE_ALLOWED_EMAILS` required — empty blocks all logins.
- **signup.js** — WhatsApp Embedded Signup. `GET /signup/:token` (landing page with Facebook SDK), `POST /signup/:token/complete` (exchanges auth code → subscribes WABA → registers phone → updates business). Token atomically marked used before Meta API calls. Requires all 4 Facebook config vars.
- **facebook-deletion.js** — Facebook Data Deletion Callback (required by Meta app review). `POST /facebook-data-deletion` (verifies `signed_request` HMAC-SHA256 against `FACEBOOK_APP_SECRET`, stores completed deletion record, returns `{ url, confirmation_code }`). `GET /facebook-data-deletion/:code` (status page for a deletion request). No-op since app stores no Facebook user data.
- **Static pages** — `public/privacy.html` (Privacy Policy) and `public/terms.html` (Terms of Service), linked from `public/index.html` footer. Required by Facebook App Review.
- **google-calendar.js** — Google Calendar OAuth invite flow. `GET /google-calendar/:token` (landing page with "Connect Google Calendar" button), `GET /google-calendar/callback` (OAuth callback — exchanges code, atomically marks invite used, stores `refresh_token` in `scheduling_config`). Reuses existing `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. The `/callback` route must be registered before `/:token` to avoid Express greedy matching.
- **admin.js** — All `/api/*` routes. Auth: dev mode (no auth configured) → Bearer token → session cookie → 401. POST/PATCH use zod validation (`req.validated`). Key endpoints:
  - Business CRUD, chat testing (rate-limited 20/min), scraping (async with job ID), conversations, customer memory, escalations, appointments, knowledge gaps
  - Signup invites: `POST /businesses/:id/signup-invite` (72h expiry), `GET /businesses/:id/signup-invites`
  - Telegram connection: `POST /businesses/:id/telegram-link` (generate deep link), `GET /businesses/:id/telegram-status` (poll via lazy `getUpdates`), `DELETE /businesses/:id/telegram` (disconnect)
  - Google Calendar: `POST /businesses/:id/google-calendar-invite` (72h expiry invite link), `GET /businesses/:id/google-calendar-status` (check if refresh_token exists)
  - `scheduling_config` API keys and `refresh_token` are redacted in responses; on PATCH, redacted values preserve existing secrets

### Services (`src/services/`)

- **db.js** — SQLite (better-sqlite3, WAL mode). Thirteen tables: `businesses`, `conversations`, `scraped_pages`, `scrape_jobs`, `customer_memory`, `escalations`, `appointments`, `sessions`, `signup_invites`, `data_deletion_requests`, `knowledge_gaps`, `telegram_links`, `google_calendar_invites`. Key behaviors:
  - Conversations: JSON array column + optional `conversation_summary` for compressed history
  - Escalations: partial unique index prevents duplicate active escalations per customer; `createEscalation()` returns `null` on constraint violation
  - Businesses: soft-delete (`active = 0`), looked up by `phone_number_id`. Optional columns: `boss_language` (he/ar/en), `scheduling_config`, `waba_id`, `boss_telegram_chat_id`
  - WhatsApp tokens encrypted at rest via `crypto.js`
  - Signup invites: token-based, `markSignupInviteUsed()` is atomic CAS
  - Knowledge gaps: `gap_type` (unanswered/uncertain/deflected), `status` (pending/answered/dismissed). Answered gaps are injected into AI prompt as Q&A pairs
  - Telegram links: token-based, 1-hour TTL, cleaned hourly. Used for one-click Telegram auto-connect flow
  - Google Calendar invites: token-based (32-byte hex), 72h TTL, `markGoogleCalendarInviteUsed()` is atomic CAS (mirrors `signup_invites` pattern)
  - **Gotcha**: `updateBusiness` uses COALESCE so it cannot set columns to NULL — use direct UPDATE statements (e.g. `clearTelegramChatId`) when nulling is needed

- **whatsapp.js** — Meta Cloud API client. Message flow: mark as read → 500ms pause → check escalation → typing indicator → generate reply → check `[ESCALATE]` → send.
  - **Media support**: handles `text`, `image`, and `audio` message types. `downloadMedia(mediaId, accessToken)` fetches media from Meta API in 2 steps (get URL → download binary). Returns `{ base64, mimeType }`. Has `maxContentLength` (10MB) and timeout (10s) guards. MIME codec params stripped (e.g. `audio/ogg; codecs=opus` → `audio/ogg`). Only text placeholders (`[Image]`, caption, or `[Voice message — ...]`) stored in DB — no base64 in conversation history.
  - **Voice message language hint**: voice messages include a language hint based on `business.boss_language` (defaults to Hebrew) to help Gemini understand non-English audio.
  - **Escalation**: always proceeds when detected — customer gets "connecting you..." message. Pre-generates escalation ID, sends boss notification via Telegram (if `boss_telegram_chat_id` configured), then creates DB record.
  - **Coexistence mode**: during escalation, customer messages saved to history but NOT forwarded — boss sees them in WhatsApp Business app directly.
  - **Boss notifications via Telegram**: escalation alerts and booking notifications sent to boss via Telegram Bot API (per-business `boss_telegram_chat_id`). Fire-and-forget booking notifications in configured language, with optional calendar link.

- **message-buffer.js** — Debounce buffer. Groups by `businessId:customerPhone`, waits `MESSAGE_BUFFER_MS` (5s) with hard cap `MESSAGE_BUFFER_MAX_MS` (15s). Buffer items carry optional `media` field for images/audio downloaded during the buffer window.

- **gemini.js** — Wraps `@google/genai`. Per-business rate limiting (sliding window, default 60/hour). Context caching via `gemini-cache.js` (cached tokens = 10% cost). Auto-injects Israel date/time + "no internal reasoning" instruction. Key features:
  - `generateReply(business, history, userMessage, customerPhone, media)` returns `{ reply, bookingResult }`. Optional `media` array of `{ base64, mimeType }` sent as Gemini `inlineData` parts alongside text. Thinking level: `low` for chat, `minimal` for utilities
  - Conversation summarization when messages exceed threshold (default 20), atomic trim in transaction
  - Chain-of-thought stripping: labeled prefixes + unlabeled English reasoning before RTL text
  - Scheduling function calling loop with hallucination detection and time mismatch correction
  - Async customer fact extraction (excludes scheduling data), serialized per customer
  - Async knowledge gap detection (`detectKnowledgeGaps()`) — fire-and-forget after each reply; answered gaps auto-injected into prompt via `buildKnowledgeBasePrompt()`
  - Escalation rules always appended; scheduling rules override escalation for booking requests
  - Configurable timeout (`GEMINI_TIMEOUT_MS` 30s) and retry (2x exponential backoff on 429/503)

- **gemini-cache.js** — Caches static system prompt + tools per business on Gemini API side. Content-hash based invalidation on config changes, scrape completion, service cache invalidation.

- **telegram.js** — Telegram Bot API client for boss notifications. System-wide `TELEGRAM_BOT_TOKEN`, per-business `boss_telegram_chat_id`. Uses HTML parse mode. Also handles auto-connect flow: `getBotUsername()` (cached `getMe`), `processStartCommands()` (lazy `getUpdates` polling with offset tracking, mutex-serialized).

- **calendar.js** — `.ics` file generation + in-memory booking cache (24h TTL). No external dependencies.

- **crypto.js** — AES-256-GCM encryption for tokens. Identity functions when `TOKEN_ENCRYPTION_KEY` not set (dev mode).

- **scraper/** — Website scraping pipeline (4 modules): `index.js` (job management, incremental mode), `discovery.js` (robots.txt + sitemap + BFS crawl, relevance scoring), `extractor.js` (structured content extraction, FAQs, metadata, hours in Hebrew/English), `context.js` (budget allocation by page type, total `SCRAPER_CONTEXT_MAX_CHARS` default 30000).

- **scheduling/** — Pluggable appointment system. Provider registry (`cal-com`, `acuity`, `calendly`, `square`, `internal`, `google-calendar`). `tools.js` handles Gemini function declarations and execution routing. `service-cache.js` (24h TTL, auto-invalidated on config change). `slot-cache.js` (30-min TTL, short IDs like s1/s2).
  - **Provider quirks**: Cal.com requires numeric `eventTypeId` and UID for cancel; Acuity uses PUT for cancel; Calendly uses URI-based IDs; Square needs `booking_version` for cancel.
  - **Internal provider**: SQLite-based, computes availability from `working_hours` config, race condition guard on booking.
  - **Google Calendar provider**: Hybrid — config-driven services/working hours (like `internal`) + Google Calendar API for conflict detection (Free/Busy) and event creation. Uses `extendedProperties.private` to tag Aiyelet-created events. OAuth2 `refresh_token` stored in `scheduling_config`. `getProvider()` injects `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` from app config.
  - `book_appointment` returns enriched results (formatted times, service name) but omits `booking_id` from customer-facing data.

### Admin Dashboard (`public/admin.html`)

Single-file vanilla JS dashboard at `/admin`. Hash-based routing, no build step/CDN. Auth: Google OAuth or API key. Pages: business CRUD, test chat, scraping, conversations, customer memory, escalations, knowledge gaps, WhatsApp Connection (Embedded Signup invites), Google Calendar (invite link generation + connection status), Telegram Notifications (one-click auto-connect with 3s polling).

### Config

All in `src/config.js`, loaded from `.env`. Secret vars support `_FILE` suffix for Docker secrets. Runtime data in `data/` (gitignored).

**Key env vars:**
- `GEMINI_API_KEY` (required), `DEFAULT_GEMINI_MODEL` (default `gemini-3-flash-preview`)
- `ADMIN_API_KEY` — Bearer token auth. `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_ALLOWED_EMAILS` — OAuth auth (also reused for Google Calendar provider OAuth)
- `FACEBOOK_APP_ID` + `FACEBOOK_APP_SECRET` + `FACEBOOK_LOGIN_CONFIG_ID` + `SYSTEM_USER_ACCESS_TOKEN` — Embedded Signup
- `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_API_VERSION`, `WHATSAPP_APP_SECRET` (required in production)
- `TOKEN_ENCRYPTION_KEY` (required in production) — encrypts WhatsApp tokens at rest
- `BASE_URL` — for calendar links, resume bot links, signup invite links
- `TELEGRAM_BOT_TOKEN` — system-wide Telegram bot token for boss notifications (escalations, bookings, reminders)
- `SENTRY_DSN` — error tracking
- Tuning: `GEMINI_TIMEOUT_MS` (30s), `GEMINI_RETRIES` (2), `GEMINI_THINKING_LEVEL` (low), `GEMINI_CACHE_ENABLED` (true), `GEMINI_RATE_LIMIT_PER_BUSINESS` (60/hr), `SCHEDULING_MAX_ITERATIONS` (8), `MESSAGE_BUFFER_MS` (5s), `CONVERSATION_SUMMARY_THRESHOLD` (20), `CONVERSATION_TTL_DAYS` (90), `ESCALATION_TIMEOUT_HOURS` (24), `ESCALATION_REMINDER_HOURS` (4), `LOG_LEVEL` (info)

**Production requirements:** `WHATSAPP_APP_SECRET`, `TOKEN_ENCRYPTION_KEY`, and at least one admin auth method.

### Tests & Production Hardening

- `src/index.js`: `helmet` (CSP disabled — admin uses inline scripts), request correlation IDs, Sentry integration, hourly maintenance (escalation checks, session/CSRF/conversation cleanup, slot cache sweep, old deletion requests cleanup, expired telegram links cleanup, expired google calendar invites cleanup)
- **Gotcha**: do NOT enable helmet's `contentSecurityPolicy` — breaks `admin.html` inline scripts
- **Gotcha**: in `admin.html`, call async status loaders (e.g. `loadGoogleCalendarStatus`, `loadTelegramStatus`) only AFTER all `innerHTML +=` appends are done — each `innerHTML +=` destroys and recreates the DOM, detaching nodes captured by earlier async calls
- Tests: Node.js built-in runner (`node:test` + `node:assert`). Unit tests in `tests/unit/`, integration in `tests/integration/`, shared setup in `tests/helpers/setup.js`
- **Gotcha**: use `getFullYear()`/`getMonth()`/`getDate()` for dates in tests — not `toISOString().split('T')[0]` which returns UTC and can be off by one day
