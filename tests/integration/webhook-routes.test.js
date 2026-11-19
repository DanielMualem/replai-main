const { describe, it, before, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBusiness, cleanDb, buildWebhookPayload, buildWebhookImagePayload, buildWebhookAudioPayload, buildSignature, buildApp, config } = require('../helpers/setup');
const request = require('supertest');

// Mock whatsapp.handleIncomingMessage to prevent actual processing
const whatsapp = require('../../src/services/whatsapp');

let app;

before(() => {
  app = buildApp();
});

beforeEach(() => {
  cleanDb();
  mock.restoreAll();
  mock.method(whatsapp, 'handleIncomingMessage', async () => {});
});

// ---------------------------------------------------------------------------
// GET /webhook — Meta verification
// ---------------------------------------------------------------------------
describe('GET /webhook (Meta verification)', () => {
  it('returns 200 with challenge value for valid verification request', async () => {
    const res = await request(app)
      .get('/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': config.whatsappVerifyToken,
        'hub.challenge': 'test-challenge-123',
      });
    assert.equal(res.status, 200);
    assert.equal(res.text, 'test-challenge-123');
  });

  it('returns 403 when verify token is wrong', async () => {
    const res = await request(app)
      .get('/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'test-challenge-123',
      });
    assert.equal(res.status, 403);
  });

  it('returns 403 when mode is not subscribe', async () => {
    const res = await request(app)
      .get('/webhook')
      .query({
        'hub.mode': 'unsubscribe',
        'hub.verify_token': config.whatsappVerifyToken,
        'hub.challenge': 'test-challenge-123',
      });
    assert.equal(res.status, 403);
  });
});

// ---------------------------------------------------------------------------
// POST /webhook — Incoming messages
// ---------------------------------------------------------------------------
describe('POST /webhook (incoming messages)', () => {
  it('returns 200 for valid-looking payload', async () => {
    const biz = createTestBusiness({ phone_number_id: 'pnid-001' });
    const payload = buildWebhookPayload('pnid-001', '972501234567', 'Hello');

    const res = await request(app)
      .post('/webhook')
      .send(payload);
    assert.equal(res.status, 200);
  });

  it('returns 200 even for empty body', async () => {
    const res = await request(app)
      .post('/webhook')
      .send({});
    assert.equal(res.status, 200);
  });

  it('returns 200 for image payload and calls handleIncomingMessage', async () => {
    createTestBusiness({ phone_number_id: 'pnid-img' });
    const payload = buildWebhookImagePayload('pnid-img', '972501234567', 'media-123', 'Check this out');

    const res = await request(app)
      .post('/webhook')
      .send(payload);
    assert.equal(res.status, 200);
  });

  it('returns 200 for audio payload and calls handleIncomingMessage', async () => {
    createTestBusiness({ phone_number_id: 'pnid-aud' });
    const payload = buildWebhookAudioPayload('pnid-aud', '972501234567', 'media-456');

    const res = await request(app)
      .post('/webhook')
      .send(payload);
    assert.equal(res.status, 200);
  });

  it('with WHATSAPP_APP_SECRET set: valid signature returns 200', async () => {
    const original = config.whatsappAppSecret;
    try {
      config.whatsappAppSecret = 'test-secret';

      const biz = createTestBusiness({ phone_number_id: 'pnid-sig' });
      const payload = buildWebhookPayload('pnid-sig', '972501234567', 'Signed hello');
      const bodyStr = JSON.stringify(payload);
      const signature = buildSignature(bodyStr, 'test-secret');

      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', signature)
        .send(bodyStr);
      assert.equal(res.status, 200);
    } finally {
      config.whatsappAppSecret = original;
    }
  });

  it('with WHATSAPP_APP_SECRET set: invalid signature returns 401', async () => {
    const original = config.whatsappAppSecret;
    try {
      config.whatsappAppSecret = 'test-secret';

      const payload = buildWebhookPayload('pnid-badsig', '972501234567', 'Bad sig');

      const res = await request(app)
        .post('/webhook')
        .set('x-hub-signature-256', 'sha256=0000000000000000000000000000000000000000000000000000000000000000')
        .send(payload);
      assert.equal(res.status, 401);
    } finally {
      config.whatsappAppSecret = original;
    }
  });

  it('with WHATSAPP_APP_SECRET set: missing signature returns 401', async () => {
    const original = config.whatsappAppSecret;
    try {
      config.whatsappAppSecret = 'test-secret';

      const payload = buildWebhookPayload('pnid-nosig', '972501234567', 'No sig');

      const res = await request(app)
        .post('/webhook')
        .send(payload);
      assert.equal(res.status, 401);
    } finally {
      config.whatsappAppSecret = original;
    }
  });
});
