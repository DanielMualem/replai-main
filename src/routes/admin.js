const { Router } = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const config = require('../config');
const db = require('../services/db');
const gemini = require('../services/gemini');
const scraper = require('../services/scraper');
const scheduling = require('../services/scheduling');
const { invalidateServicesCache } = require('../services/scheduling/tools');
const geminiCache = require('../services/gemini-cache');
const { sendMessage, getEscalationMessage } = require('../services/whatsapp');
const telegram = require('../services/telegram');
const logger = require('../logger');
const { validate, createBusinessSchema, updateBusinessSchema, chatSchema, updateCustomerMemorySchema, updateKnowledgeGapSchema } = require('../validation');
const { COOKIE_NAME } = require('./auth');

const INVITE_EXPIRY_MS = 72 * 60 * 60 * 1000; // 72 hours

const router = Router();

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.params.id + ':' + (req.body.phone || ipKeyGenerator(req)),
  message: { error: 'Too many requests, please try again later' },
});

function sanitizeBusiness(business) {
  if (!business) return business;
  const { whatsapp_access_token, scheduling_config, ...rest } = business;
  const sanitized = { ...rest, whatsapp_access_token: whatsapp_access_token ? '••••' + whatsapp_access_token.slice(-4) : null };
  if (scheduling_config) {
    try {
      const parsed = typeof scheduling_config === 'string' ? JSON.parse(scheduling_config) : scheduling_config;
      if (parsed.api_key) {
        parsed.api_key = '••••' + parsed.api_key.slice(-4);
      }
      if (parsed.refresh_token) {
        parsed.refresh_token = '••••' + parsed.refresh_token.slice(-4);
      }
      sanitized.scheduling_config = JSON.stringify(parsed);
    } catch (_) {
      sanitized.scheduling_config = scheduling_config;
    }
  } else {
    sanitized.scheduling_config = null;
  }
  return sanitized;
}

// --- Auth middleware ---

router.use((req, res, next) => {
  // Dev mode: no auth configured at all
  const googleOAuthConfigured = !!(config.googleClientId && config.googleClientSecret);
  if (!config.adminApiKey && !googleOAuthConfigured) return next();

  // 1. Bearer token (checked first — no DB hit for programmatic access)
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    if (!config.adminApiKey) {
      return res.status(403).json({ error: 'API key auth not configured' });
    }
    const token = header.slice(7);
    const a = Buffer.from(token);
    const b = Buffer.from(config.adminApiKey);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: 'Invalid API key' });
    }
    return next();
  }

  // 2. Session cookie
  const sessionId = req.cookies?.[COOKIE_NAME];
  if (sessionId) {
    const session = db.getSession(sessionId);
    if (session) {
      req.userEmail = session.email;
      return next();
    }
  }

  // 3. No valid credentials
  return res.status(401).json({ error: 'Authentication required' });
});

// --- Businesses ---

router.post('/businesses', validate(createBusinessSchema), async (req, res, next) => {
  try {
    const { name, phone_number_id, whatsapp_access_token, system_prompt, website_url, gemini_model, boss_language, boss_telegram_chat_id, scheduling_config } = req.validated;

    const id = crypto.randomUUID();
    const configStr = scheduling_config ? JSON.stringify(scheduling_config) : null;
    const business = db.createBusiness({ id, name, phone_number_id, whatsapp_access_token, system_prompt, website_url, gemini_model, boss_language, boss_telegram_chat_id, scheduling_config: configStr });

    let scrapeJob = null;
    if (website_url) {
      try {
        scrapeJob = await scraper.startScrape(id);
      } catch (err) {
        logger.error({ businessId: id, error: err.message }, 'Initial scrape failed to start');
      }
    }

    const response = sanitizeBusiness(business);
    if (scrapeJob) response.scrape_job_id = scrapeJob.id;
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

router.get('/businesses', (_req, res) => {
  res.json(db.listBusinesses().map(sanitizeBusiness));
});

router.get('/businesses/:id', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  res.json(sanitizeBusiness(business));
});

router.patch('/businesses/:id', validate(updateBusinessSchema), (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const { name, phone_number_id, whatsapp_access_token, system_prompt, website_url, gemini_model, boss_language, boss_telegram_chat_id, scheduling_config, subscription_plan } = req.validated;

  // Preserve explicit null for clearing scheduling_config; stringify object values
  const updates = { name, phone_number_id, whatsapp_access_token, system_prompt, website_url, gemini_model, boss_language, boss_telegram_chat_id };
  if (subscription_plan) updates.subscription_plan = subscription_plan;
  if ('scheduling_config' in req.body && req.body.scheduling_config === null) {
    updates.scheduling_config = null;
  } else if (scheduling_config) {
    // If api_key or refresh_token is missing or redacted, preserve the existing value from DB
    try {
      const existing = typeof business.scheduling_config === 'string'
        ? JSON.parse(business.scheduling_config) : business.scheduling_config;
      if (existing) {
        if ((!scheduling_config.api_key || /^[•*]+/.test(scheduling_config.api_key)) && existing.api_key) {
          scheduling_config.api_key = existing.api_key;
        }
        if ((!scheduling_config.refresh_token || /^[•*]+/.test(scheduling_config.refresh_token)) && existing.refresh_token) {
          scheduling_config.refresh_token = existing.refresh_token;
        }
      }
    } catch (_) { /* keep as-is */ }
    updates.scheduling_config = JSON.stringify(scheduling_config);
  }

  // Invalidate services cache when scheduling_config changes (also invalidates Gemini cache)
  if ('scheduling_config' in updates) {
    invalidateServicesCache(req.params.id);
  }

  // Invalidate Gemini cache if any static prompt component changed
  if ('system_prompt' in updates) {
    geminiCache.markInvalid(req.params.id);
  }

  const updated = db.updateBusiness(req.params.id, updates);
  res.json(sanitizeBusiness(updated));
});

router.delete('/businesses/:id', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  db.deactivateBusiness(req.params.id);
  res.status(204).end();
});

router.post('/businesses/:id/activate', (req, res) => {
  const business = db.getBusinessIncludingInactive(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  db.activateBusiness(req.params.id);
  res.json(sanitizeBusiness(db.getBusiness(req.params.id)));
});

// --- Test Chat (no WhatsApp needed) ---

router.post('/businesses/:id/chat', chatLimiter, validate(chatSchema), async (req, res, next) => {
  try {
    const business = db.getBusiness(req.params.id);
    if (!business) return res.status(404).json({ error: 'Business not found' });

    const { message, phone } = req.validated;

    const customerPhone = phone || 'test-user';
    const conversation = db.getConversation(req.params.id, customerPhone);
    const history = conversation ? conversation.messages : [];

    const { reply } = await gemini.generateReply(business, history, message, customerPhone);

    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: reply });

    const trimmed = history.slice(-config.maxConversationMessages * 2);
    db.saveConversation(req.params.id, customerPhone, trimmed);

    // Async: extract and store customer facts (fire-and-forget)
    gemini.updateCustomerMemory(business, customerPhone, message, reply).catch(() => {});
    // Async: detect knowledge gaps (fire-and-forget)
    gemini.detectKnowledgeGaps(business, message, reply, customerPhone).catch(() => {});
    // Async: summarize conversation if threshold reached (fire-and-forget)
    gemini.maybeSummarizeConversation(business, customerPhone, trimmed).catch(() => {});

    res.json({ reply, phone: customerPhone });
  } catch (err) {
    next(err);
  }
});

// --- Scraper ---

router.post('/businesses/:id/scrape', async (req, res, next) => {
  try {
    const business = db.getBusiness(req.params.id);
    if (!business) return res.status(404).json({ error: 'Business not found' });
    if (!business.website_url) return res.status(400).json({ error: 'No website_url configured' });

    const options = { incremental: req.body?.incremental || false };
    const job = await scraper.startScrape(req.params.id, options);

    res.status(202).json({
      job_id: job.id,
      poll_url: `/api/businesses/${req.params.id}/scrape/${job.id}`,
    });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: err.message, job_id: err.jobId });
    }
    next(err);
  }
});

router.get('/businesses/:id/scrape/:jobId', (req, res) => {
  const job = scraper.getScrapeStatus(req.params.jobId);
  if (!job || job.business_id !== req.params.id) {
    return res.status(404).json({ error: 'Scrape job not found' });
  }
  res.json(job);
});

router.get('/businesses/:id/scrape', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const job = scraper.getLatestScrapeStatus(req.params.id);
  const pages = db.getScrapedPages(req.params.id).map(({ id, url, title, page_type, scraped_at }) => ({
    id, url, title, page_type, scraped_at,
  }));

  res.json({ latest_job: job || null, page_count: pages.length, pages });
});

router.get('/businesses/:id/pages', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  res.json(db.getScrapedPages(req.params.id));
});

router.delete('/businesses/:id/pages', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  db.deleteBusinessScrapedPages(req.params.id);
  geminiCache.markInvalid(req.params.id);

  res.status(204).end();
});

// --- Customer Memory ---

router.get('/businesses/:id/customers', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const limit = parseInt(req.query.limit, 10) || 20;
  const offset = parseInt(req.query.offset, 10) || 0;
  res.json(db.listCustomerMemories(req.params.id, limit, offset));
});

router.get('/businesses/:id/customers/:phone', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const memory = db.getCustomerMemory(req.params.id, req.params.phone);
  if (!memory) return res.status(404).json({ error: 'Customer memory not found' });
  res.json(memory);
});

router.patch('/businesses/:id/customers/:phone', validate(updateCustomerMemorySchema), (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const { facts } = req.validated;

  const existing = db.getCustomerMemory(req.params.id, req.params.phone);
  const prev = existing ? existing.facts : {};
  const merged = { ...prev, ...facts };
  // Append notes rather than replacing
  if (Array.isArray(facts.notes) && Array.isArray(prev.notes)) {
    const combined = [...prev.notes];
    for (const note of facts.notes) {
      if (!combined.some((n) => n.toLowerCase() === note.toLowerCase())) {
        combined.push(note);
      }
    }
    merged.notes = combined.slice(-20);
  }
  db.saveCustomerMemory(req.params.id, req.params.phone, merged);

  const updated = db.getCustomerMemory(req.params.id, req.params.phone);
  res.json(updated);
});

router.delete('/businesses/:id/customers/:phone', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  db.deleteCustomerMemory(req.params.id, req.params.phone);
  res.status(204).end();
});

router.delete('/businesses/:id/customers', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  db.deleteBusinessCustomerMemories(req.params.id);
  res.status(204).end();
});

// --- Knowledge Gaps ---

router.get('/businesses/:id/knowledge-gaps', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const limit = parseInt(req.query.limit, 10) || 20;
  const offset = parseInt(req.query.offset, 10) || 0;
  const status = req.query.status || undefined;
  res.json(db.listKnowledgeGaps(req.params.id, { status, limit, offset }));
});

router.get('/businesses/:id/knowledge-gaps/stats', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  res.json(db.countKnowledgeGaps(req.params.id));
});

router.patch('/businesses/:id/knowledge-gaps/:gapId', validate(updateKnowledgeGapSchema), (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const gap = db.getKnowledgeGap(req.params.gapId);
  if (!gap || gap.business_id !== req.params.id) {
    return res.status(404).json({ error: 'Knowledge gap not found' });
  }

  const updated = db.updateKnowledgeGap(req.params.gapId, req.validated);
  res.json(updated);
});

router.delete('/businesses/:id/knowledge-gaps/:gapId', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const gap = db.getKnowledgeGap(req.params.gapId);
  if (!gap || gap.business_id !== req.params.id) {
    return res.status(404).json({ error: 'Knowledge gap not found' });
  }

  db.deleteKnowledgeGap(req.params.gapId);
  res.status(204).end();
});

// --- Escalations ---

router.get('/businesses/:id/escalations', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const limit = parseInt(req.query.limit, 10) || 20;
  const offset = parseInt(req.query.offset, 10) || 0;
  res.json(db.listEscalations(req.params.id, limit, offset));
});

router.post('/businesses/:id/escalations/:escId/resolve', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const esc = db.getEscalation(req.params.escId);
  if (!esc || esc.business_id !== req.params.id) {
    return res.status(404).json({ error: 'Escalation not found' });
  }
  if (esc.status === 'resolved') {
    return res.status(400).json({ error: 'Escalation already resolved' });
  }

  const resolved = db.resolveEscalation(req.params.escId);
  res.json(resolved);

  // Notify customer they're back with the AI (fire-and-forget)
  if (business.phone_number_id && business.whatsapp_access_token) {
    const conv = db.getConversation(business.id, esc.customer_phone);
    const lastUserMsg = conv?.messages?.filter(m => m.role === 'user').pop()?.content || '';
    const backMsg = getEscalationMessage('backToAI', lastUserMsg);
    sendMessage(business.phone_number_id, business.whatsapp_access_token, esc.customer_phone, backMsg)
      .catch(err => logger.error({ err, escalationId: esc.id }, 'Failed to notify customer of escalation resolve'));
  }
});

// --- Scheduling Providers ---

router.get('/scheduling/providers', (_req, res) => {
  res.json(scheduling.listProviders());
});

// --- Scheduling Services Cache ---

router.post('/businesses/:id/scheduling/refresh-services', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  invalidateServicesCache(req.params.id);
  res.json({ success: true, message: 'Services cache invalidated' });
});

// --- Appointments ---

router.get('/businesses/:id/appointments', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const limit = parseInt(req.query.limit, 10) || 20;
  const offset = parseInt(req.query.offset, 10) || 0;
  const status = req.query.status || undefined;
  res.json(db.listAppointments(req.params.id, { status, limit, offset }));
});

router.patch('/businesses/:id/appointments/:appointmentId', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const appointment = db.getAppointment(req.params.appointmentId);
  if (!appointment || appointment.business_id !== req.params.id) {
    return res.status(404).json({ error: 'Appointment not found' });
  }
  if (appointment.status === 'cancelled') {
    return res.status(400).json({ error: 'Appointment already cancelled' });
  }

  const updated = db.updateAppointmentStatus(req.params.appointmentId, 'cancelled');
  res.json(updated);
});

// --- Signup Invites ---

router.post('/businesses/:id/signup-invite', (req, res) => {
  if (!config.baseUrl) {
    return res.status(400).json({ error: 'BASE_URL must be configured to generate invite links' });
  }
  if (!config.facebookAppId || !config.facebookAppSecret || !config.facebookLoginConfigId || !config.systemUserAccessToken) {
    return res.status(400).json({ error: 'Facebook Embedded Signup is not fully configured (FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, FACEBOOK_LOGIN_CONFIG_ID, SYSTEM_USER_ACCESS_TOKEN)' });
  }

  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

  db.createSignupInvite(req.params.id, token, expiresAt);

  res.status(201).json({
    url: `${config.baseUrl}/signup/${token}`,
    token,
    expires_at: expiresAt,
  });
});

router.get('/businesses/:id/signup-invites', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const limit = parseInt(req.query.limit, 10) || 20;
  const offset = parseInt(req.query.offset, 10) || 0;
  res.json(db.listSignupInvites(req.params.id, limit, offset));
});

// --- Telegram Connection ---

router.post('/businesses/:id/telegram-link', async (req, res, next) => {
  try {
    if (!telegram.isConfigured()) {
      return res.status(400).json({ error: 'Telegram bot token is not configured' });
    }
    const business = db.getBusiness(req.params.id);
    if (!business) return res.status(404).json({ error: 'Business not found' });
    if (business.boss_telegram_chat_id) {
      return res.status(400).json({ error: 'Telegram is already connected' });
    }

    db.deleteTelegramLinksByBusiness(req.params.id);
    const token = crypto.randomUUID();
    db.createTelegramLink(token, req.params.id);

    let username;
    try {
      username = await telegram.getBotUsername();
    } catch (_) {
      return res.status(400).json({ error: 'Failed to verify Telegram bot token' });
    }
    res.json({ url: `https://t.me/${username}?start=${token}` });
  } catch (err) {
    next(err);
  }
});

router.get('/businesses/:id/telegram-status', async (req, res, next) => {
  try {
    const business = db.getBusiness(req.params.id);
    if (!business) return res.status(404).json({ error: 'Business not found' });

    if (business.boss_telegram_chat_id) {
      return res.json({ connected: true, chat_id: business.boss_telegram_chat_id });
    }

    const link = db.getPendingTelegramLinkByBusinessId(req.params.id);
    if (!link) {
      return res.json({ connected: false, pending: false });
    }

    // Check if link expired (1 hour)
    const createdAt = new Date(link.created_at + 'Z').getTime();
    if (Date.now() - createdAt > 60 * 60 * 1000) {
      db.deleteTelegramLink(link.token);
      return res.json({ connected: false, pending: false, expired: true });
    }

    // Process all pending /start commands from Telegram
    const startCommands = await telegram.processStartCommands();
    for (const { token, chatId } of startCommands) {
      const matchedLink = db.getTelegramLinkByToken(token);
      if (matchedLink) {
        db.updateBusiness(matchedLink.business_id, { boss_telegram_chat_id: chatId });
        db.deleteTelegramLink(token);
        // Send confirmation message (fire-and-forget)
        telegram.sendMessage(chatId, 'Connected! You will now receive boss notifications here.').catch(() => {});
      }
    }

    // Re-fetch business to check if this business got connected
    const updated = db.getBusiness(req.params.id);
    if (updated.boss_telegram_chat_id) {
      return res.json({ connected: true, chat_id: updated.boss_telegram_chat_id });
    }

    return res.json({ connected: false, pending: true });
  } catch (err) {
    next(err);
  }
});

// --- Google Calendar Connection ---

router.post('/businesses/:id/google-calendar-invite', (req, res) => {
  if (!config.baseUrl) {
    return res.status(400).json({ error: 'BASE_URL must be configured to generate invite links' });
  }
  if (!config.googleClientId || !config.googleClientSecret) {
    return res.status(400).json({ error: 'Google OAuth is not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)' });
  }

  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

  db.createGoogleCalendarInvite(req.params.id, token, expiresAt);

  res.status(201).json({
    url: `${config.baseUrl}/google-calendar/${token}`,
    token,
    expires_at: expiresAt,
  });
});

router.get('/businesses/:id/google-calendar-status', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  let connected = false;
  if (business.scheduling_config) {
    try {
      const parsed = typeof business.scheduling_config === 'string'
        ? JSON.parse(business.scheduling_config) : business.scheduling_config;
      connected = !!(parsed.provider === 'google-calendar' && parsed.refresh_token);
    } catch (_) { /* not connected */ }
  }

  res.json({ connected });
});

router.delete('/businesses/:id/telegram', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  db.clearTelegramChatId(req.params.id);
  db.deleteTelegramLinksByBusiness(req.params.id);
  res.status(204).end();
});

// --- Conversations ---

router.get('/businesses/:id/conversations', (req, res) => {
  const business = db.getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const limit = parseInt(req.query.limit, 10) || 20;
  const offset = parseInt(req.query.offset, 10) || 0;
  res.json(db.listConversations(req.params.id, limit, offset));
});

router.get('/businesses/:id/conversations/:phone', (req, res) => {
  const conversation = db.getConversation(req.params.id, req.params.phone);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  res.json(conversation);
});

router.delete('/businesses/:id/conversations/:phone', (req, res) => {
  const conversation = db.getConversation(req.params.id, req.params.phone);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  db.deleteConversation(conversation.id);
  res.status(204).end();
});

// --- Status ---

router.get('/status', (_req, res) => {
  res.json({
    uptime: process.uptime(),
    businesses: db.listBusinesses().length,
  });
});

module.exports = router;
