const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildApp, createTestBusiness, cleanDb, db } = require('../helpers/setup');

const app = buildApp();

describe('GET /resume/:id', () => {
  let business;
  let escalation;

  beforeEach(() => {
    cleanDb();
    business = createTestBusiness({ phone_number_id: 'pn1', whatsapp_access_token: 'tok1' });
    escalation = db.createEscalation(business.id, '972501111111', 'needs help');
  });

  it('returns landing page for active escalation', async () => {
    const res = await request(app).get(`/resume/${escalation.id}`);

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /Resume Bot/);
    assert.match(res.text, /<form/);
    assert.match(res.text, new RegExp(`/resume/${escalation.id}`));
  });

  it('returns 404 for unknown ID', async () => {
    const res = await request(app).get('/resume/00000000-0000-0000-0000-000000000000');

    assert.equal(res.status, 404);
    assert.match(res.text, /not found/i);
  });

  it('returns already resolved page for resolved escalation', async () => {
    db.resolveEscalation(escalation.id);

    const res = await request(app).get(`/resume/${escalation.id}`);

    assert.equal(res.status, 200);
    assert.match(res.text, /already resolved/i);
    assert.ok(!res.text.includes('<form'));
  });
});

describe('POST /resume/:id', () => {
  let business;
  let escalation;

  beforeEach(() => {
    cleanDb();
    business = createTestBusiness({ phone_number_id: 'pn2', whatsapp_access_token: 'tok2' });
    escalation = db.createEscalation(business.id, '972502222222', 'customer request');
  });

  it('resolves escalation and shows success page', async () => {
    const res = await request(app).post(`/resume/${escalation.id}`);

    assert.equal(res.status, 200);
    assert.match(res.text, /bot resumed/i);

    // Verify escalation is resolved in DB
    const updated = db.getEscalation(escalation.id);
    assert.equal(updated.status, 'resolved');
  });

  it('returns 404 for unknown ID', async () => {
    const res = await request(app).post('/resume/00000000-0000-0000-0000-000000000000');

    assert.equal(res.status, 404);
    assert.match(res.text, /not found/i);
  });

  it('returns already resolved for double-submit', async () => {
    await request(app).post(`/resume/${escalation.id}`);
    const res = await request(app).post(`/resume/${escalation.id}`);

    assert.equal(res.status, 200);
    assert.match(res.text, /already closed/i);
  });

  it('accepts pre-generated escalation ID', async () => {
    const customId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const esc = db.createEscalation(business.id, '972503333333', 'test', customId);

    assert.equal(esc.id, customId);

    const res = await request(app).post(`/resume/${customId}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /bot resumed/i);
  });
});
