const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../../../src/config');
config.dbPath = ':memory:';

const { getProvider, listProviders, registerProvider } = require('../../../src/services/scheduling');

describe('scheduling provider registry', () => {
  // ---------------------------------------------------------------------------
  // listProviders
  // ---------------------------------------------------------------------------
  describe('listProviders', () => {
    it('includes cal-com as a built-in provider', () => {
      const providers = listProviders();
      assert.ok(providers.includes('cal-com'));
    });

    it('includes acuity as a built-in provider', () => {
      const providers = listProviders();
      assert.ok(providers.includes('acuity'));
    });

    it('includes calendly as a built-in provider', () => {
      const providers = listProviders();
      assert.ok(providers.includes('calendly'));
    });

    it('includes square as a built-in provider', () => {
      const providers = listProviders();
      assert.ok(providers.includes('square'));
    });

    it('returns an array', () => {
      assert.ok(Array.isArray(listProviders()));
    });
  });

  // ---------------------------------------------------------------------------
  // registerProvider
  // ---------------------------------------------------------------------------
  describe('registerProvider', () => {
    it('adds a new provider to the list', () => {
      registerProvider('test-provider', (cfg) => ({ name: 'test', cfg }));
      assert.ok(listProviders().includes('test-provider'));
    });
  });

  // ---------------------------------------------------------------------------
  // getProvider
  // ---------------------------------------------------------------------------
  describe('getProvider', () => {
    it('returns null when scheduling_config is null', () => {
      const result = getProvider({ id: 'b1', scheduling_config: null });
      assert.equal(result, null);
    });

    it('returns null when scheduling_config is undefined', () => {
      const result = getProvider({ id: 'b1' });
      assert.equal(result, null);
    });

    it('returns null for invalid JSON', () => {
      const result = getProvider({ id: 'b1', scheduling_config: 'not-json{' });
      assert.equal(result, null);
    });

    it('returns null when provider field is missing', () => {
      const result = getProvider({ id: 'b1', scheduling_config: JSON.stringify({ api_key: 'x' }) });
      assert.equal(result, null);
    });

    it('returns null for unknown provider name', () => {
      const result = getProvider({
        id: 'b1',
        scheduling_config: JSON.stringify({ provider: 'nonexistent' }),
      });
      assert.equal(result, null);
    });

    it('returns a CalComProvider instance for cal-com', () => {
      const result = getProvider({
        id: 'b1',
        scheduling_config: JSON.stringify({
          provider: 'cal-com',
          api_key: 'test-key',
          event_type_id: '123',
        }),
      });
      assert.ok(result);
      assert.equal(typeof result.getServices, 'function');
      assert.equal(typeof result.getAvailableSlots, 'function');
      assert.equal(typeof result.bookAppointment, 'function');
      assert.equal(typeof result.cancelAppointment, 'function');
      assert.equal(typeof result.getBookings, 'function');
    });

    it('handles scheduling_config as object (not string)', () => {
      const result = getProvider({
        id: 'b1',
        scheduling_config: { provider: 'cal-com', api_key: 'test', event_type_id: '1' },
      });
      assert.ok(result);
      assert.equal(typeof result.getServices, 'function');
    });

    it('returns an AcuityProvider instance for acuity', () => {
      const result = getProvider({
        id: 'b1',
        scheduling_config: JSON.stringify({
          provider: 'acuity',
          api_key: 'test-key',
          user_id: 'test-user',
        }),
      });
      assert.ok(result);
      assert.equal(typeof result.getServices, 'function');
      assert.equal(typeof result.getAvailableSlots, 'function');
      assert.equal(typeof result.bookAppointment, 'function');
      assert.equal(typeof result.cancelAppointment, 'function');
      assert.equal(typeof result.getBookings, 'function');
    });

    it('returns a CalendlyProvider instance for calendly', () => {
      const result = getProvider({
        id: 'b1',
        scheduling_config: JSON.stringify({
          provider: 'calendly',
          api_key: 'test-key',
        }),
      });
      assert.ok(result);
      assert.equal(typeof result.getServices, 'function');
      assert.equal(typeof result.getAvailableSlots, 'function');
      assert.equal(typeof result.bookAppointment, 'function');
      assert.equal(typeof result.cancelAppointment, 'function');
      assert.equal(typeof result.getBookings, 'function');
    });

    it('returns a SquareProvider instance for square', () => {
      const result = getProvider({
        id: 'b1',
        scheduling_config: JSON.stringify({
          provider: 'square',
          api_key: 'test-key',
          location_id: 'loc-123',
        }),
      });
      assert.ok(result);
      assert.equal(typeof result.getServices, 'function');
      assert.equal(typeof result.getAvailableSlots, 'function');
      assert.equal(typeof result.bookAppointment, 'function');
      assert.equal(typeof result.cancelAppointment, 'function');
      assert.equal(typeof result.getBookings, 'function');
    });
  });
});
