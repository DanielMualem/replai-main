const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../../src/config');
config.dbPath = ':memory:';

const db = require('../../src/services/db');
const { buildKnowledgeBasePrompt } = require('../../src/services/gemini');

let business;

beforeEach(() => {
  db.db.exec('DELETE FROM knowledge_gaps');
  db.db.exec('DELETE FROM businesses');
  business = db.createBusiness({
    id: 'test-biz-kg',
    name: 'Test Business',
    system_prompt: 'You are a test assistant.',
    gemini_model: 'gemini-3-flash-preview',
  });
});

describe('knowledge_gaps CRUD', () => {
  it('creates and retrieves a knowledge gap', () => {
    const gap = db.createKnowledgeGap({
      business_id: business.id,
      customer_phone: '972501234567',
      question: 'What are your hours?',
      ai_response: 'I\'m not sure about that.',
      gap_type: 'uncertain',
    });

    assert.ok(gap);
    assert.equal(gap.business_id, business.id);
    assert.equal(gap.question, 'What are your hours?');
    assert.equal(gap.gap_type, 'uncertain');
    assert.equal(gap.status, 'pending');
    assert.equal(gap.answer, null);

    const fetched = db.getKnowledgeGap(gap.id);
    assert.deepEqual(fetched, gap);
  });

  it('lists gaps for a business with optional status filter', () => {
    db.createKnowledgeGap({ business_id: business.id, customer_phone: '1', question: 'Q1', gap_type: 'unanswered' });
    db.createKnowledgeGap({ business_id: business.id, customer_phone: '2', question: 'Q2', gap_type: 'deflected' });

    const all = db.listKnowledgeGaps(business.id);
    assert.equal(all.length, 2);

    const pending = db.listKnowledgeGaps(business.id, { status: 'pending' });
    assert.equal(pending.length, 2);

    const answered = db.listKnowledgeGaps(business.id, { status: 'answered' });
    assert.equal(answered.length, 0);
  });

  it('updates a gap with answer and status', () => {
    const gap = db.createKnowledgeGap({ business_id: business.id, customer_phone: '1', question: 'Q1', gap_type: 'unanswered' });

    const updated = db.updateKnowledgeGap(gap.id, { status: 'answered', answer: 'We are open 9-5.' });
    assert.equal(updated.status, 'answered');
    assert.equal(updated.answer, 'We are open 9-5.');
  });

  it('deletes a gap', () => {
    const gap = db.createKnowledgeGap({ business_id: business.id, customer_phone: '1', question: 'Q1', gap_type: 'uncertain' });
    db.deleteKnowledgeGap(gap.id);
    assert.equal(db.getKnowledgeGap(gap.id), undefined);
  });

  it('counts gaps by status', () => {
    db.createKnowledgeGap({ business_id: business.id, customer_phone: '1', question: 'Q1', gap_type: 'unanswered' });
    db.createKnowledgeGap({ business_id: business.id, customer_phone: '2', question: 'Q2', gap_type: 'deflected' });
    const gap3 = db.createKnowledgeGap({ business_id: business.id, customer_phone: '3', question: 'Q3', gap_type: 'uncertain' });
    db.updateKnowledgeGap(gap3.id, { status: 'answered', answer: 'Yes.' });

    const counts = db.countKnowledgeGaps(business.id);
    assert.equal(counts.pending, 2);
    assert.equal(counts.answered, 1);
    assert.equal(counts.dismissed, 0);
  });

  it('getAnsweredKnowledgeGaps returns only answered gaps', () => {
    db.createKnowledgeGap({ business_id: business.id, customer_phone: '1', question: 'Q1', gap_type: 'unanswered' });
    const gap2 = db.createKnowledgeGap({ business_id: business.id, customer_phone: '2', question: 'Q2', gap_type: 'deflected' });
    db.updateKnowledgeGap(gap2.id, { status: 'answered', answer: 'We deliver on Mondays.' });

    const answered = db.getAnsweredKnowledgeGaps(business.id);
    assert.equal(answered.length, 1);
    assert.equal(answered[0].question, 'Q2');
    assert.equal(answered[0].answer, 'We deliver on Mondays.');
  });

  it('deleteBusinessKnowledgeGaps removes all gaps for a business', () => {
    db.createKnowledgeGap({ business_id: business.id, customer_phone: '1', question: 'Q1', gap_type: 'unanswered' });
    db.createKnowledgeGap({ business_id: business.id, customer_phone: '2', question: 'Q2', gap_type: 'deflected' });

    db.deleteBusinessKnowledgeGaps(business.id);
    assert.equal(db.listKnowledgeGaps(business.id).length, 0);
  });
});

describe('buildKnowledgeBasePrompt', () => {
  it('returns null when no answered gaps exist', () => {
    const result = buildKnowledgeBasePrompt(business.id);
    assert.equal(result, null);
  });

  it('returns null when only pending gaps exist', () => {
    db.createKnowledgeGap({ business_id: business.id, customer_phone: '1', question: 'Q1', gap_type: 'unanswered' });
    const result = buildKnowledgeBasePrompt(business.id);
    assert.equal(result, null);
  });

  it('builds prompt from answered gaps', () => {
    const gap1 = db.createKnowledgeGap({ business_id: business.id, customer_phone: '1', question: 'What are your hours?', gap_type: 'unanswered' });
    db.updateKnowledgeGap(gap1.id, { status: 'answered', answer: 'We are open Sunday-Thursday 9:00-17:00.' });

    const gap2 = db.createKnowledgeGap({ business_id: business.id, customer_phone: '2', question: 'Do you deliver?', gap_type: 'deflected' });
    db.updateKnowledgeGap(gap2.id, { status: 'answered', answer: 'Yes, we deliver within 10km radius.' });

    const result = buildKnowledgeBasePrompt(business.id);
    assert.ok(result);
    assert.ok(result.includes('Q: What are your hours?'));
    assert.ok(result.includes('A: We are open Sunday-Thursday 9:00-17:00.'));
    assert.ok(result.includes('Q: Do you deliver?'));
    assert.ok(result.includes('A: Yes, we deliver within 10km radius.'));
    assert.ok(result.includes('Additional business-provided answers'));
  });

  it('does not include dismissed gaps', () => {
    const gap = db.createKnowledgeGap({ business_id: business.id, customer_phone: '1', question: 'Q1', gap_type: 'uncertain' });
    db.updateKnowledgeGap(gap.id, { status: 'dismissed' });

    const result = buildKnowledgeBasePrompt(business.id);
    assert.equal(result, null);
  });
});
