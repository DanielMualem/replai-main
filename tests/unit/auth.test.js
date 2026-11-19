const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { db, cleanDb, createTestSession } = require('../helpers/setup');

describe('Session CRUD', () => {
  beforeEach(() => cleanDb());

  it('creates and retrieves a session', () => {
    const session = createTestSession('admin@example.com');
    const found = db.getSession(session.id);
    assert.ok(found);
    assert.strictEqual(found.email, 'admin@example.com');
    assert.strictEqual(found.id, session.id);
  });

  it('returns null for expired session', () => {
    const crypto = require('crypto');
    const id = crypto.randomBytes(32).toString('hex');
    const pastDate = new Date(Date.now() - 1000).toISOString().replace('T', ' ').replace('Z', '');
    db.createSession({ id, email: 'expired@example.com', expires_at: pastDate });

    const found = db.getSession(id);
    assert.strictEqual(found, undefined);
  });

  it('deletes a session', () => {
    const session = createTestSession('delete@example.com');
    assert.ok(db.getSession(session.id));

    db.deleteSession(session.id);
    assert.strictEqual(db.getSession(session.id), undefined);
  });

  it('deleteSessionsByEmail clears only matching sessions', () => {
    const session1 = createTestSession('alice@example.com');
    const session2 = createTestSession('alice@example.com');
    const session3 = createTestSession('bob@example.com');

    // All three should exist
    assert.ok(db.getSession(session1.id));
    assert.ok(db.getSession(session2.id));
    assert.ok(db.getSession(session3.id));

    db.deleteSessionsByEmail('alice@example.com');

    // Alice's sessions should be gone
    assert.strictEqual(db.getSession(session1.id), undefined);
    assert.strictEqual(db.getSession(session2.id), undefined);
    // Bob's session should still exist
    assert.ok(db.getSession(session3.id));
  });

  it('cleans expired sessions', () => {
    const crypto = require('crypto');
    // Create an expired session
    const expiredId = crypto.randomBytes(32).toString('hex');
    const pastDate = new Date(Date.now() - 1000).toISOString().replace('T', ' ').replace('Z', '');
    db.createSession({ id: expiredId, email: 'old@example.com', expires_at: pastDate });

    // Create a valid session
    const valid = createTestSession('valid@example.com');

    db.cleanExpiredSessions();

    // Valid session still exists
    assert.ok(db.getSession(valid.id));
    // Expired session was cleaned — verify it's gone from the raw table too
    const raw = db.db.prepare('SELECT * FROM sessions WHERE id = ?').get(expiredId);
    assert.strictEqual(raw, undefined);
  });
});
