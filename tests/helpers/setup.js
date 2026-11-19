const crypto = require('crypto');
const config = require('../../src/config');

// Override config for testing
config.dbPath = ':memory:';
config.adminApiKey = 'test-api-key';
config.geminiApiKey = 'fake-key';
config.whatsappVerifyToken = 'test-verify-token';
config.whatsappAppSecret = '';
config.messageBufferMs = 100;
config.messageBufferMaxMs = 500;
config.googleClientId = null;
config.googleClientSecret = null;
config.googleAllowedEmails = [];

const db = require('../../src/services/db');

function createTestBusiness(overrides = {}) {
  const id = overrides.id || crypto.randomUUID();
  return db.createBusiness({
    id,
    name: overrides.name || 'Test Business',
    phone_number_id: overrides.phone_number_id || null,
    whatsapp_access_token: overrides.whatsapp_access_token || null,
    system_prompt: overrides.system_prompt || 'You are a test assistant.',
    website_url: overrides.website_url || null,
    gemini_model: overrides.gemini_model || 'gemini-3-flash-preview',
    boss_language: overrides.boss_language || null,
    scheduling_config: overrides.scheduling_config || null,
    waba_id: overrides.waba_id || null,
    boss_telegram_chat_id: overrides.boss_telegram_chat_id || null,
  });
}

function buildWebhookPayload(phoneNumberId, from, text) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'ENTRY_ID',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: phoneNumberId, display_phone_number: '15551234567' },
          contacts: [{ profile: { name: 'Test User' }, wa_id: from }],
          messages: [{
            from,
            id: 'wamid.' + crypto.randomUUID(),
            timestamp: Math.floor(Date.now() / 1000).toString(),
            text: { body: text },
            type: 'text',
          }],
        },
        field: 'messages',
      }],
    }],
  };
}

function buildWebhookImagePayload(phoneNumberId, from, mediaId, caption) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'ENTRY_ID',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: phoneNumberId, display_phone_number: '15551234567' },
          contacts: [{ profile: { name: 'Test User' }, wa_id: from }],
          messages: [{
            from,
            id: 'wamid.' + crypto.randomUUID(),
            timestamp: Math.floor(Date.now() / 1000).toString(),
            type: 'image',
            image: { id: mediaId, mime_type: 'image/jpeg', sha256: 'abc123', ...(caption && { caption }) },
          }],
        },
        field: 'messages',
      }],
    }],
  };
}

function buildWebhookAudioPayload(phoneNumberId, from, mediaId) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'ENTRY_ID',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: phoneNumberId, display_phone_number: '15551234567' },
          contacts: [{ profile: { name: 'Test User' }, wa_id: from }],
          messages: [{
            from,
            id: 'wamid.' + crypto.randomUUID(),
            timestamp: Math.floor(Date.now() / 1000).toString(),
            type: 'audio',
            audio: { id: mediaId, mime_type: 'audio/ogg; codecs=opus', sha256: 'abc123' },
          }],
        },
        field: 'messages',
      }],
    }],
  };
}

function buildSignature(body, secret) {
  const hmac = crypto.createHmac('sha256', secret)
    .update(typeof body === 'string' ? body : JSON.stringify(body))
    .digest('hex');
  return 'sha256=' + hmac;
}

function buildApp() {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const app = express();

  app.use(cookieParser());

  app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));

  const webhookRoutes = require('../../src/routes/webhook');
  const calendarRoutes = require('../../src/routes/calendar');
  const resumeRoutes = require('../../src/routes/resume');
  const authRoutes = require('../../src/routes/auth');
  const adminRoutes = require('../../src/routes/admin');

  const signupRoutes = require('../../src/routes/signup');
  const facebookDeletionRoutes = require('../../src/routes/facebook-deletion');

  app.use(webhookRoutes);
  app.use(calendarRoutes);
  app.use(resumeRoutes);
  app.use(signupRoutes);
  app.use(facebookDeletionRoutes);
  app.use('/auth', authRoutes);
  app.use('/api', adminRoutes);

  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

function cleanDb() {
  db.db.exec('DELETE FROM telegram_links');
  db.db.exec('DELETE FROM data_deletion_requests');
  db.db.exec('DELETE FROM knowledge_gaps');
  db.db.exec('DELETE FROM signup_invites');
  db.db.exec('DELETE FROM sessions');
  db.db.exec('DELETE FROM appointments');
  db.db.exec('DELETE FROM escalations');
  db.db.exec('DELETE FROM customer_memory');
  db.db.exec('DELETE FROM conversations');
  db.db.exec('DELETE FROM scraped_pages');
  db.db.exec('DELETE FROM scrape_jobs');
  db.db.exec('DELETE FROM businesses');
}

function createTestSession(email = 'test@example.com') {
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').replace('Z', '');
  db.createSession({ id, email, expires_at: expiresAt });
  return { id, email };
}

module.exports = { createTestBusiness, buildWebhookPayload, buildWebhookImagePayload, buildWebhookAudioPayload, buildSignature, buildApp, cleanDb, createTestSession, db, config };
