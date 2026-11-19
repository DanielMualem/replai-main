const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { db, cleanDb, createTestBusiness } = require('../helpers/setup');
const { whatsappSignupSchema } = require('../../src/validation');

describe('Signup Invite DB CRUD', () => {
  let business;

  beforeEach(() => {
    cleanDb();
    business = createTestBusiness({ name: 'Signup Test Biz' });
  });

  it('creates and retrieves a valid invite', () => {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

    const invite = db.createSignupInvite(business.id, token, expiresAt);
    assert.ok(invite);
    assert.equal(invite.token, token);
    assert.equal(invite.business_id, business.id);
    assert.equal(invite.used, 0);

    const found = db.getSignupInvite(token);
    assert.ok(found);
    assert.equal(found.business_name, 'Signup Test Biz');
    assert.equal(found.business_active, 1);
  });

  it('returns undefined for expired invite', () => {
    const token = crypto.randomBytes(32).toString('hex');
    const pastDate = new Date(Date.now() - 1000)
      .toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

    db.createSignupInvite(business.id, token, pastDate);

    const found = db.getSignupInvite(token);
    assert.equal(found, undefined);
  });

  it('returns undefined for used invite', () => {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

    db.createSignupInvite(business.id, token, expiresAt);
    db.markSignupInviteUsed(token);

    const found = db.getSignupInvite(token);
    assert.equal(found, undefined);
  });

  it('lists invites for a business', () => {
    const token1 = crypto.randomBytes(32).toString('hex');
    const token2 = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

    db.createSignupInvite(business.id, token1, expiresAt);
    db.createSignupInvite(business.id, token2, expiresAt);

    const list = db.listSignupInvites(business.id);
    assert.equal(list.length, 2);
  });

  it('getSignupInviteRaw returns invite regardless of status', () => {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

    db.createSignupInvite(business.id, token, expiresAt);
    db.markSignupInviteUsed(token);

    const raw = db.getSignupInviteRaw(token);
    assert.ok(raw);
    assert.equal(raw.used, 1);
  });

  it('cleanExpiredInvites runs without error', () => {
    assert.doesNotThrow(() => db.cleanExpiredInvites());
  });
});

describe('Business waba_id field', () => {
  beforeEach(() => cleanDb());

  it('createBusiness accepts waba_id', () => {
    const biz = createTestBusiness({ waba_id: 'waba_123' });
    const found = db.getBusiness(biz.id);
    assert.ok(found);
    assert.equal(found.waba_id, 'waba_123');
  });

  it('updateBusiness sets waba_id', () => {
    const biz = createTestBusiness();
    db.updateBusiness(biz.id, { waba_id: 'waba_456' });

    const updated = db.getBusiness(biz.id);
    assert.equal(updated.waba_id, 'waba_456');
  });
});

describe('whatsappSignupSchema', () => {
  it('validates correct payload', () => {
    const result = whatsappSignupSchema.safeParse({
      code: 'auth_code_123',
      waba_id: '12345',
      phone_number_id: '67890',
    });
    assert.ok(result.success);
  });

  it('rejects missing code', () => {
    const result = whatsappSignupSchema.safeParse({
      waba_id: '12345',
      phone_number_id: '67890',
    });
    assert.ok(!result.success);
  });

  it('rejects empty code', () => {
    const result = whatsappSignupSchema.safeParse({
      code: '',
      waba_id: '12345',
      phone_number_id: '67890',
    });
    assert.ok(!result.success);
  });

  it('rejects missing waba_id', () => {
    const result = whatsappSignupSchema.safeParse({
      code: 'auth_code',
      phone_number_id: '67890',
    });
    assert.ok(!result.success);
  });

  it('rejects missing phone_number_id', () => {
    const result = whatsappSignupSchema.safeParse({
      code: 'auth_code',
      waba_id: '12345',
    });
    assert.ok(!result.success);
  });
});
