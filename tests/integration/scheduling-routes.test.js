const { describe, it, before, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBusiness, cleanDb, buildApp, db } = require('../helpers/setup');
const request = require('supertest');

const gemini = require('../../src/services/gemini');

let app;

before(() => {
  app = buildApp();
});

beforeEach(() => {
  cleanDb();
  mock.restoreAll();
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

const SCHED_CONFIG = JSON.stringify({
  provider: 'cal-com',
  api_key: 'cal_live_secret123',
  event_type_id: '42',
  timezone: 'Asia/Jerusalem',
});

const ACUITY_CONFIG = JSON.stringify({
  provider: 'acuity',
  api_key: 'acuity_secret123',
  user_id: '12345',
  timezone: 'Asia/Jerusalem',
});

const CALENDLY_CONFIG = JSON.stringify({
  provider: 'calendly',
  api_key: 'calendly_pat_secret123',
  timezone: 'Asia/Jerusalem',
});

const SQUARE_CONFIG = JSON.stringify({
  provider: 'square',
  api_key: 'square_access_secret123',
  location_id: 'LOC123',
  timezone: 'Asia/Jerusalem',
});

// ---------------------------------------------------------------------------
// scheduling_config in business endpoints
// ---------------------------------------------------------------------------
describe('Business scheduling_config via API', () => {
  it('POST /api/businesses creates business with scheduling_config', async () => {
    const res = await authPost('/api/businesses')
      .send({ name: 'Sched Biz', scheduling_config: SCHED_CONFIG });
    assert.equal(res.status, 201);
    // API key should be redacted
    const parsed = JSON.parse(res.body.scheduling_config);
    assert.ok(parsed.api_key.startsWith('••••'));
    assert.ok(parsed.api_key.endsWith('123'));
    assert.equal(parsed.provider, 'cal-com');
  });

  it('PATCH /api/businesses/:id updates scheduling_config', async () => {
    const biz = createTestBusiness();

    const res = await authPatch(`/api/businesses/${biz.id}`)
      .send({ scheduling_config: SCHED_CONFIG });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body.scheduling_config);
    assert.equal(parsed.provider, 'cal-com');
    assert.ok(parsed.api_key.startsWith('••••'));
  });

  it('GET /api/businesses/:id redacts scheduling_config api_key', async () => {
    createTestBusiness({
      id: 'sched-get',
      scheduling_config: SCHED_CONFIG,
    });

    const res = await authGet('/api/businesses/sched-get');
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body.scheduling_config);
    assert.ok(parsed.api_key.startsWith('••••'));
    assert.ok(!parsed.api_key.includes('cal_live'));
  });

  it('GET /api/businesses/:id returns null scheduling_config when not set', async () => {
    const biz = createTestBusiness();
    const res = await authGet(`/api/businesses/${biz.id}`);
    assert.equal(res.body.scheduling_config, null);
  });

  it('POST /api/businesses rejects invalid JSON in scheduling_config', async () => {
    const res = await authPost('/api/businesses')
      .send({ name: 'Bad Config', scheduling_config: 'not-json{' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'scheduling_config must be valid JSON');
  });

  it('POST /api/businesses rejects scheduling_config without provider', async () => {
    const res = await authPost('/api/businesses')
      .send({ name: 'No Provider', scheduling_config: JSON.stringify({ api_key: 'test' }) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'scheduling_config must include a provider field');
  });

  it('PATCH /api/businesses/:id rejects invalid JSON in scheduling_config', async () => {
    const biz = createTestBusiness();
    const res = await authPatch(`/api/businesses/${biz.id}`)
      .send({ scheduling_config: 'bad-json' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'scheduling_config must be valid JSON');
  });

  it('PATCH /api/businesses/:id rejects scheduling_config without provider', async () => {
    const biz = createTestBusiness();
    const res = await authPatch(`/api/businesses/${biz.id}`)
      .send({ scheduling_config: JSON.stringify({ api_key: 'x' }) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'scheduling_config must include a provider field');
  });

  it('PATCH /api/businesses/:id can clear scheduling_config with null', async () => {
    const biz = createTestBusiness({ scheduling_config: SCHED_CONFIG });
    assert.ok(biz.scheduling_config);

    const res = await authPatch(`/api/businesses/${biz.id}`)
      .send({ scheduling_config: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.scheduling_config, null);
  });
});

// ---------------------------------------------------------------------------
// Scheduling providers endpoint
// ---------------------------------------------------------------------------
describe('GET /api/scheduling/providers', () => {
  it('returns list of available providers', async () => {
    const res = await authGet('/api/scheduling/providers');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.includes('cal-com'));
    assert.ok(res.body.includes('acuity'));
    assert.ok(res.body.includes('calendly'));
    assert.ok(res.body.includes('square'));
  });
});

// ---------------------------------------------------------------------------
// New provider config formats
// ---------------------------------------------------------------------------
describe('Acuity scheduling_config via API', () => {
  it('POST /api/businesses creates business with acuity config', async () => {
    const res = await authPost('/api/businesses')
      .send({ name: 'Acuity Biz', scheduling_config: ACUITY_CONFIG });
    assert.equal(res.status, 201);
    const parsed = JSON.parse(res.body.scheduling_config);
    assert.equal(parsed.provider, 'acuity');
    assert.ok(parsed.api_key.startsWith('••••'));
    assert.ok(parsed.api_key.endsWith('123'));
  });

  it('PATCH /api/businesses/:id updates with acuity config', async () => {
    const biz = createTestBusiness();
    const res = await authPatch(`/api/businesses/${biz.id}`)
      .send({ scheduling_config: ACUITY_CONFIG });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body.scheduling_config);
    assert.equal(parsed.provider, 'acuity');
    assert.equal(parsed.user_id, '12345');
  });
});

describe('Calendly scheduling_config via API', () => {
  it('POST /api/businesses creates business with calendly config', async () => {
    const res = await authPost('/api/businesses')
      .send({ name: 'Calendly Biz', scheduling_config: CALENDLY_CONFIG });
    assert.equal(res.status, 201);
    const parsed = JSON.parse(res.body.scheduling_config);
    assert.equal(parsed.provider, 'calendly');
    assert.ok(parsed.api_key.startsWith('••••'));
  });

  it('PATCH /api/businesses/:id updates with calendly config', async () => {
    const biz = createTestBusiness();
    const res = await authPatch(`/api/businesses/${biz.id}`)
      .send({ scheduling_config: CALENDLY_CONFIG });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body.scheduling_config);
    assert.equal(parsed.provider, 'calendly');
  });
});

describe('Square scheduling_config via API', () => {
  it('POST /api/businesses creates business with square config', async () => {
    const res = await authPost('/api/businesses')
      .send({ name: 'Square Biz', scheduling_config: SQUARE_CONFIG });
    assert.equal(res.status, 201);
    const parsed = JSON.parse(res.body.scheduling_config);
    assert.equal(parsed.provider, 'square');
    assert.ok(parsed.api_key.startsWith('••••'));
    assert.equal(parsed.location_id, 'LOC123');
  });

  it('PATCH /api/businesses/:id updates with square config', async () => {
    const biz = createTestBusiness();
    const res = await authPatch(`/api/businesses/${biz.id}`)
      .send({ scheduling_config: SQUARE_CONFIG });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body.scheduling_config);
    assert.equal(parsed.provider, 'square');
    assert.equal(parsed.location_id, 'LOC123');
  });
});

// ---------------------------------------------------------------------------
// Chat endpoint with scheduling (function calling is internal to generateReply)
// ---------------------------------------------------------------------------
describe('Chat endpoint with scheduling', () => {
  it('processes scheduling in chat response', async () => {
    const biz = createTestBusiness({
      scheduling_config: SCHED_CONFIG,
    });

    // generateReply now handles function calling internally and returns clean text
    mock.method(gemini, 'generateReply', async () => ({ reply: 'I have slots at 10:00 and 11:00 on Tuesday!', bookingResult: null }));
    mock.method(gemini, 'updateCustomerMemory', async () => {});

    const res = await authPost(`/api/businesses/${biz.id}/chat`)
      .send({ message: 'Book me for Tuesday' });
    assert.equal(res.status, 200);
    assert.equal(res.body.reply, 'I have slots at 10:00 and 11:00 on Tuesday!');
  });

  it('returns normal reply when no scheduling_config is set', async () => {
    const biz = createTestBusiness();

    mock.method(gemini, 'generateReply', async () => ({ reply: 'Just a normal response', bookingResult: null }));
    mock.method(gemini, 'updateCustomerMemory', async () => {});

    const res = await authPost(`/api/businesses/${biz.id}/chat`)
      .send({ message: 'Hello' });
    assert.equal(res.status, 200);
    assert.equal(res.body.reply, 'Just a normal response');
  });

  it('returns clean reply with scheduling_config but no scheduling action', async () => {
    const biz = createTestBusiness({
      scheduling_config: SCHED_CONFIG,
    });

    mock.method(gemini, 'generateReply', async () => ({ reply: 'No scheduling needed here', bookingResult: null }));
    mock.method(gemini, 'updateCustomerMemory', async () => {});

    const res = await authPost(`/api/businesses/${biz.id}/chat`)
      .send({ message: 'What are your hours?' });
    assert.equal(res.status, 200);
    assert.equal(res.body.reply, 'No scheduling needed here');
  });
});
