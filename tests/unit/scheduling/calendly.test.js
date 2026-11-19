const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../../../src/config');
config.dbPath = ':memory:';

const CalendlyProvider = require('../../../src/services/scheduling/providers/calendly');

// ---------------------------------------------------------------------------
// Helper: create a provider with mocked axios
// ---------------------------------------------------------------------------
function createProvider(overrides = {}) {
  const provider = new CalendlyProvider({
    api_key: 'test-calendly-key',
    timezone: 'Asia/Jerusalem',
    ...overrides,
  });
  return provider;
}

function mockClient(provider, mocks) {
  provider.client = {
    get: mocks.get || (async () => { throw new Error('unmocked GET'); }),
    post: mocks.post || (async () => { throw new Error('unmocked POST'); }),
  };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------
describe('CalendlyProvider constructor', () => {
  it('sets apiKey and timezone from config', () => {
    const provider = createProvider({ api_key: 'my-key', timezone: 'US/Eastern' });
    assert.equal(provider.apiKey, 'my-key');
    assert.equal(provider.timezone, 'US/Eastern');
  });

  it('defaults timezone to Asia/Jerusalem', () => {
    const provider = new CalendlyProvider({ api_key: 'key' });
    assert.equal(provider.timezone, 'Asia/Jerusalem');
  });

  it('sets Authorization header on client', () => {
    const provider = createProvider({ api_key: 'bearer-test' });
    assert.equal(provider.client.defaults.headers.Authorization, 'Bearer bearer-test');
  });
});

// ---------------------------------------------------------------------------
// _getUserUri
// ---------------------------------------------------------------------------
describe('_getUserUri', () => {
  it('fetches and returns user URI', async () => {
    const provider = createProvider();
    mockClient(provider, {
      get: async (url) => {
        assert.equal(url, '/users/me');
        return { data: { resource: { uri: 'https://api.calendly.com/users/AAAA' } } };
      },
    });

    const uri = await provider._getUserUri();
    assert.equal(uri, 'https://api.calendly.com/users/AAAA');
  });

  it('caches the user URI after first call', async () => {
    const provider = createProvider();
    let callCount = 0;
    mockClient(provider, {
      get: async () => {
        callCount++;
        return { data: { resource: { uri: 'https://api.calendly.com/users/BBBB' } } };
      },
    });

    await provider._getUserUri();
    await provider._getUserUri();
    await provider._getUserUri();
    assert.equal(callCount, 1);
  });
});

// ---------------------------------------------------------------------------
// getServices
// ---------------------------------------------------------------------------
describe('getServices', () => {
  it('returns mapped services from Calendly event types', async () => {
    const provider = createProvider();
    provider._userUri = 'https://api.calendly.com/users/U1';
    mockClient(provider, {
      get: async (url, opts) => {
        assert.equal(url, '/event_types');
        assert.equal(opts.params.user, 'https://api.calendly.com/users/U1');
        assert.equal(opts.params.active, true);
        return {
          data: {
            collection: [
              {
                uri: 'https://api.calendly.com/event_types/ET1',
                name: 'Consultation',
                duration: 30,
                description_plain: 'A 30-min consult',
                description_html: '<p>A 30-min consult</p>',
              },
              {
                uri: 'https://api.calendly.com/event_types/ET2',
                name: 'Follow-up',
                duration: 15,
                description_plain: null,
                description_html: '<p>Follow-up call</p>',
              },
              {
                uri: 'https://api.calendly.com/event_types/ET3',
                name: 'Demo',
                duration: 60,
                description_plain: null,
                description_html: null,
              },
            ],
          },
        };
      },
    });

    const services = await provider.getServices();
    assert.equal(services.length, 3);
    assert.equal(services[0].id, 'https://api.calendly.com/event_types/ET1');
    assert.equal(services[0].name, 'Consultation');
    assert.equal(services[0].duration, 30);
    assert.equal(services[0].description, 'A 30-min consult');
    // Falls back to description_html when description_plain is null
    assert.equal(services[1].description, '<p>Follow-up call</p>');
    // null when both are null
    assert.equal(services[2].description, null);
  });

  it('calls _getUserUri before fetching event types', async () => {
    const provider = createProvider();
    let getUserUriCalled = false;
    mockClient(provider, {
      get: async (url) => {
        if (url === '/users/me') {
          getUserUriCalled = true;
          return { data: { resource: { uri: 'https://api.calendly.com/users/U1' } } };
        }
        return { data: { collection: [] } };
      },
    });

    await provider.getServices();
    assert.ok(getUserUriCalled);
  });

  it('throws on API error', async () => {
    const provider = createProvider();
    provider._userUri = 'https://api.calendly.com/users/U1';
    mockClient(provider, {
      get: async () => {
        const err = new Error('Request failed');
        err.response = { status: 401, data: { message: 'Unauthorized' } };
        throw err;
      },
    });

    await assert.rejects(() => provider.getServices(), {
      message: 'Failed to fetch services: 401: Unauthorized',
    });
  });
});

// ---------------------------------------------------------------------------
// getAvailableSlots
// ---------------------------------------------------------------------------
describe('getAvailableSlots', () => {
  it('returns mapped slots for a date', async () => {
    const provider = createProvider();
    const serviceId = 'https://api.calendly.com/event_types/ET1';
    mockClient(provider, {
      get: async (url, opts) => {
        assert.equal(url, '/event_type_available_times');
        assert.equal(opts.params.event_type, serviceId);
        assert.equal(opts.params.start_time, '2099-03-15T00:00:00Z');
        assert.equal(opts.params.end_time, '2099-03-16T00:00:00Z');
        return {
          data: {
            collection: [
              { start_time: '2099-03-15T09:00:00Z', status: 'available' },
              { start_time: '2099-03-15T10:00:00Z', status: 'available' },
              { start_time: '2099-03-15T14:30:00Z', status: 'available' },
            ],
          },
        };
      },
    });

    const slots = await provider.getAvailableSlots('2099-03-15', serviceId);
    assert.equal(slots.length, 3);
    assert.equal(slots[0].start, '2099-03-15T09:00:00Z');
    assert.equal(slots[0].end, null);
    assert.equal(slots[0].eventTypeUri, serviceId);
    assert.equal(slots[0].date, '2099-03-15');
    assert.equal(slots[2].start, '2099-03-15T14:30:00Z');
  });

  it('returns empty array when no slots available', async () => {
    const provider = createProvider();
    mockClient(provider, {
      get: async () => ({ data: { collection: [] } }),
    });

    const slots = await provider.getAvailableSlots('2099-03-15', 'https://api.calendly.com/event_types/ET1');
    assert.deepEqual(slots, []);
  });

  it('throws when no serviceId is provided', async () => {
    const provider = createProvider();

    await assert.rejects(
      () => provider.getAvailableSlots('2099-03-15', null),
      { message: /No event type URI provided/ },
    );
  });

  it('throws on API error', async () => {
    const provider = createProvider();
    mockClient(provider, {
      get: async () => {
        const err = new Error('Request failed');
        err.response = { status: 400, data: { title: 'Invalid event type' } };
        throw err;
      },
    });

    await assert.rejects(
      () => provider.getAvailableSlots('2099-03-15', 'https://api.calendly.com/event_types/ET1'),
      { message: 'Failed to fetch availability: 400: Invalid event type' },
    );
  });
});

// ---------------------------------------------------------------------------
// bookAppointment
// ---------------------------------------------------------------------------
describe('bookAppointment', () => {
  it('creates a booking and returns normalized result', async () => {
    const provider = createProvider();
    const slot = {
      start: '2099-03-15T10:00:00Z',
      eventTypeUri: 'https://api.calendly.com/event_types/ET1',
    };
    mockClient(provider, {
      post: async (url, body) => {
        assert.equal(url, '/scheduled_events');
        assert.equal(body.event_type_uri, slot.eventTypeUri);
        assert.equal(body.start_time, slot.start);
        assert.equal(body.invitee.name, 'Alice');
        assert.equal(body.invitee.email, '+972501234567@placeholder.whatsapp');
        assert.equal(body.invitee.timezone, 'Asia/Jerusalem');
        assert.equal(body.location.kind, 'custom');
        return {
          data: {
            resource: {
              uri: 'https://api.calendly.com/scheduled_events/EVT-UUID-123',
              start_time: '2099-03-15T10:00:00Z',
              end_time: '2099-03-15T10:30:00Z',
              status: 'active',
              location: { join_url: 'https://meet.example.com/abc' },
            },
          },
        };
      },
    });

    const result = await provider.bookAppointment(slot, {
      name: 'Alice',
      phone: '+972501234567',
    });

    assert.equal(result.bookingId, 'EVT-UUID-123');
    assert.equal(result.status, 'active');
    assert.equal(result.start, '2099-03-15T10:00:00Z');
    assert.equal(result.end, '2099-03-15T10:30:00Z');
    assert.equal(result.meetingUrl, 'https://meet.example.com/abc');
  });

  it('uses default customer name and email when not provided', async () => {
    const provider = createProvider();
    let capturedBody;
    mockClient(provider, {
      post: async (url, body) => {
        capturedBody = body;
        return {
          data: {
            resource: {
              uri: 'https://api.calendly.com/scheduled_events/EVT-2',
              start_time: '2099-03-15T10:00:00Z',
              end_time: '2099-03-15T10:30:00Z',
              status: 'active',
            },
          },
        };
      },
    });

    await provider.bookAppointment(
      { start: '2099-03-15T10:00:00Z', eventTypeUri: 'https://api.calendly.com/event_types/ET1' },
      {},
    );

    assert.equal(capturedBody.invitee.name, 'Customer');
    assert.equal(capturedBody.invitee.email, 'unknown@placeholder.whatsapp');
  });

  it('throws when no eventTypeUri in slot', async () => {
    const provider = createProvider();
    await assert.rejects(
      () => provider.bookAppointment({ start: '2099-03-15T10:00:00Z' }, { name: 'Bob' }),
      { message: /No event type URI for booking/ },
    );
  });

  it('extracts UUID from event URI as bookingId', async () => {
    const provider = createProvider();
    mockClient(provider, {
      post: async () => ({
        data: {
          resource: {
            uri: 'https://api.calendly.com/scheduled_events/abc-def-ghi-123',
            start_time: '2099-03-15T10:00:00Z',
            end_time: '2099-03-15T10:30:00Z',
          },
        },
      }),
    });

    const result = await provider.bookAppointment(
      { start: '2099-03-15T10:00:00Z', eventTypeUri: 'https://api.calendly.com/event_types/ET1' },
      { name: 'Test' },
    );

    assert.equal(result.bookingId, 'abc-def-ghi-123');
  });

  it('throws on API error', async () => {
    const provider = createProvider();
    mockClient(provider, {
      post: async () => {
        const err = new Error('Request failed');
        err.response = { status: 422, data: { message: 'Time slot unavailable' } };
        throw err;
      },
    });

    await assert.rejects(
      () => provider.bookAppointment(
        { start: '2099-03-15T10:00:00Z', eventTypeUri: 'https://api.calendly.com/event_types/ET1' },
        { name: 'Test' },
      ),
      { message: 'Failed to book appointment: 422: Time slot unavailable' },
    );
  });
});

// ---------------------------------------------------------------------------
// cancelAppointment
// ---------------------------------------------------------------------------
describe('cancelAppointment', () => {
  it('cancels a booking by UUID', async () => {
    const provider = createProvider();
    let capturedUrl, capturedBody;
    mockClient(provider, {
      post: async (url, body) => {
        capturedUrl = url;
        capturedBody = body;
        return { data: {} };
      },
    });

    const result = await provider.cancelAppointment('EVT-UUID-123');
    assert.equal(result.success, true);
    assert.equal(result.bookingId, 'EVT-UUID-123');
    assert.equal(capturedUrl, '/scheduled_events/EVT-UUID-123/cancellation');
    assert.equal(capturedBody.reason, 'Cancelled via WhatsApp');
  });

  it('handles full URI bookingId by extracting UUID', async () => {
    const provider = createProvider();
    let capturedUrl;
    mockClient(provider, {
      post: async (url) => {
        capturedUrl = url;
        return { data: {} };
      },
    });

    const result = await provider.cancelAppointment('https://api.calendly.com/scheduled_events/EVT-FULL-URI');
    assert.equal(result.success, true);
    assert.equal(capturedUrl, '/scheduled_events/EVT-FULL-URI/cancellation');
  });

  it('throws on API error', async () => {
    const provider = createProvider();
    mockClient(provider, {
      post: async () => {
        const err = new Error('Request failed');
        err.response = { status: 404, data: { message: 'Event not found' } };
        throw err;
      },
    });

    await assert.rejects(
      () => provider.cancelAppointment('nonexistent-id'),
      { message: 'Failed to cancel appointment: 404: Event not found' },
    );
  });
});

// ---------------------------------------------------------------------------
// getBookings
// ---------------------------------------------------------------------------
describe('getBookings', () => {
  it('returns normalized bookings for upcoming status', async () => {
    const provider = createProvider();
    provider._userUri = 'https://api.calendly.com/users/U1';
    mockClient(provider, {
      get: async (url, opts) => {
        assert.equal(url, '/scheduled_events');
        assert.equal(opts.params.user, 'https://api.calendly.com/users/U1');
        assert.equal(opts.params.status, 'active');
        assert.ok(opts.params.min_start_time);
        assert.equal(opts.params.invitee_email, '+972501234567@placeholder.whatsapp');
        return {
          data: {
            collection: [
              {
                uri: 'https://api.calendly.com/scheduled_events/EVT-1',
                name: 'Consultation',
                start_time: '2099-03-15T10:00:00Z',
                end_time: '2099-03-15T10:30:00Z',
                status: 'active',
              },
              {
                uri: 'https://api.calendly.com/scheduled_events/EVT-2',
                name: 'Follow-up',
                start_time: '2099-03-16T14:00:00Z',
                end_time: '2099-03-16T14:30:00Z',
                status: 'active',
              },
            ],
          },
        };
      },
    });

    const bookings = await provider.getBookings('+972501234567');
    assert.equal(bookings.length, 2);
    assert.equal(bookings[0].bookingId, 'EVT-1');
    assert.equal(bookings[0].title, 'Consultation');
    assert.equal(bookings[0].start, '2099-03-15T10:00:00Z');
    assert.equal(bookings[0].end, '2099-03-15T10:30:00Z');
    assert.equal(bookings[0].status, 'active');
    assert.equal(bookings[0].attendeeName, null);
    assert.equal(bookings[1].bookingId, 'EVT-2');
  });

  it('uses cancelled status params', async () => {
    const provider = createProvider();
    provider._userUri = 'https://api.calendly.com/users/U1';
    let capturedParams;
    mockClient(provider, {
      get: async (url, opts) => {
        capturedParams = opts.params;
        return { data: { collection: [] } };
      },
    });

    await provider.getBookings('+972501234567', { status: 'cancelled' });
    assert.equal(capturedParams.status, 'canceled');
    assert.equal(capturedParams.min_start_time, undefined);
    assert.equal(capturedParams.max_start_time, undefined);
  });

  it('uses past status params', async () => {
    const provider = createProvider();
    provider._userUri = 'https://api.calendly.com/users/U1';
    let capturedParams;
    mockClient(provider, {
      get: async (url, opts) => {
        capturedParams = opts.params;
        return { data: { collection: [] } };
      },
    });

    await provider.getBookings('+972501234567', { status: 'past' });
    assert.equal(capturedParams.status, 'active');
    assert.ok(capturedParams.max_start_time);
    assert.equal(capturedParams.min_start_time, undefined);
  });

  it('defaults to upcoming status', async () => {
    const provider = createProvider();
    provider._userUri = 'https://api.calendly.com/users/U1';
    let capturedParams;
    mockClient(provider, {
      get: async (url, opts) => {
        capturedParams = opts.params;
        return { data: { collection: [] } };
      },
    });

    await provider.getBookings('+972501234567');
    assert.equal(capturedParams.status, 'active');
    assert.ok(capturedParams.min_start_time);
  });

  it('returns empty array when no bookings found', async () => {
    const provider = createProvider();
    provider._userUri = 'https://api.calendly.com/users/U1';
    mockClient(provider, {
      get: async () => ({ data: { collection: [] } }),
    });

    const bookings = await provider.getBookings('+972501234567');
    assert.deepEqual(bookings, []);
  });

  it('handles email lookup failure gracefully', async () => {
    const provider = createProvider();
    provider._userUri = 'https://api.calendly.com/users/U1';
    mockClient(provider, {
      get: async () => {
        throw new Error('Network error');
      },
    });

    const bookings = await provider.getBookings('+972501234567');
    assert.deepEqual(bookings, []);
  });
});

// ---------------------------------------------------------------------------
// extractCalendlyError
// ---------------------------------------------------------------------------
describe('error extraction', () => {
  it('extracts message from response data', async () => {
    const provider = createProvider();
    provider._userUri = 'https://api.calendly.com/users/U1';
    mockClient(provider, {
      get: async () => {
        const err = new Error('Request failed');
        err.response = { status: 403, data: { message: 'Forbidden access' } };
        throw err;
      },
    });

    await assert.rejects(() => provider.getServices(), {
      message: 'Failed to fetch services: 403: Forbidden access',
    });
  });

  it('extracts title from response data as fallback', async () => {
    const provider = createProvider();
    provider._userUri = 'https://api.calendly.com/users/U1';
    mockClient(provider, {
      get: async () => {
        const err = new Error('Request failed');
        err.response = { status: 500, data: { title: 'Internal Server Error' } };
        throw err;
      },
    });

    await assert.rejects(() => provider.getServices(), {
      message: 'Failed to fetch services: 500: Internal Server Error',
    });
  });

  it('falls back to err.message when no response data', async () => {
    const provider = createProvider();
    provider._userUri = 'https://api.calendly.com/users/U1';
    mockClient(provider, {
      get: async () => { throw new Error('ECONNREFUSED'); },
    });

    await assert.rejects(() => provider.getServices(), {
      message: 'Failed to fetch services: ECONNREFUSED',
    });
  });
});
