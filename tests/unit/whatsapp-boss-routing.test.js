const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBusiness, cleanDb, db, config } = require('../helpers/setup');

// Mock axios before requiring whatsapp module
const axios = require('axios');
let postCalls = [];
mock.method(axios, 'post', async (url, body, opts) => {
  postCalls.push({ url, body, opts });
  return { data: { messages: [{ id: `wamid.reply-${postCalls.length}` }] } };
});

const gemini = require('../../src/services/gemini');
const calendar = require('../../src/services/calendar');
const whatsapp = require('../../src/services/whatsapp');

describe('Boss booking notification (notifyBossBooking)', () => {
  let savedTelegramToken;
  beforeEach(() => {
    cleanDb();
    postCalls = [];
    savedTelegramToken = config.telegramBotToken;
    config.telegramBotToken = 'test-telegram-token';
  });

  afterEach(() => {
    config.telegramBotToken = savedTelegramToken;
  });

  it('sends boss notification with correct booking details and .ics link when BASE_URL set', async () => {
    const origBaseUrl = config.baseUrl;
    config.baseUrl = 'https://example.com';
    try {
      const biz = createTestBusiness({
        phone_number_id: 'pnid-notif-1',
        whatsapp_access_token: 'tok-n1',
        boss_telegram_chat_id: '-100123456789',
        scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'k', timezone: 'Asia/Jerusalem' }),
      });

      await whatsapp.notifyBossBooking(biz, 'pnid-notif-1', '972501111111', {
        success: true,
        start_time: '2026-03-15T14:00:00+02:00',
        end_time: '2026-03-15T15:00:00+02:00',
        formatted_start_time: '14:00',
        service_name: 'Consultation',
      }, 'I want a consultation');

      const telegramCalls = postCalls.filter((c) => c.url.includes('api.telegram.org'));
      assert.equal(telegramCalls.length, 1);
      const msg = telegramCalls[0].body.text;
      assert.match(msg, /📅/);
      assert.match(msg, /תור חדש/); // Hebrew by default (boss_language)
      assert.match(msg, /Consultation/);
      assert.match(msg, /14:00/);
      assert.match(msg, /972501111111/);
      // calendar link with Hebrew label
      assert.match(msg, /הכנס ליומן/);
      assert.match(msg, /https:\/\/example\.com\/cal\/[a-f0-9-]+/);
    } finally {
      config.baseUrl = origBaseUrl;
    }
  });

  it('sends boss notification without calendar link when BASE_URL is not set', async () => {
    const origBaseUrl = config.baseUrl;
    config.baseUrl = null;
    try {
      const biz = createTestBusiness({
        phone_number_id: 'pnid-notif-nourl',
        whatsapp_access_token: 'tok-nourl',
        boss_telegram_chat_id: '-100123456789',
        scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'k', timezone: 'Asia/Jerusalem' }),
      });

      await whatsapp.notifyBossBooking(biz, 'pnid-notif-nourl', '972501111111', {
        success: true,
        start_time: '2026-03-15T14:00:00+02:00',
        formatted_start_time: '14:00',
        service_name: 'Consultation',
      }, 'I want a consultation');

      const telegramCalls = postCalls.filter((c) => c.url.includes('api.telegram.org'));
      assert.equal(telegramCalls.length, 1);
      const msg = telegramCalls[0].body.text;
      assert.match(msg, /תור חדש/); // Hebrew by default
      assert.match(msg, /Consultation/);
      assert.match(msg, /14:00/);
      // No calendar link
      assert.ok(!msg.includes('/cal/'));
      assert.ok(!msg.includes('calendar.google.com'));
    } finally {
      config.baseUrl = origBaseUrl;
    }
  });

  it('does not send notification when no boss_telegram_chat_id', async () => {
    const biz = createTestBusiness({
      phone_number_id: 'pnid-notif-2',
      whatsapp_access_token: 'tok-n2',
    });

    await whatsapp.notifyBossBooking(biz, 'pnid-notif-2', '972501111111', {
      success: true,
      start_time: '2026-03-15T14:00:00+02:00',
      formatted_start_time: '14:00',
      service_name: 'Consultation',
    }, 'book me');

    assert.equal(postCalls.length, 0);
  });

  it('does not send notification when bookingResult is null', async () => {
    const biz = createTestBusiness({
      phone_number_id: 'pnid-notif-3',
      whatsapp_access_token: 'tok-n3',
      boss_telegram_chat_id: '-100123456789',
    });

    await whatsapp.notifyBossBooking(biz, 'pnid-notif-3', '972501111111', null, 'hello');

    assert.equal(postCalls.length, 0);
  });

  it('does not send notification when booking was unsuccessful', async () => {
    const biz = createTestBusiness({
      phone_number_id: 'pnid-notif-4',
      whatsapp_access_token: 'tok-n4',
      boss_telegram_chat_id: '-100123456789',
    });

    await whatsapp.notifyBossBooking(biz, 'pnid-notif-4', '972501111111', {
      success: false,
      error: 'Slot not available',
    }, 'book me');

    assert.equal(postCalls.length, 0);
  });

  it('notification failure does not throw', async () => {
    const biz = createTestBusiness({
      phone_number_id: 'pnid-notif-5',
      whatsapp_access_token: 'tok-n5',
      boss_telegram_chat_id: '-100123456789',
    });

    // Temporarily make sendMessage fail by replacing the mock
    const failMock = mock.method(axios, 'post', async () => { throw new Error('Network error'); });

    try {
      // Should not throw
      await whatsapp.notifyBossBooking(biz, 'pnid-notif-5', '972501111111', {
        success: true,
        start_time: '2026-03-15T14:00:00+02:00',
        formatted_start_time: '14:00',
        service_name: 'Haircut',
      }, 'book me');
    } finally {
      failMock.mock.restore();
    }
  });

  it('.ics link stored in cache is retrievable and contains correct data', async () => {
    const origBaseUrl = config.baseUrl;
    config.baseUrl = 'https://example.com';
    try {
      const biz = createTestBusiness({
        phone_number_id: 'pnid-notif-ics',
        whatsapp_access_token: 'tok-ics',
        boss_telegram_chat_id: '-100123456789',
        scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'k', timezone: 'Asia/Jerusalem' }),
      });

      const bookingResult = {
        success: true,
        start_time: '2026-03-15T12:00:00Z',
        end_time: '2026-03-15T12:30:00Z',
        formatted_start_time: '12:00',
        service_name: 'Quick Cut',
      };

      await whatsapp.notifyBossBooking(biz, 'pnid-notif-ics', '972501111111', bookingResult, 'book me');

      // Extract calendar URL from the Telegram message
      const telegramCall = postCalls.find(c => c.url.includes('api.telegram.org'));
      assert.ok(telegramCall, 'Should have sent Telegram message');
      const msg = telegramCall.body.text;
      const icsMatch = msg.match(/https:\/\/example\.com\/cal\/([a-f0-9-]+)/);
      assert.ok(icsMatch, 'Message should contain calendar URL');

      // Verify the booking is retrievable from cache
      const data = calendar.getBooking(icsMatch[1]);
      assert.ok(data);
      assert.equal(data.bookingResult.service_name, 'Quick Cut');
      assert.equal(data.label, '+972501111111');
      assert.equal(data.businessName, 'Test Business');

      // Verify .ics generation
      const ics = calendar.generateIcs(data);
      assert.match(ics, /BEGIN:VCALENDAR/);
      assert.match(ics, /BEGIN:VEVENT/);
      assert.match(ics, /DTSTART:20260315T120000Z/);
      assert.match(ics, /DTEND:20260315T123000Z/);
      assert.match(ics, /Quick Cut/);
    } finally {
      config.baseUrl = origBaseUrl;
    }
  });

  it('uses Hebrew template by default (boss_language not set)', async () => {
    const biz = createTestBusiness({
      phone_number_id: 'pnid-notif-6',
      whatsapp_access_token: 'tok-n6',
      boss_telegram_chat_id: '-100123456789',
      scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'k', timezone: 'Asia/Jerusalem' }),
    });

    await whatsapp.notifyBossBooking(biz, 'pnid-notif-6', '972501111111', {
      success: true,
      start_time: '2026-03-15T14:00:00+02:00',
      formatted_start_time: '14:00',
      service_name: 'Haircut',
    }, 'I want a haircut');

    const telegramCall = postCalls.find(c => c.url.includes('api.telegram.org'));
    assert.ok(telegramCall);
    assert.match(telegramCall.body.text, /תור חדש/);
  });

  it('uses English template when boss_language is en', async () => {
    const biz = createTestBusiness({
      phone_number_id: 'pnid-notif-7',
      whatsapp_access_token: 'tok-n7',
      boss_language: 'en',
      boss_telegram_chat_id: '-100123456789',
      scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'k', timezone: 'Asia/Jerusalem' }),
    });

    await whatsapp.notifyBossBooking(biz, 'pnid-notif-7', '972501111111', {
      success: true,
      start_time: '2026-03-15T14:00:00+02:00',
      formatted_start_time: '14:00',
      service_name: 'Haircut',
    }, 'אני רוצה לקבוע תור');

    const telegramCall = postCalls.find(c => c.url.includes('api.telegram.org'));
    assert.ok(telegramCall);
    assert.match(telegramCall.body.text, /New appointment/);
  });
});
