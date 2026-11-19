const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Must set dbPath before requiring modules that load db.js
const config = require('../../src/config');
config.dbPath = ':memory:';
config.geminiCacheEnabled = true;
config.geminiCacheTtlSeconds = 3600;

const { computeContentHash, buildStaticSystemParts, getOrCreateCache, markInvalid, markAllInvalid, _getCacheIndex } = require('../../src/services/gemini-cache');

// ---------------------------------------------------------------------------
// computeContentHash
// ---------------------------------------------------------------------------
describe('computeContentHash', () => {
  it('returns consistent hash for same inputs', () => {
    const h1 = computeContentHash('prompt', 'scraped', 'sched', [{ fn: 'a' }]);
    const h2 = computeContentHash('prompt', 'scraped', 'sched', [{ fn: 'a' }]);
    assert.equal(h1, h2);
  });

  it('returns different hash when system prompt changes', () => {
    const h1 = computeContentHash('prompt1', 'scraped', null, null);
    const h2 = computeContentHash('prompt2', 'scraped', null, null);
    assert.notEqual(h1, h2);
  });

  it('returns different hash when scraped context changes', () => {
    const h1 = computeContentHash('prompt', 'context1', null, null);
    const h2 = computeContentHash('prompt', 'context2', null, null);
    assert.notEqual(h1, h2);
  });

  it('returns different hash when scheduling prompt changes', () => {
    const h1 = computeContentHash('prompt', null, 'sched1', null);
    const h2 = computeContentHash('prompt', null, 'sched2', null);
    assert.notEqual(h1, h2);
  });

  it('returns different hash when tools change', () => {
    const h1 = computeContentHash('prompt', null, null, [{ fn: 'a' }]);
    const h2 = computeContentHash('prompt', null, null, [{ fn: 'b' }]);
    assert.notEqual(h1, h2);
  });

  it('handles null/undefined inputs gracefully', () => {
    const h = computeContentHash(null, null, null, null);
    assert.ok(typeof h === 'string');
    assert.ok(h.length === 64); // SHA-256 hex
  });
});

// ---------------------------------------------------------------------------
// buildStaticSystemParts
// ---------------------------------------------------------------------------
describe('buildStaticSystemParts', () => {
  it('includes the business system prompt', () => {
    const business = { id: 'b1', system_prompt: 'You are a test bot.', scheduling_config: null };
    const { systemInstruction } = buildStaticSystemParts(business);
    assert.ok(systemInstruction.includes('You are a test bot.'));
  });

  it('includes no-reasoning instruction', () => {
    const business = { id: 'b1', system_prompt: 'Test', scheduling_config: null };
    const { systemInstruction } = buildStaticSystemParts(business);
    assert.ok(systemInstruction.includes('CRITICAL: Your reply must contain ONLY'));
  });

  it('includes human-agent attribution instruction', () => {
    const business = { id: 'b1', system_prompt: 'Test', scheduling_config: null };
    const { systemInstruction } = buildStaticSystemParts(business);
    assert.ok(systemInstruction.includes('[Human agent replied]'));
  });

  it('always includes escalation rules', () => {
    const business = { id: 'b1', system_prompt: 'Test', scheduling_config: null };
    const { systemInstruction } = buildStaticSystemParts(business);
    assert.ok(systemInstruction.includes('Escalation rules'));
  });

  it('includes Aiyelet identity preamble', () => {
    const business = { id: 'b1', system_prompt: 'Test', scheduling_config: null };
    const { systemInstruction } = buildStaticSystemParts(business);
    assert.ok(systemInstruction.includes('Your name is Aiyelet (איילת)'));
  });

  it('places Aiyelet identity before the business system prompt', () => {
    const business = { id: 'b1', system_prompt: 'Custom business prompt here', scheduling_config: null };
    const { systemInstruction } = buildStaticSystemParts(business);
    const identityIndex = systemInstruction.indexOf('Your name is Aiyelet');
    const promptIndex = systemInstruction.indexOf('Custom business prompt here');
    assert.ok(identityIndex < promptIndex, 'Aiyelet identity should appear before business system prompt');
  });

  it('does not include date/time (dynamic)', () => {
    const business = { id: 'b1', system_prompt: 'Test', scheduling_config: null };
    const { systemInstruction } = buildStaticSystemParts(business);
    assert.ok(!systemInstruction.includes('Current date and time'));
  });

  it('returns tools as undefined when no scheduling config', () => {
    const business = { id: 'b1', system_prompt: 'Test', scheduling_config: null };
    const { tools } = buildStaticSystemParts(business);
    assert.equal(tools, undefined);
  });
});

// ---------------------------------------------------------------------------
// markInvalid / markAllInvalid
// ---------------------------------------------------------------------------
describe('markInvalid', () => {
  beforeEach(() => {
    _getCacheIndex().clear();
  });

  it('removes a specific business entry', () => {
    _getCacheIndex().set('b1', { cacheName: 'test', contentHash: 'abc', model: 'gemini', expires: Date.now() + 99999 });
    _getCacheIndex().set('b2', { cacheName: 'test2', contentHash: 'def', model: 'gemini', expires: Date.now() + 99999 });
    markInvalid('b1');
    assert.equal(_getCacheIndex().has('b1'), false);
    assert.equal(_getCacheIndex().has('b2'), true);
  });

  it('is a no-op for non-existent business', () => {
    markInvalid('nonexistent');
    assert.equal(_getCacheIndex().size, 0);
  });
});

describe('markAllInvalid', () => {
  beforeEach(() => {
    _getCacheIndex().clear();
  });

  it('clears entire index', () => {
    _getCacheIndex().set('b1', { cacheName: 'test', contentHash: 'abc', model: 'gemini', expires: Date.now() + 99999 });
    _getCacheIndex().set('b2', { cacheName: 'test2', contentHash: 'def', model: 'gemini', expires: Date.now() + 99999 });
    markAllInvalid();
    assert.equal(_getCacheIndex().size, 0);
  });
});

// ---------------------------------------------------------------------------
// getOrCreateCache
// ---------------------------------------------------------------------------
describe('getOrCreateCache', () => {
  beforeEach(() => {
    _getCacheIndex().clear();
  });

  it('returns null when caching is disabled', async () => {
    const origEnabled = config.geminiCacheEnabled;
    config.geminiCacheEnabled = false;
    try {
      const result = await getOrCreateCache({}, { id: 'b1', system_prompt: 'Test', scheduling_config: null });
      assert.equal(result, null);
    } finally {
      config.geminiCacheEnabled = origEnabled;
    }
  });

  it('returns null when genAI is null', async () => {
    const result = await getOrCreateCache(null, { id: 'b1', system_prompt: 'Test', scheduling_config: null });
    assert.equal(result, null);
  });

  it('returns cached entry when index has valid cache', async () => {
    const business = { id: 'b1', system_prompt: 'Test', scheduling_config: null };
    const { systemInstruction, tools } = buildStaticSystemParts(business);
    const hash = computeContentHash(systemInstruction, null, null, tools);

    _getCacheIndex().set('b1', {
      cacheName: 'cached/123',
      contentHash: hash,
      model: config.defaultGeminiModel,
      expires: Date.now() + 99999,
    });

    const result = await getOrCreateCache({}, business);
    assert.deepEqual(result, { cacheName: 'cached/123' });
  });

  it('calls genAI.caches.create when no cached entry', async () => {
    let createCalled = false;
    const fakeGenAI = {
      caches: {
        create: async (cfg) => {
          createCalled = true;
          assert.ok(cfg.model);
          assert.ok(cfg.config.systemInstruction);
          assert.ok(cfg.ttl);
          return { name: 'cached/new-456' };
        },
      },
    };

    const business = { id: 'b2', system_prompt: 'New business prompt', scheduling_config: null };
    const result = await getOrCreateCache(fakeGenAI, business);
    assert.equal(createCalled, true);
    assert.deepEqual(result, { cacheName: 'cached/new-456' });
    assert.ok(_getCacheIndex().has('b2'));
  });

  it('returns null when cache creation fails', async () => {
    const fakeGenAI = {
      caches: {
        create: async () => { throw new Error('API error'); },
      },
    };

    const business = { id: 'b3', system_prompt: 'Test', scheduling_config: null };
    const result = await getOrCreateCache(fakeGenAI, business);
    assert.equal(result, null);
  });

  it('recreates cache when content hash changes', async () => {
    const business = { id: 'b4', system_prompt: 'Test', scheduling_config: null };

    // Seed index with old hash
    _getCacheIndex().set('b4', {
      cacheName: 'cached/old',
      contentHash: 'stale-hash',
      model: config.defaultGeminiModel,
      expires: Date.now() + 99999,
    });

    const fakeGenAI = {
      caches: {
        create: async () => ({ name: 'cached/new-789' }),
      },
    };

    const result = await getOrCreateCache(fakeGenAI, business);
    assert.deepEqual(result, { cacheName: 'cached/new-789' });
    assert.equal(_getCacheIndex().get('b4').cacheName, 'cached/new-789');
  });

  it('skips expired cache entries', async () => {
    const business = { id: 'b5', system_prompt: 'Test', scheduling_config: null };
    const { systemInstruction, tools } = buildStaticSystemParts(business);
    const hash = computeContentHash(systemInstruction, null, null, tools);

    _getCacheIndex().set('b5', {
      cacheName: 'cached/expired',
      contentHash: hash,
      model: config.defaultGeminiModel,
      expires: Date.now() - 1000, // expired
    });

    const fakeGenAI = {
      caches: {
        create: async () => ({ name: 'cached/fresh' }),
      },
    };

    const result = await getOrCreateCache(fakeGenAI, business);
    assert.deepEqual(result, { cacheName: 'cached/fresh' });
  });
});
