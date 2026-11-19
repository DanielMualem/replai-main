const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { buildApp, cleanDb, config, db } = require('../helpers/setup');

const app = buildApp();

function buildSignedRequest(payload, secret) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encodedPayload).digest();
  const encodedSig = sig.toString('base64url');
  return `${encodedSig}.${encodedPayload}`;
}

async function postDeletion(body) {
  const { default: supertest } = await import('supertest');
  return supertest(app)
    .post('/facebook-data-deletion')
    .type('form')
    .send(body);
}

async function getDeletionStatus(code) {
  const { default: supertest } = await import('supertest');
  return supertest(app).get(`/facebook-data-deletion/${code}`);
}

describe('Facebook Data Deletion', () => {
  const TEST_SECRET = 'test-fb-app-secret';

  beforeEach(() => {
    cleanDb();
    config.facebookAppSecret = TEST_SECRET;
  });

  it('should process a valid signed_request and return confirmation', async () => {
    const payload = { user_id: '123456', algorithm: 'HMAC-SHA256' };
    const signedRequest = buildSignedRequest(payload, TEST_SECRET);

    const res = await postDeletion({ signed_request: signedRequest });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.url);
    assert.ok(res.body.confirmation_code);
    assert.ok(res.body.url.includes(res.body.confirmation_code));

    // Verify DB record created
    const record = db.getDataDeletionRequest(res.body.confirmation_code);
    assert.ok(record);
    assert.strictEqual(record.facebook_user_id, '123456');
    assert.strictEqual(record.status, 'completed');
  });

  it('should reject an invalid signature', async () => {
    const payload = { user_id: '123456', algorithm: 'HMAC-SHA256' };
    const signedRequest = buildSignedRequest(payload, 'wrong-secret');

    const res = await postDeletion({ signed_request: signedRequest });

    assert.strictEqual(res.status, 403);
  });

  it('should return 400 when signed_request is missing', async () => {
    const res = await postDeletion({});

    assert.strictEqual(res.status, 400);
  });

  it('should return 403 when facebookAppSecret is not configured', async () => {
    config.facebookAppSecret = '';

    const payload = { user_id: '123456' };
    const signedRequest = buildSignedRequest(payload, TEST_SECRET);

    const res = await postDeletion({ signed_request: signedRequest });

    assert.strictEqual(res.status, 403);
  });

  it('should show status page for a valid confirmation code', async () => {
    const payload = { user_id: '789', algorithm: 'HMAC-SHA256' };
    const signedRequest = buildSignedRequest(payload, TEST_SECRET);

    const postRes = await postDeletion({ signed_request: signedRequest });
    const code = postRes.body.confirmation_code;

    const res = await getDeletionStatus(code);

    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes(code));
    assert.ok(res.text.includes('completed'));
  });

  it('should return 404 for an unknown confirmation code', async () => {
    const res = await getDeletionStatus('nonexistent-code');

    assert.strictEqual(res.status, 404);
    assert.ok(res.text.includes('Not Found'));
  });
});
