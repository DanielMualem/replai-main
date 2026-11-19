const crypto = require('crypto');
const config = require('../config');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// Encrypted format: hex(iv):hex(authTag):hex(ciphertext)
const ENCRYPTED_PATTERN = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/;

let _cachedKey = null;
let _cachedKeySource = null;

function getKey() {
  if (!config.tokenEncryptionKey) return null;
  // Return cached key if the config hasn't changed
  if (_cachedKey && _cachedKeySource === config.tokenEncryptionKey) return _cachedKey;
  // Accept hex-encoded 32-byte key or derive one from a passphrase
  const raw = config.tokenEncryptionKey;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    _cachedKey = Buffer.from(raw, 'hex');
  } else {
    _cachedKey = crypto.scryptSync(raw, 'replai-token-encryption', 32);
  }
  _cachedKeySource = raw;
  return _cachedKey;
}

function isEncrypted(stored) {
  return typeof stored === 'string' && ENCRYPTED_PATTERN.test(stored);
}

function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key = getKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(stored) {
  if (!stored) return stored;
  if (!isEncrypted(stored)) return stored; // plaintext passthrough for migration compat
  const key = getKey();
  if (!key) return stored; // no key configured, return as-is

  const [ivHex, authTagHex, ciphertextHex] = stored.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

module.exports = { encrypt, decrypt, isEncrypted };
