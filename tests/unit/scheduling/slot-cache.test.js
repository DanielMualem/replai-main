const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { cacheSlots, resolveSlot, clearSlots } = require('../../../src/services/scheduling/slot-cache');

describe('slot-cache', () => {
  const KEY = 'test-biz:+1234567890';

  beforeEach(() => {
    clearSlots(KEY);
    clearSlots('other-key');
  });

  // ---------------------------------------------------------------------------
  // cacheSlots
  // ---------------------------------------------------------------------------
  describe('cacheSlots', () => {
    it('assigns short IDs s1, s2, s3 to slots', () => {
      const slots = [
        { start: '2026-02-17T10:00:00Z', end: '2026-02-17T10:30:00Z' },
        { start: '2026-02-17T11:00:00Z', end: '2026-02-17T11:30:00Z' },
        { start: '2026-02-17T14:00:00Z', end: '2026-02-17T14:30:00Z' },
      ];
      const result = cacheSlots(KEY, slots);

      assert.equal(result.length, 3);
      assert.equal(result[0].shortId, 's1');
      assert.equal(result[1].shortId, 's2');
      assert.equal(result[2].shortId, 's3');
    });

    it('preserves original slot data in returned objects', () => {
      const slots = [
        { start: '2026-02-17T10:00:00Z', end: '2026-02-17T10:30:00Z', eventTypeId: '42' },
      ];
      const result = cacheSlots(KEY, slots);

      assert.equal(result[0].start, '2026-02-17T10:00:00Z');
      assert.equal(result[0].end, '2026-02-17T10:30:00Z');
      assert.equal(result[0].eventTypeId, '42');
      assert.equal(result[0].shortId, 's1');
    });

    it('overwrites previous cache for the same key', () => {
      cacheSlots(KEY, [{ start: 'old' }]);
      const result = cacheSlots(KEY, [{ start: 'new-1' }, { start: 'new-2' }]);

      assert.equal(result.length, 2);
      assert.equal(resolveSlot(KEY, 's1').start, 'new-1');
      assert.equal(resolveSlot(KEY, 's2').start, 'new-2');
    });

    it('handles empty slots array', () => {
      const result = cacheSlots(KEY, []);
      assert.equal(result.length, 0);
    });

    it('handles single slot', () => {
      const result = cacheSlots(KEY, [{ start: 'only' }]);
      assert.equal(result.length, 1);
      assert.equal(result[0].shortId, 's1');
    });
  });

  // ---------------------------------------------------------------------------
  // resolveSlot
  // ---------------------------------------------------------------------------
  describe('resolveSlot', () => {
    it('resolves s1 to the first cached slot', () => {
      cacheSlots(KEY, [
        { start: '2026-02-17T10:00:00Z' },
        { start: '2026-02-17T11:00:00Z' },
      ]);

      const slot = resolveSlot(KEY, 's1');
      assert.ok(slot);
      assert.equal(slot.start, '2026-02-17T10:00:00Z');
    });

    it('resolves s2 to the second cached slot', () => {
      cacheSlots(KEY, [
        { start: '2026-02-17T10:00:00Z' },
        { start: '2026-02-17T11:00:00Z' },
      ]);

      const slot = resolveSlot(KEY, 's2');
      assert.ok(slot);
      assert.equal(slot.start, '2026-02-17T11:00:00Z');
    });

    it('returns null for non-existent short ID', () => {
      cacheSlots(KEY, [{ start: 'a' }]);
      assert.equal(resolveSlot(KEY, 's99'), null);
    });

    it('returns null for non-existent key', () => {
      assert.equal(resolveSlot('no-such-key', 's1'), null);
    });

    it('returns null after clearSlots', () => {
      cacheSlots(KEY, [{ start: 'a' }]);
      clearSlots(KEY);
      assert.equal(resolveSlot(KEY, 's1'), null);
    });

    it('keeps different keys independent', () => {
      cacheSlots(KEY, [{ start: 'key1-slot' }]);
      cacheSlots('other-key', [{ start: 'key2-slot' }]);

      assert.equal(resolveSlot(KEY, 's1').start, 'key1-slot');
      assert.equal(resolveSlot('other-key', 's1').start, 'key2-slot');
    });
  });

  // ---------------------------------------------------------------------------
  // clearSlots
  // ---------------------------------------------------------------------------
  describe('clearSlots', () => {
    it('removes cache for the given key', () => {
      cacheSlots(KEY, [{ start: 'a' }]);
      clearSlots(KEY);
      assert.equal(resolveSlot(KEY, 's1'), null);
    });

    it('does not throw for non-existent key', () => {
      assert.doesNotThrow(() => clearSlots('nonexistent'));
    });

    it('does not affect other keys', () => {
      cacheSlots(KEY, [{ start: 'keep' }]);
      cacheSlots('other-key', [{ start: 'also-keep' }]);
      clearSlots(KEY);

      assert.equal(resolveSlot(KEY, 's1'), null);
      assert.equal(resolveSlot('other-key', 's1').start, 'also-keep');
    });
  });
});
