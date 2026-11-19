const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../../../src/config');
config.dbPath = ':memory:';

const SquareProvider = require('../../../src/services/scheduling/providers/square');

// ---------------------------------------------------------------------------
// Helper: create a provider with a mocked axios client
// ---------------------------------------------------------------------------
function createProvider(overrides = {}) {
  const provider = new SquareProvider({
    api_key: 'test-square-key',
    location_id: 'LOC_123',
    timezone: 'Asia/Jerusalem',
    ...overrides,
  });
  // Replace the axios client with a mock
  const mockClient = {
    get: mock.fn(),
    post: mock.fn(),
  };
  provider.client = mockClient;
  return { provider, mockClient };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------
describe('SquareProvider constructor', () => {
  it('sets apiKey, locationId, and timezone from config', () => {
    const provider = new SquareProvider({
      api_key: 'sk-123',
      location_id: 'LOC_ABC',
      timezone: 'US/Eastern',
    });
    assert.equal(provider.apiKey, 'sk-123');
    assert.equal(provider.locationId, 'LOC_ABC');
    assert.equal(provider.timezone, 'US/Eastern');
  });

  it('defaults timezone to Asia/Jerusalem', () => {
    const provider = new SquareProvider({
      api_key: 'sk-123',
      location_id: 'LOC_ABC',
    });
    assert.equal(provider.timezone, 'Asia/Jerusalem');
  });
});

// ---------------------------------------------------------------------------
// getServices
// ---------------------------------------------------------------------------
describe('SquareProvider.getServices', () => {
  it('returns mapped services from catalog search', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.post.mock.mockImplementation(async () => ({
      data: {
        objects: [
          {
            id: 'ITEM_1',
            item_data: {
              name: 'Haircut',
              product_type: 'APPOINTMENTS_SERVICE',
              description: 'Basic haircut',
              variations: [{
                id: 'VAR_1',
                item_variation_data: { service_duration: 1800000 },
              }],
            },
          },
          {
            id: 'ITEM_2',
            item_data: {
              name: 'Coloring',
              product_type: 'APPOINTMENTS_SERVICE',
              description: null,
              variations: [{
                id: 'VAR_2',
                item_variation_data: { service_duration: 3600000 },
              }],
            },
          },
        ],
      },
    }));

    const services = await provider.getServices();
    assert.equal(services.length, 2);
    assert.equal(services[0].id, 'ITEM_1');
    assert.equal(services[0].name, 'Haircut');
    assert.equal(services[0].duration, 30);
    assert.equal(services[0].description, 'Basic haircut');
    assert.equal(services[1].id, 'ITEM_2');
    assert.equal(services[1].duration, 60);
    assert.equal(services[1].description, null);
  });

  it('filters out non-APPOINTMENTS_SERVICE items', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.post.mock.mockImplementation(async () => ({
      data: {
        objects: [
          {
            id: 'ITEM_1',
            item_data: {
              name: 'Haircut',
              product_type: 'APPOINTMENTS_SERVICE',
              variations: [{ id: 'VAR_1', item_variation_data: { service_duration: 1800000 } }],
            },
          },
          {
            id: 'ITEM_RETAIL',
            item_data: {
              name: 'Shampoo Bottle',
              product_type: 'REGULAR',
              variations: [{ id: 'VAR_R', item_variation_data: {} }],
            },
          },
        ],
      },
    }));

    const services = await provider.getServices();
    assert.equal(services.length, 1);
    assert.equal(services[0].name, 'Haircut');
  });

  it('handles null duration when no variation exists', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.post.mock.mockImplementation(async () => ({
      data: {
        objects: [{
          id: 'ITEM_1',
          item_data: {
            name: 'Quick Service',
            product_type: 'APPOINTMENTS_SERVICE',
            variations: [],
          },
        }],
      },
    }));

    const services = await provider.getServices();
    assert.equal(services.length, 1);
    assert.equal(services[0].duration, null);
  });

  it('handles empty objects array', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.post.mock.mockImplementation(async () => ({
      data: { objects: null },
    }));

    const services = await provider.getServices();
    assert.deepEqual(services, []);
  });

  it('caches variation IDs during getServices', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.post.mock.mockImplementation(async () => ({
      data: {
        objects: [{
          id: 'ITEM_1',
          item_data: {
            name: 'Haircut',
            product_type: 'APPOINTMENTS_SERVICE',
            variations: [{ id: 'VAR_1', item_variation_data: { service_duration: 1800000 } }],
          },
        }],
      },
    }));

    await provider.getServices();
    assert.equal(provider._variationMap.get('ITEM_1'), 'VAR_1');
  });

  it('throws on API error', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.post.mock.mockImplementation(async () => {
      const err = new Error('Network error');
      err.response = { status: 500, data: { errors: [{ detail: 'Internal error' }] } };
      throw err;
    });

    await assert.rejects(
      () => provider.getServices(),
      { message: 'Failed to fetch services: 500: Internal error' },
    );
  });
});

// ---------------------------------------------------------------------------
// _getServiceVariationId
// ---------------------------------------------------------------------------
describe('SquareProvider._getServiceVariationId', () => {
  it('returns cached variation ID', async () => {
    const { provider, mockClient } = createProvider();
    provider._variationMap.set('ITEM_1', 'VAR_1');

    const result = await provider._getServiceVariationId('ITEM_1');
    assert.equal(result, 'VAR_1');
    assert.equal(mockClient.get.mock.callCount(), 0);
  });

  it('fetches from API when not cached', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.get.mock.mockImplementation(async () => ({
      data: {
        object: {
          id: 'ITEM_1',
          item_data: {
            variations: [{ id: 'VAR_FETCHED' }],
          },
        },
      },
    }));

    const result = await provider._getServiceVariationId('ITEM_1');
    assert.equal(result, 'VAR_FETCHED');
    assert.equal(mockClient.get.mock.callCount(), 1);
    // Should now be cached
    assert.equal(provider._variationMap.get('ITEM_1'), 'VAR_FETCHED');
  });

  it('throws when no variation found', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.get.mock.mockImplementation(async () => ({
      data: {
        object: {
          id: 'ITEM_1',
          item_data: { variations: [] },
        },
      },
    }));

    await assert.rejects(
      () => provider._getServiceVariationId('ITEM_1'),
      { message: 'No variation found for service ITEM_1' },
    );
  });
});

// ---------------------------------------------------------------------------
// getAvailableSlots
// ---------------------------------------------------------------------------
describe('SquareProvider.getAvailableSlots', () => {
  it('returns mapped slots', async () => {
    const { provider, mockClient } = createProvider();
    provider._variationMap.set('ITEM_1', 'VAR_1');

    mockClient.post.mock.mockImplementation(async () => ({
      data: {
        availabilities: [
          { start_at: '2099-01-01T10:00:00Z' },
          { start_at: '2099-01-01T11:00:00Z' },
        ],
      },
    }));

    const slots = await provider.getAvailableSlots('2099-01-01', 'ITEM_1');
    assert.equal(slots.length, 2);
    assert.equal(slots[0].start, '2099-01-01T10:00:00Z');
    assert.equal(slots[0].end, null);
    assert.equal(slots[0].serviceVariationId, 'VAR_1');
    assert.equal(slots[0].locationId, 'LOC_123');
    assert.equal(slots[0].date, '2099-01-01');
  });

  it('throws when no service_id provided', async () => {
    const { provider } = createProvider();
    await assert.rejects(
      () => provider.getAvailableSlots('2099-01-01', null),
      { message: 'No service_id provided. Call get_services first.' },
    );
  });

  it('handles empty availabilities', async () => {
    const { provider, mockClient } = createProvider();
    provider._variationMap.set('ITEM_1', 'VAR_1');

    mockClient.post.mock.mockImplementation(async () => ({
      data: { availabilities: [] },
    }));

    const slots = await provider.getAvailableSlots('2099-01-01', 'ITEM_1');
    assert.deepEqual(slots, []);
  });

  it('handles missing availabilities key', async () => {
    const { provider, mockClient } = createProvider();
    provider._variationMap.set('ITEM_1', 'VAR_1');

    mockClient.post.mock.mockImplementation(async () => ({
      data: {},
    }));

    const slots = await provider.getAvailableSlots('2099-01-01', 'ITEM_1');
    assert.deepEqual(slots, []);
  });
});

// ---------------------------------------------------------------------------
// _getOrCreateCustomer
// ---------------------------------------------------------------------------
describe('SquareProvider._getOrCreateCustomer', () => {
  it('returns existing customer ID when found', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.post.mock.mockImplementation(async (url) => {
      if (url === '/customers/search') {
        return { data: { customers: [{ id: 'CUST_EXISTING' }] } };
      }
      throw new Error('Unexpected call');
    });

    const customerId = await provider._getOrCreateCustomer({
      name: 'Alice Smith',
      phone: '+1234567890',
    });
    assert.equal(customerId, 'CUST_EXISTING');
  });

  it('creates new customer when not found', async () => {
    const { provider, mockClient } = createProvider();
    let createBody;
    mockClient.post.mock.mockImplementation(async (url, body) => {
      if (url === '/customers/search') {
        return { data: { customers: [] } };
      }
      if (url === '/customers') {
        createBody = body;
        return { data: { customer: { id: 'CUST_NEW' } } };
      }
      throw new Error('Unexpected call');
    });

    const customerId = await provider._getOrCreateCustomer({
      name: 'Alice Smith',
      phone: '+1234567890',
    });
    assert.equal(customerId, 'CUST_NEW');
    assert.equal(createBody.given_name, 'Alice');
    assert.equal(createBody.family_name, 'Smith');
    assert.equal(createBody.email_address, '+1234567890@placeholder.whatsapp');
    assert.equal(createBody.phone_number, '+1234567890');
  });

  it('creates customer when search fails', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.post.mock.mockImplementation(async (url) => {
      if (url === '/customers/search') {
        throw new Error('Search API error');
      }
      if (url === '/customers') {
        return { data: { customer: { id: 'CUST_FALLBACK' } } };
      }
      throw new Error('Unexpected call');
    });

    const customerId = await provider._getOrCreateCustomer({
      name: 'Bob',
      phone: '+9999',
    });
    assert.equal(customerId, 'CUST_FALLBACK');
  });

  it('handles single-word name', async () => {
    const { provider, mockClient } = createProvider();
    let createBody;
    mockClient.post.mock.mockImplementation(async (url, body) => {
      if (url === '/customers/search') {
        return { data: { customers: [] } };
      }
      if (url === '/customers') {
        createBody = body;
        return { data: { customer: { id: 'CUST_SINGLE' } } };
      }
      throw new Error('Unexpected call');
    });

    await provider._getOrCreateCustomer({ name: 'Madonna', phone: '+111' });
    assert.equal(createBody.given_name, 'Madonna');
    assert.equal(createBody.family_name, '');
  });

  it('uses placeholder email when no email provided', async () => {
    const { provider, mockClient } = createProvider();
    let searchBody;
    mockClient.post.mock.mockImplementation(async (url, body) => {
      if (url === '/customers/search') {
        searchBody = body;
        return { data: { customers: [{ id: 'CUST_1' }] } };
      }
      throw new Error('Unexpected call');
    });

    await provider._getOrCreateCustomer({ phone: '+5551234' });
    assert.equal(searchBody.query.filter.email_address.exact, '+5551234@placeholder.whatsapp');
  });
});

// ---------------------------------------------------------------------------
// bookAppointment
// ---------------------------------------------------------------------------
describe('SquareProvider.bookAppointment', () => {
  it('creates customer then books appointment', async () => {
    const { provider, mockClient } = createProvider();
    const calls = [];
    mockClient.post.mock.mockImplementation(async (url, body) => {
      calls.push({ url, body });
      if (url === '/customers/search') {
        return { data: { customers: [{ id: 'CUST_1' }] } };
      }
      if (url === '/bookings') {
        return {
          data: {
            booking: {
              id: 'BK_100',
              status: 'ACCEPTED',
              start_at: '2099-01-01T10:00:00Z',
            },
          },
        };
      }
      throw new Error('Unexpected call');
    });

    const slot = { start: '2099-01-01T10:00:00Z', serviceVariationId: 'VAR_1' };
    const result = await provider.bookAppointment(slot, {
      name: 'Alice',
      phone: '+123',
    });

    assert.equal(result.bookingId, 'BK_100');
    assert.equal(result.status, 'ACCEPTED');
    assert.equal(result.start, '2099-01-01T10:00:00Z');
    assert.equal(result.end, null);
    assert.equal(result.meetingUrl, null);

    // Verify booking request included correct data
    const bookingCall = calls.find((c) => c.url === '/bookings');
    assert.equal(bookingCall.body.booking.customer_id, 'CUST_1');
    assert.equal(bookingCall.body.booking.location_id, 'LOC_123');
    assert.equal(bookingCall.body.booking.appointment_segments[0].service_variation_id, 'VAR_1');
  });

  it('throws on booking API error', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.post.mock.mockImplementation(async (url) => {
      if (url === '/customers/search') {
        return { data: { customers: [{ id: 'CUST_1' }] } };
      }
      if (url === '/bookings') {
        const err = new Error('API error');
        err.response = { status: 422, data: { errors: [{ detail: 'Time slot unavailable' }] } };
        throw err;
      }
      throw new Error('Unexpected call');
    });

    await assert.rejects(
      () => provider.bookAppointment(
        { start: '2099-01-01T10:00:00Z', serviceVariationId: 'VAR_1' },
        { name: 'Alice', phone: '+123' },
      ),
      { message: 'Failed to book appointment: 422: Time slot unavailable' },
    );
  });
});

// ---------------------------------------------------------------------------
// cancelAppointment
// ---------------------------------------------------------------------------
describe('SquareProvider.cancelAppointment', () => {
  it('fetches booking version then cancels', async () => {
    const { provider, mockClient } = createProvider();
    const calls = [];

    mockClient.get.mock.mockImplementation(async (url) => {
      calls.push({ method: 'get', url });
      return { data: { booking: { id: 'BK_100', version: 3 } } };
    });

    mockClient.post.mock.mockImplementation(async (url, body) => {
      calls.push({ method: 'post', url, body });
      return { data: {} };
    });

    const result = await provider.cancelAppointment('BK_100');
    assert.deepEqual(result, { success: true, bookingId: 'BK_100' });

    // Verify version was passed
    const cancelCall = calls.find((c) => c.method === 'post');
    assert.equal(cancelCall.body.booking_version, 3);
  });

  it('throws on cancel API error', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.get.mock.mockImplementation(async () => ({
      data: { booking: { id: 'BK_100', version: 1 } },
    }));
    mockClient.post.mock.mockImplementation(async () => {
      const err = new Error('API error');
      err.response = { status: 404, data: { errors: [{ detail: 'Booking not found' }] } };
      throw err;
    });

    await assert.rejects(
      () => provider.cancelAppointment('BK_100'),
      { message: 'Failed to cancel appointment: 404: Booking not found' },
    );
  });
});

// ---------------------------------------------------------------------------
// getBookings
// ---------------------------------------------------------------------------
describe('SquareProvider.getBookings', () => {
  it('returns bookings from both strategies deduped', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.post.mock.mockImplementation(async (url, body) => {
      if (url === '/customers/search') {
        if (body.query.filter.email_address) {
          return { data: { customers: [{ id: 'CUST_EMAIL' }] } };
        }
        if (body.query.filter.phone_number) {
          return { data: { customers: [{ id: 'CUST_PHONE' }] } };
        }
      }
      throw new Error('Unexpected post');
    });

    const futureDate = new Date(Date.now() + 86400000).toISOString();
    mockClient.get.mock.mockImplementation(async (url, opts) => {
      if (opts?.params?.customer_id === 'CUST_EMAIL') {
        return {
          data: {
            bookings: [
              { id: 'BK_1', start_at: futureDate, status: 'ACCEPTED', customer_id: 'CUST_EMAIL' },
              { id: 'BK_SHARED', start_at: futureDate, status: 'ACCEPTED', customer_id: 'CUST_EMAIL' },
            ],
          },
        };
      }
      if (opts?.params?.customer_id === 'CUST_PHONE') {
        return {
          data: {
            bookings: [
              { id: 'BK_SHARED', start_at: futureDate, status: 'ACCEPTED', customer_id: 'CUST_PHONE' },
              { id: 'BK_2', start_at: futureDate, status: 'ACCEPTED', customer_id: 'CUST_PHONE' },
            ],
          },
        };
      }
      return { data: { bookings: [] } };
    });

    const bookings = await provider.getBookings('+1234567890');
    // BK_SHARED should be deduped
    assert.equal(bookings.length, 3);
    const ids = bookings.map((b) => b.bookingId);
    assert.ok(ids.includes('BK_1'));
    assert.ok(ids.includes('BK_SHARED'));
    assert.ok(ids.includes('BK_2'));
  });

  it('filters cancelled bookings for upcoming status', async () => {
    const { provider, mockClient } = createProvider();
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    mockClient.post.mock.mockImplementation(async () => ({
      data: { customers: [{ id: 'CUST_1' }] },
    }));
    mockClient.get.mock.mockImplementation(async () => ({
      data: {
        bookings: [
          { id: 'BK_ACTIVE', start_at: futureDate, status: 'ACCEPTED', customer_id: 'CUST_1' },
          { id: 'BK_CANCELLED', start_at: futureDate, status: 'CANCELLED_BY_CUSTOMER', customer_id: 'CUST_1' },
        ],
      },
    }));

    const bookings = await provider.getBookings('+123', { status: 'upcoming' });
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].bookingId, 'BK_ACTIVE');
  });

  it('returns only cancelled bookings for cancelled status', async () => {
    const { provider, mockClient } = createProvider();
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    mockClient.post.mock.mockImplementation(async () => ({
      data: { customers: [{ id: 'CUST_1' }] },
    }));
    mockClient.get.mock.mockImplementation(async () => ({
      data: {
        bookings: [
          { id: 'BK_ACTIVE', start_at: pastDate, status: 'ACCEPTED', customer_id: 'CUST_1' },
          { id: 'BK_CANCELLED', start_at: pastDate, status: 'CANCELLED_BY_SELLER', customer_id: 'CUST_1' },
        ],
      },
    }));

    const bookings = await provider.getBookings('+123', { status: 'cancelled' });
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].bookingId, 'BK_CANCELLED');
  });

  it('does not pass start_at_min for cancelled status', async () => {
    const { provider, mockClient } = createProvider();
    const getCalls = [];
    mockClient.post.mock.mockImplementation(async () => ({
      data: { customers: [{ id: 'CUST_1' }] },
    }));
    mockClient.get.mock.mockImplementation(async (url, opts) => {
      getCalls.push(opts);
      return { data: { bookings: [] } };
    });

    await provider.getBookings('+123', { status: 'cancelled' });
    for (const call of getCalls) {
      assert.equal(call.params.start_at_min, undefined);
    }
  });

  it('passes start_at_min only for upcoming status', async () => {
    const { provider, mockClient } = createProvider();
    const getCalls = [];
    mockClient.post.mock.mockImplementation(async () => ({
      data: { customers: [{ id: 'CUST_1' }] },
    }));
    mockClient.get.mock.mockImplementation(async (url, opts) => {
      getCalls.push(opts);
      return { data: { bookings: [] } };
    });

    await provider.getBookings('+123', { status: 'upcoming' });
    for (const call of getCalls) {
      assert.ok(call.params.start_at_min, 'start_at_min should be set for upcoming');
    }
  });

  it('handles email lookup failure gracefully', async () => {
    const { provider, mockClient } = createProvider();
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    let callCount = 0;
    mockClient.post.mock.mockImplementation(async (url, body) => {
      callCount++;
      if (callCount === 1) {
        // First search (email) fails
        throw new Error('Email search failed');
      }
      // Second search (phone) succeeds
      return { data: { customers: [{ id: 'CUST_PHONE' }] } };
    });

    mockClient.get.mock.mockImplementation(async () => ({
      data: {
        bookings: [
          { id: 'BK_1', start_at: futureDate, status: 'ACCEPTED', customer_id: 'CUST_PHONE' },
        ],
      },
    }));

    const bookings = await provider.getBookings('+123');
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].bookingId, 'BK_1');
  });

  it('returns empty array when no customers found', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.post.mock.mockImplementation(async () => ({
      data: { customers: [] },
    }));

    const bookings = await provider.getBookings('+123');
    assert.deepEqual(bookings, []);
  });

  it('normalizes booking fields', async () => {
    const { provider, mockClient } = createProvider();
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    mockClient.post.mock.mockImplementation(async () => ({
      data: { customers: [{ id: 'CUST_1' }] },
    }));
    mockClient.get.mock.mockImplementation(async () => ({
      data: {
        bookings: [
          { id: 'BK_1', start_at: futureDate, status: 'ACCEPTED', customer_id: 'CUST_1' },
        ],
      },
    }));

    const bookings = await provider.getBookings('+123');
    assert.equal(bookings[0].title, 'Appointment');
    assert.equal(bookings[0].start, futureDate);
    assert.equal(bookings[0].end, null);
    assert.equal(bookings[0].status, 'ACCEPTED');
    assert.equal(bookings[0].attendeeName, 'CUST_1');
  });
});

// ---------------------------------------------------------------------------
// extractSquareError
// ---------------------------------------------------------------------------
describe('Square error extraction', () => {
  it('extracts error detail from Square error response', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.post.mock.mockImplementation(async () => {
      const err = new Error('Request failed');
      err.response = {
        status: 400,
        data: {
          errors: [{ category: 'INVALID_REQUEST_ERROR', detail: 'Missing required field' }],
        },
      };
      throw err;
    });

    await assert.rejects(
      () => provider.getServices(),
      (err) => {
        assert.ok(err.message.includes('400: Missing required field'));
        return true;
      },
    );
  });

  it('falls back to err.message when no response data', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.post.mock.mockImplementation(async () => {
      throw new Error('Network timeout');
    });

    await assert.rejects(
      () => provider.getServices(),
      { message: 'Failed to fetch services: Network timeout' },
    );
  });
});

// ---------------------------------------------------------------------------
// Duration conversion
// ---------------------------------------------------------------------------
describe('Square service duration conversion', () => {
  it('converts milliseconds to minutes correctly', async () => {
    const { provider, mockClient } = createProvider();
    mockClient.post.mock.mockImplementation(async () => ({
      data: {
        objects: [
          {
            id: 'ITEM_15MIN',
            item_data: {
              name: '15 Min Service',
              product_type: 'APPOINTMENTS_SERVICE',
              variations: [{ id: 'V1', item_variation_data: { service_duration: 900000 } }],
            },
          },
          {
            id: 'ITEM_90MIN',
            item_data: {
              name: '90 Min Service',
              product_type: 'APPOINTMENTS_SERVICE',
              variations: [{ id: 'V2', item_variation_data: { service_duration: 5400000 } }],
            },
          },
        ],
      },
    }));

    const services = await provider.getServices();
    assert.equal(services[0].duration, 15);
    assert.equal(services[1].duration, 90);
  });
});
