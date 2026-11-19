const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../src/config');

// ---------------------------------------------------------------------------
// crypto.js — AES-256-GCM token encryption
// ---------------------------------------------------------------------------

describe('crypto', () => {
  let originalKey;

  beforeEach(() => {
    originalKey = config.tokenEncryptionKey;
  });

  afterEach(() => {
    config.tokenEncryptionKey = originalKey;
    // Re-require to pick up config changes
    delete require.cache[require.resolve('../../src/services/crypto')];
  });

  function loadCrypto() {
    delete require.cache[require.resolve('../../src/services/crypto')];
    return require('../../src/services/crypto');
  }

  // ---------------------------------------------------------------------------
  // No encryption key (dev mode)
  // ---------------------------------------------------------------------------
  describe('without TOKEN_ENCRYPTION_KEY', () => {
    it('encrypt returns plaintext unchanged', () => {
      config.tokenEncryptionKey = '';
      const crypto = loadCrypto();
      assert.equal(crypto.encrypt('my-secret-token'), 'my-secret-token');
    });

    it('decrypt returns plaintext unchanged', () => {
      config.tokenEncryptionKey = '';
      const crypto = loadCrypto();
      assert.equal(crypto.decrypt('my-secret-token'), 'my-secret-token');
    });

    it('encrypt returns null for null input', () => {
      config.tokenEncryptionKey = '';
      const crypto = loadCrypto();
      assert.equal(crypto.encrypt(null), null);
    });

    it('decrypt returns null for null input', () => {
      config.tokenEncryptionKey = '';
      const crypto = loadCrypto();
      assert.equal(crypto.decrypt(null), null);
    });

    it('encrypt returns empty string for empty string', () => {
      config.tokenEncryptionKey = '';
      const crypto = loadCrypto();
      assert.equal(crypto.encrypt(''), '');
    });
  });

  // ---------------------------------------------------------------------------
  // With encryption key (production mode)
  // ---------------------------------------------------------------------------
  describe('with TOKEN_ENCRYPTION_KEY', () => {
    const TEST_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes

    it('encrypt produces encrypted format (iv:authTag:ciphertext)', () => {
      config.tokenEncryptionKey = TEST_KEY;
      const crypto = loadCrypto();
      const encrypted = crypto.encrypt('my-secret-token');
      const parts = encrypted.split(':');
      assert.equal(parts.length, 3);
      // IV = 12 bytes = 24 hex chars
      assert.equal(parts[0].length, 24);
      // Auth tag = 16 bytes = 32 hex chars
      assert.equal(parts[1].length, 32);
      // Ciphertext should be non-empty hex
      assert.ok(parts[2].length > 0);
      assert.ok(/^[0-9a-f]+$/.test(parts[2]));
    });

    it('encrypt does not return the plaintext', () => {
      config.tokenEncryptionKey = TEST_KEY;
      const crypto = loadCrypto();
      const encrypted = crypto.encrypt('my-secret-token');
      assert.ok(!encrypted.includes('my-secret-token'));
    });

    it('decrypt round-trips correctly', () => {
      config.tokenEncryptionKey = TEST_KEY;
      const crypto = loadCrypto();
      const original = 'EAABsbCS1234567890abcdef';
      const encrypted = crypto.encrypt(original);
      const decrypted = crypto.decrypt(encrypted);
      assert.equal(decrypted, original);
    });

    it('round-trips unicode tokens', () => {
      config.tokenEncryptionKey = TEST_KEY;
      const crypto = loadCrypto();
      const original = 'token-with-utf8-\u00e9\u00e0\u00fc';
      const encrypted = crypto.encrypt(original);
      assert.equal(crypto.decrypt(encrypted), original);
    });

    it('round-trips long tokens', () => {
      config.tokenEncryptionKey = TEST_KEY;
      const crypto = loadCrypto();
      const original = 'x'.repeat(500);
      const encrypted = crypto.encrypt(original);
      assert.equal(crypto.decrypt(encrypted), original);
    });

    it('produces different ciphertext each time (random IV)', () => {
      config.tokenEncryptionKey = TEST_KEY;
      const crypto = loadCrypto();
      const a = crypto.encrypt('same-token');
      const b = crypto.encrypt('same-token');
      assert.notEqual(a, b);
      // But both decrypt to the same value
      assert.equal(crypto.decrypt(a), 'same-token');
      assert.equal(crypto.decrypt(b), 'same-token');
    });

    it('encrypt returns null for null input', () => {
      config.tokenEncryptionKey = TEST_KEY;
      const crypto = loadCrypto();
      assert.equal(crypto.encrypt(null), null);
    });

    it('encrypt returns empty string for empty string', () => {
      config.tokenEncryptionKey = TEST_KEY;
      const crypto = loadCrypto();
      assert.equal(crypto.encrypt(''), '');
    });

    it('decrypt passes through plaintext (migration compat)', () => {
      config.tokenEncryptionKey = TEST_KEY;
      const crypto = loadCrypto();
      // A plaintext token doesn't match the encrypted format
      assert.equal(crypto.decrypt('EAABsbCS1iZAkBAJ'), 'EAABsbCS1iZAkBAJ');
    });

    it('decrypt fails with wrong key', () => {
      config.tokenEncryptionKey = TEST_KEY;
      const crypto = loadCrypto();
      const encrypted = crypto.encrypt('secret');

      // Switch to a different key
      config.tokenEncryptionKey = 'b'.repeat(64);
      const crypto2 = loadCrypto();
      assert.throws(() => crypto2.decrypt(encrypted));
    });

    it('decrypt fails with tampered ciphertext', () => {
      config.tokenEncryptionKey = TEST_KEY;
      const crypto = loadCrypto();
      const encrypted = crypto.encrypt('secret');
      // Flip last hex char of ciphertext
      const tampered = encrypted.slice(0, -1) + (encrypted.slice(-1) === '0' ? '1' : '0');
      assert.throws(() => crypto.decrypt(tampered));
    });
  });

  // ---------------------------------------------------------------------------
  // With passphrase key (non-hex)
  // ---------------------------------------------------------------------------
  describe('with passphrase key (non-hex)', () => {
    it('derives a key and round-trips correctly', () => {
      config.tokenEncryptionKey = 'my-secret-passphrase';
      const crypto = loadCrypto();
      const encrypted = crypto.encrypt('token123');
      assert.ok(crypto.isEncrypted(encrypted));
      assert.equal(crypto.decrypt(encrypted), 'token123');
    });
  });

  // ---------------------------------------------------------------------------
  // isEncrypted
  // ---------------------------------------------------------------------------
  describe('isEncrypted', () => {
    it('returns true for encrypted format', () => {
      config.tokenEncryptionKey = 'a'.repeat(64);
      const crypto = loadCrypto();
      const encrypted = crypto.encrypt('test');
      assert.equal(crypto.isEncrypted(encrypted), true);
    });

    it('returns false for plaintext token', () => {
      config.tokenEncryptionKey = '';
      const crypto = loadCrypto();
      assert.equal(crypto.isEncrypted('EAABsbCS1iZAkBAJ'), false);
    });

    it('returns false for null', () => {
      config.tokenEncryptionKey = '';
      const crypto = loadCrypto();
      assert.equal(crypto.isEncrypted(null), false);
    });

    it('returns false for empty string', () => {
      config.tokenEncryptionKey = '';
      const crypto = loadCrypto();
      assert.equal(crypto.isEncrypted(''), false);
    });

    it('returns false for string with colons but wrong hex lengths', () => {
      config.tokenEncryptionKey = '';
      const crypto = loadCrypto();
      assert.equal(crypto.isEncrypted('abc:def:ghi'), false);
    });
  });
});
