const { describe, it, beforeEach, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBusiness, cleanDb, db, config } = require('../helpers/setup');

// Mock axios before requiring modules
const axios = require('axios');
let postCalls = [];
mock.method(axios, 'post', async (url, body, opts) => {
  postCalls.push({ url, body, opts });
  return { data: { messages: [{ id: `wamid.reply-${postCalls.length}` }] } };
});

const gemini = require('../../src/services/gemini');
const telegram = require('../../src/services/telegram');
const whatsapp = require('../../src/services/whatsapp');

describe('notifyBossBooking via Telegram', () => {
  const savedBaseUrl = config.baseUrl;
  const savedTelegramToken = config.telegramBotToken;

  beforeEach(() => {
    cleanDb();
    postCalls = [];
    config.baseUrl = null;
    config.telegramBotToken = 'test-telegram-token';
  });

  afterEach(() => {
    config.baseUrl = savedBaseUrl;
    config.telegramBotToken = savedTelegramToken;
  });

  it('sends booking notification to Telegram when configured', async () => {
    const biz = createTestBusiness({

      boss_language: 'he',
      boss_telegram_chat_id: '-100123456789',
      scheduling_config: JSON.stringify({ provider: 'internal', timezone: 'Asia/Jerusalem', services: [], working_hours: {} }),
    });

    await whatsapp.notifyBossBooking(biz, biz.phone_number_id, '972501111111', {
      success: true,
      start_time: '2026-03-15T14:00:00+02:00',
      end_time: '2026-03-15T15:00:00+02:00',
      service_name: 'Haircut',
      formatted_start_time: '14:00',
    }, 'book me');

    // Should have called Telegram API, not WhatsApp
    const telegramCall = postCalls.find(c => c.url.includes('api.telegram.org'));
    assert.ok(telegramCall, 'Should have sent a Telegram message');
    assert.equal(telegramCall.body.chat_id, '-100123456789');
    assert.ok(telegramCall.body.text.includes('Haircut'));
    assert.ok(telegramCall.body.text.includes('14:00'));

    // No WhatsApp template calls
    const whatsappCall = postCalls.find(c => c.url.includes('graph.facebook.com'));
    assert.equal(whatsappCall, undefined, 'Should NOT have sent WhatsApp message');
  });

  it('includes calendar link when BASE_URL is set', async () => {
    config.baseUrl = 'https://example.com';
    const biz = createTestBusiness({

      boss_telegram_chat_id: '-100123456789',
      scheduling_config: JSON.stringify({ provider: 'internal', timezone: 'Asia/Jerusalem', services: [], working_hours: {} }),
    });

    await whatsapp.notifyBossBooking(biz, biz.phone_number_id, '972501111111', {
      success: true,
      start_time: '2026-03-15T14:00:00+02:00',
      end_time: '2026-03-15T15:00:00+02:00',
      service_name: 'Haircut',
      formatted_start_time: '14:00',
    }, 'book');

    const telegramCall = postCalls.find(c => c.url.includes('api.telegram.org'));
    assert.ok(telegramCall);
    assert.ok(telegramCall.body.text.includes('https://example.com/cal/'));
  });

  it('does nothing when boss has no telegram chat ID', async () => {
    const biz = createTestBusiness({

      scheduling_config: JSON.stringify({ provider: 'internal', timezone: 'Asia/Jerusalem', services: [], working_hours: {} }),
    });

    await whatsapp.notifyBossBooking(biz, biz.phone_number_id, '972501111111', {
      success: true,
      start_time: '2026-03-15T14:00:00+02:00',
      end_time: '2026-03-15T15:00:00+02:00',
      service_name: 'Haircut',
      formatted_start_time: '14:00',
    }, 'book');

    assert.equal(postCalls.length, 0, 'Should not have sent any message');
  });

  it('does nothing when Telegram is not configured', async () => {
    config.telegramBotToken = null;
    const biz = createTestBusiness({

      boss_telegram_chat_id: '-100123456789',
      scheduling_config: JSON.stringify({ provider: 'internal', timezone: 'Asia/Jerusalem', services: [], working_hours: {} }),
    });

    await whatsapp.notifyBossBooking(biz, biz.phone_number_id, '972501111111', {
      success: true,
      start_time: '2026-03-15T14:00:00+02:00',
      end_time: '2026-03-15T15:00:00+02:00',
      service_name: 'Haircut',
      formatted_start_time: '14:00',
    }, 'book');

    assert.equal(postCalls.length, 0, 'Should not have sent any message');
  });
});

describe('escalation notification via Telegram', () => {
  const savedBaseUrl = config.baseUrl;
  const savedTelegramToken = config.telegramBotToken;

  beforeEach(() => {
    cleanDb();
    postCalls = [];
    config.baseUrl = null;
    config.telegramBotToken = 'test-telegram-token';
  });

  afterEach(() => {
    config.baseUrl = savedBaseUrl;
    config.telegramBotToken = savedTelegramToken;
  });

  it('sends escalation to Telegram and creates escalation record', async () => {
    const biz = createTestBusiness({
      phone_number_id: 'pnid-tg-esc',
      whatsapp_access_token: 'tok-1',

      boss_telegram_chat_id: '-100123456789',
      system_prompt: 'You are a test bot',
    });

    mock.method(gemini, 'generateReply', async () => ({
      reply: '[ESCALATE] customer upset', bookingResult: null
    }));
    mock.method(gemini, 'summarizeConversation', async () => 'Summary text');
    mock.method(gemini, 'updateCustomerMemory', async () => {});

    const value = {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'pnid-tg-esc' },
      messages: [{
        from: '972501111111',
        id: 'wamid.incoming-1',
        timestamp: Math.floor(Date.now() / 1000).toString(),
        text: { body: 'I need help' },
        type: 'text',
      }],
    };

    await whatsapp.handleIncomingMessage(value);

    // Wait for message buffer to flush
    await new Promise(resolve => setTimeout(resolve, 800));

    // Should have sent Telegram message for boss notification
    const telegramCall = postCalls.find(c => c.url.includes('api.telegram.org'));
    assert.ok(telegramCall, 'Should have sent a Telegram message to boss');
    assert.equal(telegramCall.body.chat_id, '-100123456789');
    assert.ok(telegramCall.body.text.includes('customer upset'));

    // Escalation should be created
    const escalations = db.getActiveEscalationsForBoss(biz.id);
    assert.equal(escalations.length, 1);

    gemini.generateReply.mock.restore();
    gemini.summarizeConversation.mock.restore();
    gemini.updateCustomerMemory.mock.restore();
  });
});

describe('stale escalation reminders via Telegram', () => {
  const savedTelegramToken = config.telegramBotToken;

  beforeEach(() => {
    cleanDb();
    postCalls = [];
    config.telegramBotToken = 'test-telegram-token';
  });

  afterEach(() => {
    config.telegramBotToken = savedTelegramToken;
  });

  it('sends reminder via Telegram for stale escalations', async () => {
    const biz = createTestBusiness({
      phone_number_id: 'pnid-stale',
      whatsapp_access_token: 'tok-1',

      boss_telegram_chat_id: '-100123456789',
    });

    // Create a stale escalation (created long ago)
    db.createEscalation(biz.id, '972501111111', 'test reason');
    // Manually backdate the escalation
    db.db.prepare(`UPDATE escalations SET created_at = datetime('now', '-5 hours') WHERE business_id = ?`).run(biz.id);

    await whatsapp.checkStaleEscalations();

    const telegramCall = postCalls.find(c => c.url.includes('api.telegram.org'));
    assert.ok(telegramCall, 'Should have sent a Telegram reminder');
    assert.ok(telegramCall.body.text.includes('Reminder'));
  });

  it('does not send reminder when no Telegram configured', async () => {
    config.telegramBotToken = null;
    const biz = createTestBusiness({
      phone_number_id: 'pnid-stale-2',
      whatsapp_access_token: 'tok-1',

    });

    db.createEscalation(biz.id, '972501111111', 'test reason');
    db.db.prepare(`UPDATE escalations SET created_at = datetime('now', '-5 hours') WHERE business_id = ?`).run(biz.id);

    await whatsapp.checkStaleEscalations();

    assert.equal(postCalls.length, 0, 'Should not have sent any message');
  });
});
