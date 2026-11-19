const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { buildApp, createTestBusiness, cleanDb, db, config } = require('../helpers/setup');

const app = buildApp();
const AUTH = 'Bearer test-api-key';

function setFacebookConfig() {
  config.baseUrl = 'https://example.com';
  config.facebookAppId = 'test-app-id';
  config.facebookAppSecret = 'test-app-secret';
  config.facebookLoginConfigId = 'test-config-id';
  config.systemUserAccessToken = 'test-system-token';
}

function clearFacebookConfig() {
  config.baseUrl = null;
  config.facebookAppId = null;
  config.facebookAppSecret = null;
  config.facebookLoginConfigId = null;
  config.systemUserAccessToken = null;
}

describe('POST /api/businesses/:id/signup-invite', () => {
  let business;

  beforeEach(() => {
    cleanDb();
    business = createTestBusiness({ name: 'Invite Test Biz' });
    setFacebookConfig();
  });

  afterEach(() => clearFacebookConfig());

  it('generates invite link with valid config', async () => {
    const res = await request(app)
      .post(`/api/businesses/${business.id}/signup-invite`)
      .set('Authorization', AUTH);

    assert.equal(res.status, 201);
    assert.ok(res.body.url);
    assert.ok(res.body.token);
    assert.ok(res.body.expires_at);
    assert.match(res.body.url, /\/signup\//);
  });

  it('returns 404 for unknown business', async () => {
    const res = await request(app)
      .post('/api/businesses/nonexistent/signup-invite')
      .set('Authorization', AUTH);

    assert.equal(res.status, 404);
  });

  it('returns 400 when BASE_URL not set', async () => {
    config.baseUrl = null;
    const res = await request(app)
      .post(`/api/businesses/${business.id}/signup-invite`)
      .set('Authorization', AUTH);

    assert.equal(res.status, 400);
    assert.match(res.body.error, /BASE_URL/);
  });

  it('returns 400 when Facebook config incomplete', async () => {
    config.facebookAppId = null;
    const res = await request(app)
      .post(`/api/businesses/${business.id}/signup-invite`)
      .set('Authorization', AUTH);

    assert.equal(res.status, 400);
    assert.match(res.body.error, /not fully configured/);
  });

  it('requires admin auth', async () => {
    const res = await request(app)
      .post(`/api/businesses/${business.id}/signup-invite`);

    assert.equal(res.status, 401);
  });
});

describe('GET /api/businesses/:id/signup-invites', () => {
  let business;

  beforeEach(() => {
    cleanDb();
    business = createTestBusiness();
    setFacebookConfig();
  });

  afterEach(() => clearFacebookConfig());

  it('lists invites for a business', async () => {
    await request(app)
      .post(`/api/businesses/${business.id}/signup-invite`)
      .set('Authorization', AUTH);

    const res = await request(app)
      .get(`/api/businesses/${business.id}/signup-invites`)
      .set('Authorization', AUTH);

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 1);
  });
});

describe('GET /signup/:token', () => {
  let business;

  beforeEach(() => {
    cleanDb();
    business = createTestBusiness({ name: 'Signup Page Biz' });
    setFacebookConfig();
  });

  afterEach(() => clearFacebookConfig());

  it('serves signup page for valid token', async () => {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    db.createSignupInvite(business.id, token, expiresAt);

    const res = await request(app).get(`/signup/${token}`);

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /Connect WhatsApp/);
    assert.match(res.text, /Signup Page Biz/);
    assert.match(res.text, /facebook/i);
  });

  it('returns 404 for invalid token', async () => {
    const res = await request(app).get('/signup/invalidtoken123');

    assert.equal(res.status, 404);
    assert.match(res.text, /not found/i);
  });

  it('returns 404 for expired token', async () => {
    const token = crypto.randomBytes(32).toString('hex');
    const pastDate = new Date(Date.now() - 1000)
      .toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    db.createSignupInvite(business.id, token, pastDate);

    const res = await request(app).get(`/signup/${token}`);

    assert.equal(res.status, 404);
    assert.match(res.text, /not found/i);
  });

  it('returns 404 for used token', async () => {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    db.createSignupInvite(business.id, token, expiresAt);
    db.markSignupInviteUsed(token);

    const res = await request(app).get(`/signup/${token}`);

    assert.equal(res.status, 404);
    assert.match(res.text, /not found/i);
  });
});

describe('POST /signup/:token/complete', () => {
  let business;
  let token;

  beforeEach(() => {
    cleanDb();
    business = createTestBusiness({ name: 'Complete Signup Biz' });
    token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    db.createSignupInvite(business.id, token, expiresAt);
    setFacebookConfig();
  });

  afterEach(() => clearFacebookConfig());

  it('returns 404 for invalid token', async () => {
    const res = await request(app)
      .post('/signup/invalidtoken/complete')
      .send({ code: 'test', waba_id: '123', phone_number_id: '456' });

    assert.equal(res.status, 404);
  });

  it('validates request body', async () => {
    const res = await request(app)
      .post(`/signup/${token}/complete`)
      .send({ code: 'test' });

    assert.equal(res.status, 400);
  });

  it('returns 404 for used token', async () => {
    db.markSignupInviteUsed(token);

    const res = await request(app)
      .post(`/signup/${token}/complete`)
      .send({ code: 'test', waba_id: '123', phone_number_id: '456' });

    assert.equal(res.status, 404);
  });

  it('returns 500 when Facebook config is missing', async () => {
    config.facebookAppSecret = null;

    const res = await request(app)
      .post(`/signup/${token}/complete`)
      .send({ code: 'test', waba_id: '123', phone_number_id: '456' });

    assert.equal(res.status, 500);
    assert.match(res.body.error, /not fully configured/);
  });
});
