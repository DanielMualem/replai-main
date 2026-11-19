const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const AcuityProvider = require('../../../src/services/scheduling/providers/acuity');

describe('AcuityProvider', () => {
  let provider;
  const CONFIG = {
    api_key: 'test-api-key',
    user_id: 'test-user-id',
    timezone: 'Asia/Jerusalem',
  };

  beforeEach(() => {
    provider = new AcuityProvider(CONFIG);
    // Replace the client with controllable mock methods
    provider.client = {
      get: async () => ({ data: [] }),
      post: async () => ({ data: {} }),
      put: async () => ({ data: {} }),
    };
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('sets up config correctly', () => {
      assert.equal(provider.apiKey, 'test-api-key');
      assert.equal(provider.userId, 'test-user-id');
      assert.equal(provider.timezone, 'Asia/Jerusalem');
    });

    it('defaults timezone to Asia/Jerusalem', () => {
      const p = new AcuityProvider({ api_key: 'k', user_id: 'u' });
      assert.equal(p.timezone, 'Asia/Jerusalem');
    });

    it('uses custom timezone when provided', () => {
      const p = new AcuityProvider({ api_key: 'k', user_id: 'u', timezone: 'UTC' });
      assert.equal(p.timezone, 'UTC');
    });
  });

  // ---------------------------------------------------------------------------
  // getServices
  // ---------------------------------------------------------------------------
  describe('getServices', () => {
    it('returns mapped appointment types', async () => {
      provider.client.get = async () => ({
        data: [
          { id: 1, name: 'Haircut', duration: 30, description: 'Basic haircut' },
          { id: 2, name: 'Coloring', duration: 60, description: null },
        ],
      });

      const services = await provider.getServices();
      assert.equal(services.length, 2);
      assert.equal(services[0].id, '1');
      assert.equal(services[0].name, 'Haircut');
      assert.equal(services[0].duration, 30);
      assert.equal(services[0].description, 'Basic haircut');
      assert.equal(services[1].id, '2');
      assert.equal(services[1].description, null);
    });

    it('returns empty array when API returns non-array', async () => {
      provider.client.get = async () => ({ data: {} });

      const services = await provider.getServices();
      assert.deepEqual(services, []);
    });

    it('throws on API error', async () => {
      provider.client.get = async () => {
        const err = new Error('Network error');
        err.response = { status: 500, data: { message: 'Internal server error' } };
        throw err;
      };

      await assert.rejects(
        () => provider.getServices(),
        { message: 'Failed to fetch services: 500: Internal server error' },
      );
    });

    it('falls back to err.message when no response data', async () => {
      provider.client.get = async () => {
        throw new Error('Connection refused');
      };

      await assert.rejects(
        () => provider.getServices(),
        { message: 'Failed to fetch services: Connection refused' },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getAvailableSlots
  // ---------------------------------------------------------------------------
  describe('getAvailableSlots', () => {
    it('returns mapped time slots', async () => {
      provider.client.get = async (url, opts) => {
        assert.equal(opts.params.date, '2099-01-15');
        assert.equal(opts.params.appointmentTypeID, '42');
        return {
          data: [
            { time: '2099-01-15T10:00:00+0200' },
            { time: '2099-01-15T11:00:00+0200' },
          ],
        };
      };

      const slots = await provider.getAvailableSlots('2099-01-15', '42');
      assert.equal(slots.length, 2);
      assert.equal(slots[0].start, '2099-01-15T10:00:00+0200');
      assert.equal(slots[0].end, null);
      assert.equal(slots[0].appointmentTypeId, '42');
      assert.equal(slots[0].date, '2099-01-15');
    });

    it('returns empty array when no times available', async () => {
      provider.client.get = async () => ({ data: [] });

      const slots = await provider.getAvailableSlots('2099-01-15', '42');
      assert.deepEqual(slots, []);
    });

    it('throws when no service_id provided', async () => {
      await assert.rejects(
        () => provider.getAvailableSlots('2099-01-15'),
        { message: /No service_id provided/ },
      );
    });

    it('throws on API error', async () => {
      provider.client.get = async () => {
        const err = new Error('fail');
        err.response = { status: 404, data: { error: 'Not found' } };
        throw err;
      };

      await assert.rejects(
        () => provider.getAvailableSlots('2099-01-15', '42'),
        { message: 'Failed to fetch availability: 404: Not found' },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // bookAppointment
  // ---------------------------------------------------------------------------
  describe('bookAppointment', () => {
    it('books appointment and returns result', async () => {
      let postedBody;
      provider.client.post = async (url, body) => {
        postedBody = body;
        return {
          data: {
            id: 12345,
            datetime: '2099-01-15T10:00:00+0200',
            endTime: '2099-01-15T10:30:00+0200',
          },
        };
      };

      const result = await provider.bookAppointment(
        { start: '2099-01-15T10:00:00+0200', appointmentTypeId: '42' },
        { name: 'Alice Smith', phone: '+972501234567' },
      );

      assert.equal(result.bookingId, '12345');
      assert.equal(result.status, 'confirmed');
      assert.equal(result.start, '2099-01-15T10:00:00+0200');
      assert.equal(result.end, '2099-01-15T10:30:00+0200');
      assert.equal(result.meetingUrl, null);

      // Check posted body
      assert.equal(postedBody.firstName, 'Alice');
      assert.equal(postedBody.lastName, 'Smith');
      assert.equal(postedBody.appointmentTypeID, 42);
      assert.equal(postedBody.datetime, '2099-01-15T10:00:00+0200');
      assert.equal(postedBody.email, '+972501234567@placeholder.whatsapp');
      assert.equal(postedBody.phone, '+972501234567');
    });

    it('splits name correctly - single name uses full as firstName', async () => {
      let postedBody;
      provider.client.post = async (url, body) => {
        postedBody = body;
        return { data: { id: 1, datetime: '2099-01-15T10:00:00Z' } };
      };

      await provider.bookAppointment(
        { start: '2099-01-15T10:00:00Z', appointmentTypeId: '1' },
        { name: 'Madonna', phone: '+1234' },
      );

      assert.equal(postedBody.firstName, 'Madonna');
      assert.equal(postedBody.lastName, '');
    });

    it('splits name on first space only', async () => {
      let postedBody;
      provider.client.post = async (url, body) => {
        postedBody = body;
        return { data: { id: 1, datetime: '2099-01-15T10:00:00Z' } };
      };

      await provider.bookAppointment(
        { start: '2099-01-15T10:00:00Z', appointmentTypeId: '1' },
        { name: 'Mary Jane Watson', phone: '+1234' },
      );

      assert.equal(postedBody.firstName, 'Mary');
      assert.equal(postedBody.lastName, 'Jane Watson');
    });

    it('uses default name when none provided', async () => {
      let postedBody;
      provider.client.post = async (url, body) => {
        postedBody = body;
        return { data: { id: 1, datetime: '2099-01-15T10:00:00Z' } };
      };

      await provider.bookAppointment(
        { start: '2099-01-15T10:00:00Z', appointmentTypeId: '1' },
        { phone: '+1234' },
      );

      assert.equal(postedBody.firstName, 'Customer');
      assert.equal(postedBody.lastName, '');
    });

    it('uses placeholder email when no email or phone', async () => {
      let postedBody;
      provider.client.post = async (url, body) => {
        postedBody = body;
        return { data: { id: 1, datetime: '2099-01-15T10:00:00Z' } };
      };

      await provider.bookAppointment(
        { start: '2099-01-15T10:00:00Z', appointmentTypeId: '1' },
        { name: 'Test' },
      );

      assert.equal(postedBody.email, 'unknown@placeholder.whatsapp');
    });

    it('uses custom email when provided', async () => {
      let postedBody;
      provider.client.post = async (url, body) => {
        postedBody = body;
        return { data: { id: 1, datetime: '2099-01-15T10:00:00Z' } };
      };

      await provider.bookAppointment(
        { start: '2099-01-15T10:00:00Z', appointmentTypeId: '1' },
        { name: 'Test', email: 'test@example.com', phone: '+1234' },
      );

      assert.equal(postedBody.email, 'test@example.com');
    });

    it('throws when no appointmentTypeId', async () => {
      await assert.rejects(
        () => provider.bookAppointment({ start: '2099-01-15T10:00:00Z' }, { name: 'Test' }),
        { message: /No appointmentTypeId for booking/ },
      );
    });

    it('throws on API error', async () => {
      provider.client.post = async () => {
        const err = new Error('fail');
        err.response = { status: 400, data: { message: 'Bad request' } };
        throw err;
      };

      await assert.rejects(
        () => provider.bookAppointment(
          { start: '2099-01-15T10:00:00Z', appointmentTypeId: '1' },
          { name: 'Test', phone: '+1234' },
        ),
        { message: 'Failed to book appointment: 400: Bad request' },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // cancelAppointment
  // ---------------------------------------------------------------------------
  describe('cancelAppointment', () => {
    it('cancels appointment using PUT', async () => {
      let calledUrl;
      provider.client.put = async (url) => {
        calledUrl = url;
        return { data: {} };
      };

      const result = await provider.cancelAppointment('99');
      assert.equal(result.success, true);
      assert.equal(result.bookingId, '99');
      assert.equal(calledUrl, '/appointments/99/cancel');
    });

    it('throws on API error', async () => {
      provider.client.put = async () => {
        const err = new Error('fail');
        err.response = { status: 404, data: { message: 'Appointment not found' } };
        throw err;
      };

      await assert.rejects(
        () => provider.cancelAppointment('99'),
        { message: 'Failed to cancel appointment: 404: Appointment not found' },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getBookings
  // ---------------------------------------------------------------------------
  describe('getBookings', () => {
    it('returns bookings from email lookup (strategy 1)', async () => {
      let calls = 0;
      provider.client.get = async (url, opts) => {
        calls++;
        if (calls === 1) {
          assert.equal(opts.params.email, '+972501234567@placeholder.whatsapp');
          return {
            data: [
              { id: 100, type: 'Haircut', datetime: '2099-06-15T10:00:00Z', endTime: '2099-06-15T10:30:00Z', firstName: 'Alice', lastName: 'Smith' },
            ],
          };
        }
        return { data: [] };
      };

      const bookings = await provider.getBookings('+972501234567');
      assert.equal(bookings.length, 1);
      assert.equal(bookings[0].bookingId, '100');
      assert.equal(bookings[0].title, 'Haircut');
      assert.equal(bookings[0].attendeeName, 'Alice Smith');
      assert.equal(bookings[0].status, 'confirmed');
    });

    it('returns bookings from phone match (strategy 2)', async () => {
      let calls = 0;
      provider.client.get = async () => {
        calls++;
        if (calls === 1) return { data: [] };
        return {
          data: [
            { id: 200, type: 'Coloring', datetime: '2099-06-15T14:00:00Z', endTime: '2099-06-15T15:00:00Z', phone: '+972501234567', firstName: 'Bob' },
            { id: 201, type: 'Other', datetime: '2099-06-16T09:00:00Z', phone: '+999', firstName: 'Eve' },
          ],
        };
      };

      const bookings = await provider.getBookings('+972501234567');
      assert.equal(bookings.length, 1);
      assert.equal(bookings[0].bookingId, '200');
      assert.equal(bookings[0].title, 'Coloring');
    });

    it('deduplicates across strategies', async () => {
      let calls = 0;
      provider.client.get = async () => {
        calls++;
        if (calls === 1) {
          return {
            data: [
              { id: 300, type: 'Haircut', datetime: '2099-06-15T10:00:00Z', firstName: 'Alice', phone: '+1234' },
            ],
          };
        }
        return {
          data: [
            { id: 300, type: 'Haircut', datetime: '2099-06-15T10:00:00Z', firstName: 'Alice', phone: '+1234' },
            { id: 301, type: 'Coloring', datetime: '2099-06-16T10:00:00Z', firstName: 'Alice', phone: '+1234' },
          ],
        };
      };

      const bookings = await provider.getBookings('+1234');
      assert.equal(bookings.length, 2);
      const ids = bookings.map(b => b.bookingId);
      assert.ok(ids.includes('300'));
      assert.ok(ids.includes('301'));
    });

    it('filters upcoming bookings (default)', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      const pastDate = new Date(Date.now() - 86400000).toISOString();

      provider.client.get = async (url, opts) => {
        if (opts.params.email) {
          return {
            data: [
              { id: 400, type: 'Future', datetime: futureDate, firstName: 'A' },
              { id: 401, type: 'Past', datetime: pastDate, firstName: 'A' },
              { id: 402, type: 'Cancelled', datetime: futureDate, firstName: 'A', canceled: true },
            ],
          };
        }
        return { data: [] };
      };

      const bookings = await provider.getBookings('+1234');
      assert.equal(bookings.length, 1);
      assert.equal(bookings[0].bookingId, '400');
    });

    it('filters cancelled bookings', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();

      provider.client.get = async (url, opts) => {
        if (opts.params.email) {
          return {
            data: [
              { id: 500, type: 'Active', datetime: futureDate, firstName: 'A' },
              { id: 501, type: 'Cancelled', datetime: futureDate, firstName: 'A', canceled: true },
            ],
          };
        }
        return { data: [] };
      };

      const bookings = await provider.getBookings('+1234', { status: 'cancelled' });
      assert.equal(bookings.length, 1);
      assert.equal(bookings[0].bookingId, '501');
      assert.equal(bookings[0].status, 'cancelled');
    });

    it('handles strategy 1 failure gracefully', async () => {
      let calls = 0;
      provider.client.get = async () => {
        calls++;
        if (calls === 1) throw new Error('Email lookup failed');
        return {
          data: [
            { id: 600, type: 'Haircut', datetime: '2099-06-15T10:00:00Z', phone: '+1234', firstName: 'A' },
          ],
        };
      };

      const bookings = await provider.getBookings('+1234');
      assert.equal(bookings.length, 1);
      assert.equal(bookings[0].bookingId, '600');
    });

    it('handles strategy 2 failure gracefully', async () => {
      let calls = 0;
      provider.client.get = async () => {
        calls++;
        if (calls === 1) {
          return {
            data: [
              { id: 700, type: 'Haircut', datetime: '2099-06-15T10:00:00Z', firstName: 'A' },
            ],
          };
        }
        throw new Error('Phone lookup failed');
      };

      const bookings = await provider.getBookings('+1234');
      assert.equal(bookings.length, 1);
      assert.equal(bookings[0].bookingId, '700');
    });

    it('handles both strategies failing', async () => {
      provider.client.get = async () => { throw new Error('All failed'); };

      const bookings = await provider.getBookings('+1234');
      assert.deepEqual(bookings, []);
    });

    it('normalizes attendeeName from firstName + lastName', async () => {
      provider.client.get = async (url, opts) => {
        if (opts.params.email) {
          return {
            data: [
              { id: 800, type: 'Test', datetime: '2099-06-15T10:00:00Z', firstName: 'John', lastName: 'Doe' },
              { id: 801, type: 'Test', datetime: '2099-06-16T10:00:00Z', firstName: 'Jane' },
            ],
          };
        }
        return { data: [] };
      };

      const bookings = await provider.getBookings('+1234');
      assert.equal(bookings[0].attendeeName, 'John Doe');
      assert.equal(bookings[1].attendeeName, 'Jane');
    });
  });
});
