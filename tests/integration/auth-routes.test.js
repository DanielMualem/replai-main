const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { buildApp, cleanDb, createTestSession, config } = require('../helpers/setup');
const { COOKIE_NAME } = require('../../src/routes/auth');

describe('Auth Routes', () => {
  let app;
  beforeEach(() => {
    cleanDb();
    config.googleClientId = null;
    config.googleClientSecret = null;
    app = buildApp();
  });

  describe('GET /auth/config', () => {
    it('returns google: false when not configured', async () => {
      const res = await request(app).get('/auth/config');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.google, false);
    });

    it('returns google: true when configured', async () => {
      config.googleClientId = 'test-client-id';
      config.googleClientSecret = 'test-client-secret';
      const res = await request(app).get('/auth/config');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.google, true);
    });
  });

  describe('GET /auth/me', () => {
    it('returns 401 without cookie', async () => {
      const res = await request(app).get('/auth/me');
      assert.strictEqual(res.status, 401);
    });

    it('returns email with valid session cookie', async () => {
      const session = createTestSession('user@example.com');
      const res = await request(app)
        .get('/auth/me')
        .set('Cookie', `${COOKIE_NAME}=${session.id}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.email, 'user@example.com');
    });

    it('returns 401 with invalid session cookie', async () => {
      const res = await request(app)
        .get('/auth/me')
        .set('Cookie', `${COOKIE_NAME}=invalid-session-id`);
      assert.strictEqual(res.status, 401);
    });
  });

  describe('POST /auth/logout', () => {
    it('clears session', async () => {
      const session = createTestSession('logout@example.com');

      const res = await request(app)
        .post('/auth/logout')
        .set('Cookie', `${COOKIE_NAME}=${session.id}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);

      // Session should be gone
      const check = await request(app)
        .get('/auth/me')
        .set('Cookie', `${COOKIE_NAME}=${session.id}`);
      assert.strictEqual(check.status, 401);
    });
  });

  describe('GET /auth/google', () => {
    it('returns 404 when Google OAuth not configured', async () => {
      const res = await request(app).get('/auth/google');
      assert.strictEqual(res.status, 404);
    });
  });
});
