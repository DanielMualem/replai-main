const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBusiness, buildApp, cleanDb, db } = require('../helpers/setup');
const supertest = require('supertest');

const app = buildApp();
const request = supertest(app);
const AUTH = { Authorization: 'Bearer test-api-key' };

let business;

beforeEach(() => {
  cleanDb();
  business = createTestBusiness();
});

describe('Knowledge Gaps API', () => {
  it('GET /api/businesses/:id/knowledge-gaps returns empty list initially', async () => {
    const res = await request.get(`/api/businesses/${business.id}/knowledge-gaps`).set(AUTH);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  it('GET /api/businesses/:id/knowledge-gaps/stats returns zero counts initially', async () => {
    const res = await request.get(`/api/businesses/${business.id}/knowledge-gaps/stats`).set(AUTH);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { pending: 0, answered: 0, dismissed: 0 });
  });

  it('full lifecycle: create gap, answer it, verify in prompt', async () => {
    // Create a gap directly in DB (simulating detection)
    const gap = db.createKnowledgeGap({
      business_id: business.id,
      customer_phone: '972501234567',
      question: 'What are your opening hours?',
      ai_response: "I'm not sure about that.",
      gap_type: 'unanswered',
    });

    // List gaps
    const listRes = await request.get(`/api/businesses/${business.id}/knowledge-gaps`).set(AUTH);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.length, 1);
    assert.equal(listRes.body[0].question, 'What are your opening hours?');
    assert.equal(listRes.body[0].status, 'pending');

    // Check stats
    const statsRes = await request.get(`/api/businesses/${business.id}/knowledge-gaps/stats`).set(AUTH);
    assert.equal(statsRes.body.pending, 1);

    // Answer the gap
    const answerRes = await request
      .patch(`/api/businesses/${business.id}/knowledge-gaps/${gap.id}`)
      .set(AUTH)
      .send({ status: 'answered', answer: 'We are open Sunday-Thursday 9:00-17:00.' });
    assert.equal(answerRes.status, 200);
    assert.equal(answerRes.body.status, 'answered');
    assert.equal(answerRes.body.answer, 'We are open Sunday-Thursday 9:00-17:00.');

    // Verify it appears in the knowledge base prompt
    const { buildKnowledgeBasePrompt } = require('../../src/services/gemini');
    const prompt = buildKnowledgeBasePrompt(business.id);
    assert.ok(prompt);
    assert.ok(prompt.includes('What are your opening hours?'));
    assert.ok(prompt.includes('We are open Sunday-Thursday 9:00-17:00.'));

    // Stats should reflect answered
    const stats2 = await request.get(`/api/businesses/${business.id}/knowledge-gaps/stats`).set(AUTH);
    assert.equal(stats2.body.pending, 0);
    assert.equal(stats2.body.answered, 1);
  });

  it('PATCH requires answer when status is answered', async () => {
    const gap = db.createKnowledgeGap({
      business_id: business.id,
      customer_phone: '1',
      question: 'Q1',
      gap_type: 'unanswered',
    });

    const res = await request
      .patch(`/api/businesses/${business.id}/knowledge-gaps/${gap.id}`)
      .set(AUTH)
      .send({ status: 'answered' });
    assert.equal(res.status, 400);
  });

  it('PATCH can dismiss a gap without answer', async () => {
    const gap = db.createKnowledgeGap({
      business_id: business.id,
      customer_phone: '1',
      question: 'Q1',
      gap_type: 'uncertain',
    });

    const res = await request
      .patch(`/api/businesses/${business.id}/knowledge-gaps/${gap.id}`)
      .set(AUTH)
      .send({ status: 'dismissed' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'dismissed');
  });

  it('PATCH can restore a dismissed gap to pending', async () => {
    const gap = db.createKnowledgeGap({
      business_id: business.id,
      customer_phone: '1',
      question: 'Q1',
      gap_type: 'uncertain',
    });
    db.updateKnowledgeGap(gap.id, { status: 'dismissed' });

    const res = await request
      .patch(`/api/businesses/${business.id}/knowledge-gaps/${gap.id}`)
      .set(AUTH)
      .send({ status: 'pending' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'pending');
  });

  it('DELETE removes a gap', async () => {
    const gap = db.createKnowledgeGap({
      business_id: business.id,
      customer_phone: '1',
      question: 'Q1',
      gap_type: 'deflected',
    });

    const res = await request
      .delete(`/api/businesses/${business.id}/knowledge-gaps/${gap.id}`)
      .set(AUTH);
    assert.equal(res.status, 204);

    const listRes = await request.get(`/api/businesses/${business.id}/knowledge-gaps`).set(AUTH);
    assert.equal(listRes.body.length, 0);
  });

  it('status filter works', async () => {
    db.createKnowledgeGap({ business_id: business.id, customer_phone: '1', question: 'Q1', gap_type: 'unanswered' });
    const gap2 = db.createKnowledgeGap({ business_id: business.id, customer_phone: '2', question: 'Q2', gap_type: 'deflected' });
    db.updateKnowledgeGap(gap2.id, { status: 'answered', answer: 'Yes.' });

    const pendingRes = await request.get(`/api/businesses/${business.id}/knowledge-gaps?status=pending`).set(AUTH);
    assert.equal(pendingRes.body.length, 1);

    const answeredRes = await request.get(`/api/businesses/${business.id}/knowledge-gaps?status=answered`).set(AUTH);
    assert.equal(answeredRes.body.length, 1);
  });

  it('returns 404 for non-existent business', async () => {
    const res = await request.get('/api/businesses/nonexistent/knowledge-gaps').set(AUTH);
    assert.equal(res.status, 404);
  });

  it('returns 404 for non-existent gap', async () => {
    const res = await request
      .patch(`/api/businesses/${business.id}/knowledge-gaps/nonexistent`)
      .set(AUTH)
      .send({ status: 'dismissed' });
    assert.equal(res.status, 404);
  });
});
