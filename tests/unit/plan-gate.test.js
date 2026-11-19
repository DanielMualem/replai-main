const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { canAccess, getScraperPageLimit } = require('../../src/middleware/plan-gate');

describe('plan-gate', () => {
  describe('canAccess', () => {
    it('trial has access to all features', () => {
      const biz = { subscription_plan: 'trial' };
      assert.equal(canAccess(biz, 'scheduling'), true);
      assert.equal(canAccess(biz, 'knowledge_gaps'), true);
      assert.equal(canAccess(biz, 'google_calendar'), true);
      assert.equal(canAccess(biz, 'booking_notifications'), true);
    });

    it('business has access to all features', () => {
      const biz = { subscription_plan: 'business' };
      assert.equal(canAccess(biz, 'scheduling'), true);
      assert.equal(canAccess(biz, 'knowledge_gaps'), true);
      assert.equal(canAccess(biz, 'google_calendar'), true);
      assert.equal(canAccess(biz, 'booking_notifications'), true);
    });

    it('starter has access to base features only', () => {
      const biz = { subscription_plan: 'starter' };
      assert.equal(canAccess(biz, 'scheduling'), false);
      assert.equal(canAccess(biz, 'knowledge_gaps'), false);
      assert.equal(canAccess(biz, 'google_calendar'), false);
      assert.equal(canAccess(biz, 'booking_notifications'), false);
    });

    it('starter can access non-gated features', () => {
      const biz = { subscription_plan: 'starter' };
      assert.equal(canAccess(biz, 'chat'), true);
      assert.equal(canAccess(biz, 'escalation'), true);
    });

    it('expired has no access to anything', () => {
      const biz = { subscription_plan: 'expired' };
      assert.equal(canAccess(biz, 'scheduling'), false);
      assert.equal(canAccess(biz, 'chat'), false);
    });

    it('null plan defaults to trial (full access)', () => {
      const biz = { subscription_plan: null };
      assert.equal(canAccess(biz, 'scheduling'), true);
      assert.equal(canAccess(biz, 'knowledge_gaps'), true);
    });

    it('undefined plan defaults to trial (full access)', () => {
      const biz = {};
      assert.equal(canAccess(biz, 'scheduling'), true);
    });
  });

  describe('getScraperPageLimit', () => {
    it('caps starter at 20', () => {
      assert.equal(getScraperPageLimit({ subscription_plan: 'starter' }, 50), 20);
    });

    it('respects config if lower than 20 for starter', () => {
      assert.equal(getScraperPageLimit({ subscription_plan: 'starter' }, 10), 10);
    });

    it('returns config default for business', () => {
      assert.equal(getScraperPageLimit({ subscription_plan: 'business' }, 50), 50);
    });

    it('returns config default for trial', () => {
      assert.equal(getScraperPageLimit({ subscription_plan: 'trial' }, 50), 50);
    });
  });
});
