const { describe, it, before, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBusiness, cleanDb, buildApp, createTestSession, config, db } = require('../helpers/setup');
const { COOKIE_NAME } = require('../../src/routes/auth');
const request = require('supertest');

// Require gemini so we can mock its methods
const gemini = require('../../src/services/gemini');
const telegram = require('../../src/services/telegram');

let app;

before(() => {
  app = buildApp();
});

beforeEach(() => {
  cleanDb();
  mock.restoreAll();
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
describe('Admin auth middleware', () => {
  it('returns 401 when no credentials provided', async () => {
    const res = await request(app).get('/api/businesses');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Authentication required');
  });

  it('returns 403 when API key is wrong', async () => {
    const res = await request(app)
      .get('/api/businesses')
      .set('Authorization', 'Bearer wrong-key');
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Invalid API key');
  });

  it('returns 200 with correct API key', async () => {
    const res = await request(app)
      .get('/api/businesses')
      .set('Authorization', 'Bearer test-api-key');
    assert.equal(res.status, 200);
  });

  it('returns 200 with valid session cookie', async () => {
    const session = createTestSession('admin@test.com');
    const res = await request(app)
      .get('/api/status')
      .set('Cookie', `${COOKIE_NAME}=${session.id}`);
    assert.equal(res.status, 200);
  });

  it('returns 401 with expired session cookie', async () => {
    const crypto = require('crypto');
    const db = require('../../src/services/db');
    const id = crypto.randomBytes(32).toString('hex');
    const pastDate = new Date(Date.now() - 1000).toISOString().replace('T', ' ').replace('Z', '');
    db.createSession({ id, email: 'expired@test.com', expires_at: pastDate });

    const res = await request(app)
      .get('/api/status')
      .set('Cookie', `${COOKIE_NAME}=${id}`);
    assert.equal(res.status, 401);
  });

  it('bypasses auth when no auth methods are configured', async () => {
    const original = config.adminApiKey;
    try {
      config.adminApiKey = '';
      const res = await request(app).get('/api/businesses');
      assert.equal(res.status, 200);
    } finally {
      config.adminApiKey = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Helper: authenticated request shortcuts
// ---------------------------------------------------------------------------
function authGet(url) {
  return request(app).get(url).set('Authorization', 'Bearer test-api-key');
}
function authPost(url) {
  return request(app).post(url).set('Authorization', 'Bearer test-api-key');
}
function authPatch(url) {
  return request(app).patch(url).set('Authorization', 'Bearer test-api-key');
}
function authDelete(url) {
  return request(app).delete(url).set('Authorization', 'Bearer test-api-key');
}

// ---------------------------------------------------------------------------
// Business CRUD
// ---------------------------------------------------------------------------
describe('Business endpoints', () => {
  it('POST /api/businesses creates a business and returns 201', async () => {
    const res = await authPost('/api/businesses')
      .send({ name: 'My Biz', whatsapp_access_token: 'secret-token-1234' });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'My Biz');
    assert.ok(res.body.id);
    // Token should be masked
    assert.equal(res.body.whatsapp_access_token, '••••1234');
  });

  it('POST /api/businesses without name returns 400', async () => {
    const res = await authPost('/api/businesses').send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'name is required');
  });

  it('GET /api/businesses returns an array of businesses', async () => {
    createTestBusiness({ name: 'Biz A' });
    createTestBusiness({ name: 'Biz B' });

    const res = await authGet('/api/businesses');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 2);
  });

  it('GET /api/businesses/:id returns the business', async () => {
    const biz = createTestBusiness({ name: 'Single Biz' });

    const res = await authGet(`/api/businesses/${biz.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Single Biz');
    assert.equal(res.body.id, biz.id);
  });

  it('GET /api/businesses/:id returns 404 for unknown id', async () => {
    const res = await authGet('/api/businesses/nonexistent-id');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Business not found');
  });

  it('PATCH /api/businesses/:id updates and returns the business', async () => {
    const biz = createTestBusiness({ name: 'Old Name' });

    const res = await authPatch(`/api/businesses/${biz.id}`)
      .send({ name: 'New Name' });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'New Name');
  });

  it('DELETE /api/businesses/:id soft-deletes and returns 204', async () => {
    const biz = createTestBusiness();

    const res = await authDelete(`/api/businesses/${biz.id}`);
    assert.equal(res.status, 204);

    // Should no longer appear in list
    const listRes = await authGet('/api/businesses');
    assert.equal(listRes.body.length, 0);
  });

  it('POST /api/businesses/:id/activate reactivates a deleted business', async () => {
    const biz = createTestBusiness();
    await authDelete(`/api/businesses/${biz.id}`);

    const res = await authPost(`/api/businesses/${biz.id}/activate`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, biz.id);

    const listRes = await authGet('/api/businesses');
    assert.equal(listRes.body.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Chat endpoint
// ---------------------------------------------------------------------------
describe('Chat endpoint', () => {
  it('POST /api/businesses/:id/chat returns a reply', async () => {
    const biz = createTestBusiness();
    mock.method(gemini, 'generateReply', async () => ({ reply: 'mocked reply', bookingResult: null }));
    mock.method(gemini, 'updateCustomerMemory', async () => {});

    const res = await authPost(`/api/businesses/${biz.id}/chat`)
      .send({ message: 'Hello' });
    assert.equal(res.status, 200);
    assert.equal(res.body.reply, 'mocked reply');
    assert.equal(res.body.phone, 'test-user');
  });

  it('POST /api/businesses/:id/chat without message returns 400', async () => {
    const biz = createTestBusiness();

    const res = await authPost(`/api/businesses/${biz.id}/chat`)
      .send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'message is required');
  });

  it('POST /api/businesses/:id/chat saves conversation to DB', async () => {
    const biz = createTestBusiness();
    mock.method(gemini, 'generateReply', async () => ({ reply: 'saved reply', bookingResult: null }));
    mock.method(gemini, 'updateCustomerMemory', async () => {});

    await authPost(`/api/businesses/${biz.id}/chat`)
      .send({ message: 'Hi there', phone: '972501234567' });

    const convRes = await authGet(`/api/businesses/${biz.id}/conversations/972501234567`);
    assert.equal(convRes.status, 200);
    assert.equal(convRes.body.messages.length, 2);
    assert.equal(convRes.body.messages[0].role, 'user');
    assert.equal(convRes.body.messages[0].content, 'Hi there');
    assert.equal(convRes.body.messages[1].role, 'assistant');
    assert.equal(convRes.body.messages[1].content, 'saved reply');
  });

  it('POST /api/businesses/:id/chat returns 404 for unknown business', async () => {
    const res = await authPost('/api/businesses/no-such-id/chat')
      .send({ message: 'Hello' });
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Customer memory endpoints
// ---------------------------------------------------------------------------
describe('Customer memory endpoints', () => {
  it('GET /api/businesses/:id/customers returns list', async () => {
    const biz = createTestBusiness();
    const db = require('../../src/services/db');
    db.saveCustomerMemory(biz.id, '972501111111', { name: 'Alice' });
    db.saveCustomerMemory(biz.id, '972502222222', { name: 'Bob' });

    const res = await authGet(`/api/businesses/${biz.id}/customers`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 2);
  });

  it('GET /api/businesses/:id/customers/:phone returns memory', async () => {
    const biz = createTestBusiness();
    const db = require('../../src/services/db');
    db.saveCustomerMemory(biz.id, '972501111111', { name: 'Alice', language: 'Hebrew' });

    const res = await authGet(`/api/businesses/${biz.id}/customers/972501111111`);
    assert.equal(res.status, 200);
    assert.equal(res.body.facts.name, 'Alice');
    assert.equal(res.body.facts.language, 'Hebrew');
  });

  it('GET /api/businesses/:id/customers/:phone returns 404 when not found', async () => {
    const biz = createTestBusiness();

    const res = await authGet(`/api/businesses/${biz.id}/customers/000000`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Customer memory not found');
  });

  it('PATCH /api/businesses/:id/customers/:phone merges facts', async () => {
    const biz = createTestBusiness();
    const db = require('../../src/services/db');
    db.saveCustomerMemory(biz.id, '972501111111', { name: 'Alice', notes: ['likes coffee'] });

    const res = await authPatch(`/api/businesses/${biz.id}/customers/972501111111`)
      .send({ facts: { language: 'English', notes: ['prefers mornings'] } });
    assert.equal(res.status, 200);
    assert.equal(res.body.facts.name, 'Alice');
    assert.equal(res.body.facts.language, 'English');
    // Notes should be merged, not replaced
    assert.ok(res.body.facts.notes.includes('likes coffee'));
    assert.ok(res.body.facts.notes.includes('prefers mornings'));
  });

  it('PATCH /api/businesses/:id/customers/:phone returns 400 without facts', async () => {
    const biz = createTestBusiness();

    const res = await authPatch(`/api/businesses/${biz.id}/customers/972501111111`)
      .send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'facts object is required');
  });

  it('DELETE /api/businesses/:id/customers/:phone returns 204', async () => {
    const biz = createTestBusiness();
    const db = require('../../src/services/db');
    db.saveCustomerMemory(biz.id, '972501111111', { name: 'Alice' });

    const res = await authDelete(`/api/businesses/${biz.id}/customers/972501111111`);
    assert.equal(res.status, 204);

    const getRes = await authGet(`/api/businesses/${biz.id}/customers/972501111111`);
    assert.equal(getRes.status, 404);
  });

  it('DELETE /api/businesses/:id/customers clears all memories for business', async () => {
    const biz = createTestBusiness();
    const db = require('../../src/services/db');
    db.saveCustomerMemory(biz.id, '972501111111', { name: 'Alice' });
    db.saveCustomerMemory(biz.id, '972502222222', { name: 'Bob' });

    const res = await authDelete(`/api/businesses/${biz.id}/customers`);
    assert.equal(res.status, 204);

    const listRes = await authGet(`/api/businesses/${biz.id}/customers`);
    assert.equal(listRes.body.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Escalation endpoints
// ---------------------------------------------------------------------------
describe('Escalation endpoints', () => {
  it('GET /api/businesses/:id/escalations returns list', async () => {
    const biz = createTestBusiness();
    const db = require('../../src/services/db');
    db.createEscalation(biz.id, '972501111111', 'customer wants refund');
    db.createEscalation(biz.id, '972502222222', 'billing issue');

    const res = await authGet(`/api/businesses/${biz.id}/escalations`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 2);
  });

  it('POST /api/businesses/:id/escalations/:escId/resolve resolves escalation', async () => {
    const biz = createTestBusiness();
    const db = require('../../src/services/db');
    const esc = db.createEscalation(biz.id, '972501111111', 'needs help');

    const res = await authPost(`/api/businesses/${biz.id}/escalations/${esc.id}/resolve`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'resolved');
    assert.ok(res.body.resolved_at);
  });

  it('POST resolve on already-resolved escalation returns 400', async () => {
    const biz = createTestBusiness();
    const db = require('../../src/services/db');
    const esc = db.createEscalation(biz.id, '972501111111', 'needs help');
    db.resolveEscalation(esc.id);

    const res = await authPost(`/api/businesses/${biz.id}/escalations/${esc.id}/resolve`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Escalation already resolved');
  });

  it('POST resolve returns 404 for nonexistent escalation', async () => {
    const biz = createTestBusiness();

    const res = await authPost(`/api/businesses/${biz.id}/escalations/no-such-id/resolve`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Escalation not found');
  });
});

// ---------------------------------------------------------------------------
// Conversation endpoints
// ---------------------------------------------------------------------------
describe('Conversation endpoints', () => {
  it('GET /api/businesses/:id/conversations returns list', async () => {
    const biz = createTestBusiness();
    const db = require('../../src/services/db');
    db.saveConversation(biz.id, '972501111111', [{ role: 'user', content: 'Hi' }]);
    db.saveConversation(biz.id, '972502222222', [{ role: 'user', content: 'Hey' }]);

    const res = await authGet(`/api/businesses/${biz.id}/conversations`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 2);
  });

  it('GET /api/businesses/:id/conversations/:phone returns conversation', async () => {
    const biz = createTestBusiness();
    const db = require('../../src/services/db');
    db.saveConversation(biz.id, '972501111111', [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]);

    const res = await authGet(`/api/businesses/${biz.id}/conversations/972501111111`);
    assert.equal(res.status, 200);
    assert.equal(res.body.messages.length, 2);
    assert.equal(res.body.customer_phone, '972501111111');
  });

  it('GET /api/businesses/:id/conversations/:phone returns 404 when not found', async () => {
    const biz = createTestBusiness();

    const res = await authGet(`/api/businesses/${biz.id}/conversations/000000`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Conversation not found');
  });

  it('DELETE /api/businesses/:id/conversations/:phone deletes and returns 204', async () => {
    const biz = createTestBusiness();
    const db = require('../../src/services/db');
    db.saveConversation(biz.id, '972501111111', [{ role: 'user', content: 'Hi' }]);

    const res = await authDelete(`/api/businesses/${biz.id}/conversations/972501111111`);
    assert.equal(res.status, 204);

    const getRes = await authGet(`/api/businesses/${biz.id}/conversations/972501111111`);
    assert.equal(getRes.status, 404);
  });

  it('DELETE /api/businesses/:id/conversations/:phone returns 404 when not found', async () => {
    const biz = createTestBusiness();

    const res = await authDelete(`/api/businesses/${biz.id}/conversations/000000`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Conversation not found');
  });
});

// ---------------------------------------------------------------------------
// Telegram connection endpoints
// ---------------------------------------------------------------------------
describe('Telegram connection endpoints', () => {
  const savedToken = config.telegramBotToken;

  beforeEach(() => {
    config.telegramBotToken = 'bot123:abc';
    telegram._resetState();
    mock.method(telegram, 'getBotUsername', async () => 'test_bot');
    mock.method(telegram, 'processStartCommands', async () => []);
  });

  afterEach(() => {
    config.telegramBotToken = savedToken;
    telegram._resetState();
    mock.restoreAll();
  });

  it('POST /api/businesses/:id/telegram-link generates a link', async () => {
    const biz = createTestBusiness();

    const res = await authPost(`/api/businesses/${biz.id}/telegram-link`);
    assert.equal(res.status, 200);
    assert.ok(res.body.url);
    assert.ok(res.body.url.startsWith('https://t.me/test_bot?start='));
  });

  it('POST /api/businesses/:id/telegram-link returns 400 when already connected', async () => {
    const biz = createTestBusiness({ boss_telegram_chat_id: '12345' });

    const res = await authPost(`/api/businesses/${biz.id}/telegram-link`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Telegram is already connected');
  });

  it('POST /api/businesses/:id/telegram-link returns 400 when telegram not configured', async () => {
    config.telegramBotToken = '';
    const biz = createTestBusiness();

    const res = await authPost(`/api/businesses/${biz.id}/telegram-link`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Telegram bot token is not configured');
  });

  it('POST /api/businesses/:id/telegram-link returns 404 for unknown business', async () => {
    const res = await authPost('/api/businesses/nonexistent/telegram-link');
    assert.equal(res.status, 404);
  });

  it('GET /api/businesses/:id/telegram-status returns connected when chat_id set', async () => {
    const biz = createTestBusiness({ boss_telegram_chat_id: '99999' });

    const res = await authGet(`/api/businesses/${biz.id}/telegram-status`);
    assert.equal(res.status, 200);
    assert.equal(res.body.connected, true);
    assert.equal(res.body.chat_id, '99999');
  });

  it('GET /api/businesses/:id/telegram-status returns not pending when no link', async () => {
    const biz = createTestBusiness();

    const res = await authGet(`/api/businesses/${biz.id}/telegram-status`);
    assert.equal(res.status, 200);
    assert.equal(res.body.connected, false);
    assert.equal(res.body.pending, false);
  });

  it('GET /api/businesses/:id/telegram-status returns pending when link exists', async () => {
    const biz = createTestBusiness();
    db.createTelegramLink('test-token', biz.id);

    const res = await authGet(`/api/businesses/${biz.id}/telegram-status`);
    assert.equal(res.status, 200);
    assert.equal(res.body.connected, false);
    assert.equal(res.body.pending, true);
  });

  it('GET /api/businesses/:id/telegram-status connects when start command matches', async () => {
    const biz = createTestBusiness();
    db.createTelegramLink('match-token', biz.id);

    mock.method(telegram, 'processStartCommands', async () => [
      { token: 'match-token', chatId: '55555' },
    ]);
    // Also mock sendMessage to not actually call Telegram
    mock.method(telegram, 'sendMessage', async () => ({ ok: true }));

    const res = await authGet(`/api/businesses/${biz.id}/telegram-status`);
    assert.equal(res.status, 200);
    assert.equal(res.body.connected, true);
    assert.equal(res.body.chat_id, '55555');

    // Link should be cleaned up
    assert.equal(db.getTelegramLinkByToken('match-token'), undefined);

    // Business should be updated
    const updated = db.getBusiness(biz.id);
    assert.equal(updated.boss_telegram_chat_id, '55555');
  });

  it('GET /api/businesses/:id/telegram-status returns expired when link is old', async () => {
    const biz = createTestBusiness();
    db.createTelegramLink('old-token', biz.id);
    // Backdate the link to 2 hours ago
    db.db.prepare(`UPDATE telegram_links SET created_at = datetime('now', '-2 hours') WHERE token = ?`).run('old-token');

    const res = await authGet(`/api/businesses/${biz.id}/telegram-status`);
    assert.equal(res.status, 200);
    assert.equal(res.body.connected, false);
    assert.equal(res.body.pending, false);
    assert.equal(res.body.expired, true);

    // Link should be cleaned up
    assert.equal(db.getTelegramLinkByToken('old-token'), undefined);
  });

  it('POST /api/businesses/:id/telegram-link returns 400 when bot token is invalid', async () => {
    const biz = createTestBusiness();
    mock.method(telegram, 'getBotUsername', async () => { throw new Error('401 Unauthorized'); });

    const res = await authPost(`/api/businesses/${biz.id}/telegram-link`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Failed to verify Telegram bot token');
  });

  it('DELETE /api/businesses/:id/telegram disconnects', async () => {
    const biz = createTestBusiness({ boss_telegram_chat_id: '12345' });

    const res = await authDelete(`/api/businesses/${biz.id}/telegram`);
    assert.equal(res.status, 204);

    const updated = db.getBusiness(biz.id);
    assert.equal(updated.boss_telegram_chat_id, null);
  });

  it('DELETE /api/businesses/:id/telegram cleans up pending links', async () => {
    const biz = createTestBusiness({ boss_telegram_chat_id: '12345' });
    db.createTelegramLink('cleanup-token', biz.id);

    await authDelete(`/api/businesses/${biz.id}/telegram`);

    assert.equal(db.getTelegramLinkByToken('cleanup-token'), undefined);
  });

  it('DELETE /api/businesses/:id/telegram returns 404 for unknown business', async () => {
    const res = await authDelete('/api/businesses/nonexistent/telegram');
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------
describe('Appointments', () => {
  function createAppointment(businessId, overrides = {}) {
    return db.createAppointment({
      business_id: businessId,
      customer_phone: overrides.customer_phone || '+972501234567',
      customer_name: overrides.customer_name || 'Test Customer',
      service_id: overrides.service_id || 'svc1',
      service_name: overrides.service_name || 'Haircut',
      service_duration: overrides.service_duration || 30,
      start_time: overrides.start_time || '2026-04-01T10:00:00',
      end_time: overrides.end_time || '2026-04-01T10:30:00',
      ...overrides,
    });
  }

  it('GET /api/businesses/:id/appointments returns empty list', async () => {
    const biz = createTestBusiness();
    const res = await authGet(`/api/businesses/${biz.id}/appointments`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  it('GET /api/businesses/:id/appointments returns appointments', async () => {
    const biz = createTestBusiness();
    createAppointment(biz.id);
    createAppointment(biz.id, { customer_phone: '+972509999999', start_time: '2026-04-01T11:00:00', end_time: '2026-04-01T11:30:00' });

    const res = await authGet(`/api/businesses/${biz.id}/appointments`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);
  });

  it('GET /api/businesses/:id/appointments filters by status', async () => {
    const biz = createTestBusiness();
    createAppointment(biz.id);
    const toCancel = createAppointment(biz.id, { customer_phone: '+972509999999', start_time: '2026-04-01T11:00:00', end_time: '2026-04-01T11:30:00' });
    db.updateAppointmentStatus(toCancel.id, 'cancelled');

    const confirmed = await authGet(`/api/businesses/${biz.id}/appointments?status=confirmed`);
    assert.equal(confirmed.body.length, 1);
    assert.equal(confirmed.body[0].status, 'confirmed');

    const cancelled = await authGet(`/api/businesses/${biz.id}/appointments?status=cancelled`);
    assert.equal(cancelled.body.length, 1);
    assert.equal(cancelled.body[0].status, 'cancelled');
  });

  it('GET /api/businesses/:id/appointments returns 404 for missing business', async () => {
    const res = await authGet('/api/businesses/nonexistent/appointments');
    assert.equal(res.status, 404);
  });

  it('PATCH cancels a confirmed appointment', async () => {
    const biz = createTestBusiness();
    const appt = createAppointment(biz.id);

    const res = await authPatch(`/api/businesses/${biz.id}/appointments/${appt.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'cancelled');
    assert.equal(res.body.id, appt.id);
  });

  it('PATCH returns 400 if already cancelled', async () => {
    const biz = createTestBusiness();
    const appt = createAppointment(biz.id);
    db.updateAppointmentStatus(appt.id, 'cancelled');

    const res = await authPatch(`/api/businesses/${biz.id}/appointments/${appt.id}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Appointment already cancelled');
  });

  it('PATCH returns 404 for non-existent appointment', async () => {
    const biz = createTestBusiness();
    const res = await authPatch(`/api/businesses/${biz.id}/appointments/fake-id`);
    assert.equal(res.status, 404);
  });

  it('PATCH returns 404 for appointment belonging to different business', async () => {
    const biz1 = createTestBusiness();
    const biz2 = createTestBusiness({ name: 'Other Business' });
    const appt = createAppointment(biz1.id);

    const res = await authPatch(`/api/businesses/${biz2.id}/appointments/${appt.id}`);
    assert.equal(res.status, 404);
  });
});
