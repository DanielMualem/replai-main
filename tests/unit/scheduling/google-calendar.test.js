const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

// Mock global fetch before requiring the provider
const originalFetch = global.fetch;

const GoogleCalendarProvider = require('../../../src/services/scheduling/providers/google-calendar');

describe('GoogleCalendarProvider', () => {
  let provider;
  const CONFIG = {
    business_id: 'test-biz-1',
    google_client_id: 'test-client-id',
    google_client_secret: 'test-client-secret',
    refresh_token: 'test-refresh-token',
    calendar_id: 'primary',
    timezone: 'Asia/Jerusalem',
    services: [
      { id: 'haircut', name: 'Haircut', duration: 30 },
      { id: 'coloring', name: 'Coloring', duration: 60 },
    ],
    working_hours: {
      sunday: [{ start: '09:00', end: '17:00' }],
      monday: [{ start: '09:00', end: '17:00' }],
    },
    slot_interval: 30,
    buffer_minutes: 0,
    blocked_dates: ['2099-12-25'],
  };

  beforeEach(() => {
    provider = new GoogleCalendarProvider(CONFIG);
    // Mock the OAuth2Client to return a test token
    provider.oauth2Client.getAccessToken = async () => ({ token: 'mock-access-token' });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('sets up config correctly', () => {
      assert.equal(provider.businessId, 'test-biz-1');
      assert.equal(provider.timezone, 'Asia/Jerusalem');
      assert.equal(provider.calendarId, 'primary');
      assert.equal(provider.services.length, 2);
      assert.equal(provider.slotInterval, 30);
    });

    it('defaults timezone to Asia/Jerusalem', () => {
      const p = new GoogleCalendarProvider({
        google_client_id: 'id',
        google_client_secret: 'secret',
        refresh_token: 'token',
      });
      assert.equal(p.timezone, 'Asia/Jerusalem');
    });

    it('defaults calendar_id to primary', () => {
      const p = new GoogleCalendarProvider({
        google_client_id: 'id',
        google_client_secret: 'secret',
        refresh_token: 'token',
      });
      assert.equal(p.calendarId, 'primary');
    });
  });

  // ---------------------------------------------------------------------------
  // getServices
  // ---------------------------------------------------------------------------
  describe('getServices', () => {
    it('returns services from config', async () => {
      const services = await provider.getServices();
      assert.equal(services.length, 2);
      assert.equal(services[0].id, 'haircut');
      assert.equal(services[0].name, 'Haircut');
      assert.equal(services[0].duration, 30);
      assert.equal(services[0].description, null);
      assert.equal(services[1].id, 'coloring');
    });

    it('returns empty array when no services configured', async () => {
      const p = new GoogleCalendarProvider({
        ...CONFIG,
        services: [],
      });
      const services = await p.getServices();
      assert.deepEqual(services, []);
    });
  });

  // ---------------------------------------------------------------------------
  // getAvailableSlots
  // ---------------------------------------------------------------------------
  describe('getAvailableSlots', () => {
    it('returns slots filtered by free/busy', async () => {
      // Mock fetch for free/busy API — return one busy period
      global.fetch = async (url, opts) => {
        if (url.includes('freeBusy')) {
          return {
            ok: true,
            json: async () => ({
              calendars: {
                primary: {
                  busy: [
                    // 10:00-10:30 is busy
                    { start: '2099-01-05T10:00:00+02:00', end: '2099-01-05T10:30:00+02:00' },
                  ],
                },
              },
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      };

      // 2099-01-05 is a Monday
      const slots = await provider.getAvailableSlots('2099-01-05', 'haircut');

      // Should have slots from 09:00-17:00 (16 slots of 30 min) minus 10:00-10:30
      assert.ok(slots.length > 0);
      assert.ok(slots.length < 16);

      // The 10:00 slot should not be present
      const tenAm = slots.find(s => s.start === '2099-01-05T10:00:00');
      assert.equal(tenAm, undefined);

      // 09:00 slot should be present
      const nineAm = slots.find(s => s.start === '2099-01-05T09:00:00');
      assert.ok(nineAm);
      assert.equal(nineAm.end, '2099-01-05T09:30:00');
    });

    it('returns empty array for blocked dates', async () => {
      const slots = await provider.getAvailableSlots('2099-12-25', 'haircut');
      assert.deepEqual(slots, []);
    });

    it('returns empty array for days with no working hours', async () => {
      // 2099-01-10 is a Saturday — not in working_hours
      const slots = await provider.getAvailableSlots('2099-01-10', 'haircut');
      assert.deepEqual(slots, []);
    });

    it('returns all slots when free/busy API fails', async () => {
      global.fetch = async () => ({ ok: false, status: 500 });

      const slots = await provider.getAvailableSlots('2099-01-05', 'haircut');
      // Should return all candidate slots since free/busy failed (no conflicts detected)
      assert.equal(slots.length, 16); // 09:00 to 17:00 in 30-min intervals
    });

    it('respects buffer_minutes', async () => {
      const bufferedProvider = new GoogleCalendarProvider({
        ...CONFIG,
        buffer_minutes: 15,
      });
      bufferedProvider.oauth2Client.getAccessToken = async () => ({ token: 'mock' });

      global.fetch = async (url) => {
        if (url.includes('freeBusy')) {
          return {
            ok: true,
            json: async () => ({
              calendars: {
                primary: {
                  busy: [
                    // 10:00-10:30 is busy, with 15-min buffer it blocks until 10:45
                    { start: '2099-01-05T10:00:00+02:00', end: '2099-01-05T10:30:00+02:00' },
                  ],
                },
              },
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      };

      const slots = await bufferedProvider.getAvailableSlots('2099-01-05', 'haircut');
      // 10:00 and 10:30 should both be blocked (10:00-10:30 busy + 15min buffer = 10:45)
      const tenAm = slots.find(s => s.start === '2099-01-05T10:00:00');
      const tenThirty = slots.find(s => s.start === '2099-01-05T10:30:00');
      assert.equal(tenAm, undefined);
      assert.equal(tenThirty, undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // bookAppointment
  // ---------------------------------------------------------------------------
  describe('bookAppointment', () => {
    it('creates calendar event and returns result', async () => {
      let calledUrl, calledBody;
      global.fetch = async (url, opts) => {
        if (url.includes('freeBusy')) {
          return {
            ok: true,
            json: async () => ({
              calendars: { primary: { busy: [] } },
            }),
          };
        }
        if (url.includes('/events') && opts?.method === 'POST') {
          calledUrl = url;
          calledBody = JSON.parse(opts.body);
          return {
            ok: true,
            json: async () => ({
              id: 'evt-123',
              status: 'confirmed',
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      };

      const result = await provider.bookAppointment(
        { start: '2099-01-05T10:00:00', serviceId: 'haircut' },
        { name: 'Alice', phone: '+972501234567' }
      );

      assert.equal(result.bookingId, 'evt-123');
      assert.equal(result.status, 'confirmed');
      assert.equal(result.start, '2099-01-05T10:00:00');
      assert.equal(result.end, '2099-01-05T10:30:00');

      // Verify the event body
      assert.ok(calledBody.summary.includes('Haircut'));
      assert.ok(calledBody.summary.includes('Alice'));
      assert.equal(calledBody.extendedProperties.private.aiyelet_booking, 'true');
      assert.equal(calledBody.extendedProperties.private.customer_phone, '+972501234567');
      assert.equal(calledBody.extendedProperties.private.service_id, 'haircut');
    });

    it('throws when slot is no longer available (conflict)', async () => {
      global.fetch = async (url) => {
        if (url.includes('freeBusy')) {
          return {
            ok: true,
            json: async () => ({
              calendars: {
                primary: {
                  busy: [{ start: '2099-01-05T10:00:00+02:00', end: '2099-01-05T10:30:00+02:00' }],
                },
              },
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      };

      await assert.rejects(
        () => provider.bookAppointment(
          { start: '2099-01-05T10:00:00', serviceId: 'haircut' },
          { name: 'Alice', phone: '+972501234567' }
        ),
        { message: /no longer available/ }
      );
    });

    it('throws on calendar API error', async () => {
      global.fetch = async (url, opts) => {
        if (url.includes('freeBusy')) {
          return {
            ok: true,
            json: async () => ({ calendars: { primary: { busy: [] } } }),
          };
        }
        if (opts?.method === 'POST') {
          return {
            ok: false,
            status: 403,
            json: async () => ({ error: { message: 'Forbidden' } }),
          };
        }
        return { ok: true, json: async () => ({}) };
      };

      await assert.rejects(
        () => provider.bookAppointment(
          { start: '2099-01-05T10:00:00', serviceId: 'haircut' },
          { name: 'Alice', phone: '+972501234567' }
        ),
        { message: /Failed to create calendar event: 403: Forbidden/ }
      );
    });
  });

  // ---------------------------------------------------------------------------
  // cancelAppointment
  // ---------------------------------------------------------------------------
  describe('cancelAppointment', () => {
    it('deletes the calendar event', async () => {
      let deletedUrl;
      global.fetch = async (url, opts) => {
        if (opts?.method === 'DELETE') {
          deletedUrl = url;
          return { ok: true };
        }
        return { ok: true, json: async () => ({}) };
      };

      const result = await provider.cancelAppointment('evt-123');
      assert.equal(result.success, true);
      assert.equal(result.bookingId, 'evt-123');
      assert.ok(deletedUrl.includes('evt-123'));
    });

    it('succeeds when event already gone (410)', async () => {
      global.fetch = async () => ({ ok: false, status: 410 });

      const result = await provider.cancelAppointment('evt-gone');
      assert.equal(result.success, true);
    });

    it('throws on API error', async () => {
      global.fetch = async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: { message: 'Not Found' } }),
      });

      await assert.rejects(
        () => provider.cancelAppointment('evt-bad'),
        { message: /Failed to cancel appointment: 404: Not Found/ }
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getBookings
  // ---------------------------------------------------------------------------
  describe('getBookings', () => {
    it('returns bookings filtered by customer phone', async () => {
      global.fetch = async (url) => {
        if (url.includes('/events?')) {
          return {
            ok: true,
            json: async () => ({
              items: [
                {
                  id: 'evt-1',
                  summary: 'Haircut - Alice',
                  start: { dateTime: '2099-01-05T10:00:00+02:00' },
                  end: { dateTime: '2099-01-05T10:30:00+02:00' },
                  status: 'confirmed',
                  extendedProperties: {
                    private: {
                      aiyelet_booking: 'true',
                      customer_phone: '+972501234567',
                      service_name: 'Haircut',
                    },
                  },
                },
              ],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      };

      const bookings = await provider.getBookings('+972501234567');
      assert.equal(bookings.length, 1);
      assert.equal(bookings[0].bookingId, 'evt-1');
      assert.equal(bookings[0].title, 'Haircut');
      assert.equal(bookings[0].status, 'confirmed');
      assert.equal(bookings[0].attendeeName, 'Alice');
    });

    it('passes both privateExtendedProperty filters in API call', async () => {
      let calledUrl;
      global.fetch = async (url) => {
        calledUrl = url;
        return {
          ok: true,
          json: async () => ({ items: [] }),
        };
      };

      await provider.getBookings('+972501234567');
      // Should include both filters as query params
      assert.ok(calledUrl.includes('privateExtendedProperty=customer_phone'));
      assert.ok(calledUrl.includes('privateExtendedProperty=aiyelet_booking'));
    });

    it('throws on API error', async () => {
      global.fetch = async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'Unauthorized' } }),
      });

      await assert.rejects(
        () => provider.getBookings('+972501234567'),
        { message: /Failed to fetch bookings: 401: Unauthorized/ }
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Helper methods
  // ---------------------------------------------------------------------------
  describe('helpers', () => {
    it('_timeToMinutes handles ISO format', () => {
      assert.equal(provider._timeToMinutes('2099-01-05T09:30:00'), 570);
    });

    it('_timeToMinutes handles plain time', () => {
      assert.equal(provider._timeToMinutes('14:15'), 855);
    });

    it('_minutesToTime formats correctly', () => {
      assert.equal(provider._minutesToTime(570), '09:30');
      assert.equal(provider._minutesToTime(0), '00:00');
      assert.equal(provider._minutesToTime(1439), '23:59');
    });

    it('_findServiceBySlot finds by serviceId', () => {
      const s = provider._findServiceBySlot({ serviceId: 'coloring' });
      assert.equal(s.id, 'coloring');
      assert.equal(s.duration, 60);
    });

    it('_findServiceBySlot finds by serviceName', () => {
      const s = provider._findServiceBySlot({ serviceName: 'Haircut' });
      assert.equal(s.id, 'haircut');
    });

    it('_findServiceBySlot defaults to first service', () => {
      const s = provider._findServiceBySlot({});
      assert.equal(s.id, 'haircut');
    });

    it('_getTimezoneOffset returns valid offset format', () => {
      const offset = provider._getTimezoneOffset('2099-06-15');
      // Asia/Jerusalem is +02:00 or +03:00 (DST)
      assert.match(offset, /^[+-]\d{2}:\d{2}$/);
    });
  });
});
