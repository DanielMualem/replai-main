const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

describe('service-cache', () => {
  let serviceCache;

  beforeEach(() => {
    // Fresh module for each test
    delete require.cache[require.resolve('../../src/services/scheduling/service-cache')];
    serviceCache = require('../../src/services/scheduling/service-cache');
  });

  const SERVICES = [
    { id: '1', title: 'Haircut', duration: 30 },
    { id: '2', title: 'Coloring', duration: 60 },
  ];

  it('returns null on cache miss', () => {
    assert.strictEqual(serviceCache.getCachedServices('biz-1'), null);
  });

  it('returns cached services on cache hit', () => {
    serviceCache.cacheServices('biz-1', SERVICES, 60000);
    const result = serviceCache.getCachedServices('biz-1');
    assert.deepStrictEqual(result, SERVICES);
  });

  it('returns null after TTL expires', () => {
    // Cache with a 1ms TTL
    serviceCache.cacheServices('biz-1', SERVICES, 1);

    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    assert.strictEqual(serviceCache.getCachedServices('biz-1'), null);
  });

  it('invalidateServices clears a specific business', () => {
    serviceCache.cacheServices('biz-1', SERVICES, 60000);
    serviceCache.cacheServices('biz-2', [{ id: '3', title: 'Massage' }], 60000);

    serviceCache.invalidateServices('biz-1');

    assert.strictEqual(serviceCache.getCachedServices('biz-1'), null);
    assert.ok(serviceCache.getCachedServices('biz-2') !== null);
  });

  it('invalidateAll clears all businesses', () => {
    serviceCache.cacheServices('biz-1', SERVICES, 60000);
    serviceCache.cacheServices('biz-2', [{ id: '3', title: 'Massage' }], 60000);

    serviceCache.invalidateAll();

    assert.strictEqual(serviceCache.getCachedServices('biz-1'), null);
    assert.strictEqual(serviceCache.getCachedServices('biz-2'), null);
  });

  it('cacheServices returns the services array', () => {
    const result = serviceCache.cacheServices('biz-1', SERVICES, 60000);
    assert.deepStrictEqual(result, SERVICES);
  });
});
