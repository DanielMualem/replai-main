const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../../../src/config');
config.dbPath = ':memory:';

const { getSchedulingTools, buildSchedulingSystemPrompt, executeSchedulingFunction, invalidateServicesCache, normalizeTimeToHHMM, formatSlotTime, isTimezoneAware } = require('../../../src/services/scheduling/tools');
const db = require('../../../src/services/db');
const slotCache = require('../../../src/services/scheduling/slot-cache');

// ---------------------------------------------------------------------------
// getSchedulingTools
// ---------------------------------------------------------------------------
describe('getSchedulingTools', () => {
  it('returns tools array for valid scheduling_config', () => {
    const business = {
      id: 'biz-1',
      scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'test' }),
    };
    const tools = getSchedulingTools(business);
    assert.ok(Array.isArray(tools));
    assert.equal(tools.length, 1);
    assert.ok(tools[0].functionDeclarations);
    assert.equal(tools[0].functionDeclarations.length, 5);
    const names = tools[0].functionDeclarations.map((d) => d.name);
    assert.ok(names.includes('get_services'));
    assert.ok(names.includes('check_availability'));
    assert.ok(names.includes('book_appointment'));
    assert.ok(names.includes('cancel_appointment'));
    assert.ok(names.includes('get_my_appointments'));
  });

  it('returns undefined when scheduling_config is null', () => {
    assert.equal(getSchedulingTools({ id: 'biz-1', scheduling_config: null }), undefined);
  });

  it('returns undefined when scheduling_config is undefined', () => {
    assert.equal(getSchedulingTools({ id: 'biz-1' }), undefined);
  });

  it('returns undefined when scheduling_config is invalid JSON', () => {
    assert.equal(getSchedulingTools({ id: 'biz-1', scheduling_config: '{bad json' }), undefined);
  });

  it('returns undefined when scheduling_config has no provider field', () => {
    assert.equal(getSchedulingTools({
      id: 'biz-1',
      scheduling_config: JSON.stringify({ api_key: 'test' }),
    }), undefined);
  });

  it('handles scheduling_config as object (not string)', () => {
    const business = {
      id: 'biz-1',
      scheduling_config: { provider: 'cal-com', api_key: 'test' },
    };
    const tools = getSchedulingTools(business);
    assert.ok(Array.isArray(tools));
    assert.equal(tools[0].functionDeclarations.length, 5);
  });
});

// ---------------------------------------------------------------------------
// buildSchedulingSystemPrompt
// ---------------------------------------------------------------------------
describe('buildSchedulingSystemPrompt', () => {
  it('returns prompt string for valid scheduling_config', () => {
    const business = {
      id: 'biz-1',
      scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'test' }),
    };
    const prompt = buildSchedulingSystemPrompt(business);
    assert.ok(prompt);
    assert.ok(prompt.includes('scheduling tools'));
    assert.ok(prompt.includes('get_services'));
  });

  it('returns null when scheduling_config is null', () => {
    assert.equal(buildSchedulingSystemPrompt({ id: 'biz-1', scheduling_config: null }), null);
  });

  it('returns null when scheduling_config is invalid JSON', () => {
    assert.equal(buildSchedulingSystemPrompt({ id: 'biz-1', scheduling_config: '{bad' }), null);
  });

  it('returns null when scheduling_config has no provider', () => {
    assert.equal(buildSchedulingSystemPrompt({
      id: 'biz-1',
      scheduling_config: JSON.stringify({ api_key: 'test' }),
    }), null);
  });

  it('handles scheduling_config as object', () => {
    const prompt = buildSchedulingSystemPrompt({
      id: 'biz-1',
      scheduling_config: { provider: 'cal-com' },
    });
    assert.ok(prompt);
  });

  it('includes CRITICAL BOOKING RULE in prompt', () => {
    const prompt = buildSchedulingSystemPrompt({
      id: 'biz-1',
      scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'test' }),
    });
    assert.ok(prompt.includes('CRITICAL BOOKING RULE'));
    assert.ok(prompt.includes('appointment DOES NOT EXIST'));
  });

  it('includes CUSTOMER NAME RULE in prompt', () => {
    const prompt = buildSchedulingSystemPrompt({
      id: 'biz-1',
      scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'test' }),
    });
    assert.ok(prompt.includes('CUSTOMER NAME RULE'));
    assert.ok(prompt.includes('NEVER guess, invent, or make up a name'));
  });

  it('includes get_my_appointments guidance in prompt', () => {
    const prompt = buildSchedulingSystemPrompt({
      id: 'biz-1',
      scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'test' }),
    });
    assert.ok(prompt.includes('get_my_appointments'));
  });
});

// ---------------------------------------------------------------------------
// executeSchedulingFunction
// ---------------------------------------------------------------------------
describe('executeSchedulingFunction', () => {
  const BUSINESS = {
    id: 'exec-biz',
    scheduling_config: JSON.stringify({
      provider: 'cal-com',
      api_key: 'fake-key',
      event_type_id: '42',
      timezone: 'Asia/Jerusalem',
    }),
  };

  beforeEach(() => {
    mock.restoreAll();
    invalidateServicesCache();
    db.db.exec('DELETE FROM customer_memory');
    db.db.exec('DELETE FROM businesses');
    slotCache.clearSlots('exec-biz:+1234567890');
    db.createBusiness({ id: 'exec-biz', name: 'Exec Biz', scheduling_config: BUSINESS.scheduling_config });
  });

  it('get_services returns structured services', async () => {
    const provider = {
      getServices: async () => [
        { id: '1', name: 'Haircut', duration: 30, description: 'Basic haircut' },
        { id: '2', name: 'Coloring', duration: 60, description: null },
      ],
    };

    const result = await executeSchedulingFunction(
      { name: 'get_services', args: {} },
      provider, BUSINESS, '+1234567890',
    );

    assert.ok(result.services);
    assert.equal(result.services.length, 2);
    assert.equal(result.services[0].name, 'Haircut');
  });

  it('check_availability returns available slots with short IDs', async () => {
    const provider = {
      getServices: async () => [{ id: '42', name: 'Haircut', duration: 30, description: null }],
      getAvailableSlots: async () => [
        { start: '2099-01-01T10:00:00Z', end: '2099-01-01T10:30:00Z' },
        { start: '2099-01-01T11:00:00Z', end: '2099-01-01T11:30:00Z' },
      ],
    };

    const result = await executeSchedulingFunction(
      { name: 'check_availability', args: { date: '2099-01-01', service_id: '42' } },
      provider, BUSINESS, '+1234567890',
    );

    assert.equal(result.date, '2099-01-01');
    assert.equal(result.available_slots.length, 2);
    assert.equal(result.available_slots[0].slot_id, 's1');
    assert.equal(result.available_slots[1].slot_id, 's2');
    assert.ok(result.available_slots[0].formatted_start);
  });

  it('check_availability returns empty array when no slots', async () => {
    const provider = {
      getServices: async () => [{ id: '42', name: 'Haircut', duration: 30, description: null }],
      getAvailableSlots: async () => [],
    };

    const result = await executeSchedulingFunction(
      { name: 'check_availability', args: { date: '2099-01-01', service_id: '42' } },
      provider, BUSINESS, '+1234567890',
    );

    assert.equal(result.date, '2099-01-01');
    assert.equal(result.available_slots.length, 0);
  });

  it('check_availability without service_id returns services list', async () => {
    const provider = {
      getServices: async () => [
        { id: '1', name: 'Haircut', duration: 30, description: null },
        { id: '2', name: 'Coloring', duration: 60, description: null },
      ],
    };

    const result = await executeSchedulingFunction(
      { name: 'check_availability', args: { date: '2099-01-01' } },
      provider, BUSINESS, '+1234567890',
    );

    assert.ok(result.error);
    assert.equal(result.services.length, 2);
  });

  it('check_availability with invalid service_id returns services list', async () => {
    const provider = {
      getServices: async () => [
        { id: '1', name: 'Haircut', duration: 30, description: null },
      ],
    };

    const result = await executeSchedulingFunction(
      { name: 'check_availability', args: { date: '2099-01-01', service_id: 'nonexistent' } },
      provider, BUSINESS, '+1234567890',
    );

    assert.ok(result.error);
    assert.ok(result.error.includes('Unknown service_id'));
    assert.equal(result.services.length, 1);
  });

  it('book_appointment succeeds and saves to DB', async () => {
    slotCache.cacheSlots('exec-biz:+1234567890', [
      { start: '2099-01-01T10:00:00Z', end: '2099-01-01T10:30:00Z', eventTypeId: '42' },
    ]);

    const provider = {
      bookAppointment: async () => ({
        bookingId: 'cal-booking-99',
        status: 'confirmed',
        start: '2099-01-01T10:00:00Z',
        end: '2099-01-01T10:30:00Z',
      }),
    };

    const result = await executeSchedulingFunction(
      { name: 'book_appointment', args: { slot_id: 's1', customer_name: 'Alice Smith' } },
      provider, BUSINESS, '+1234567890',
    );

    assert.equal(result.success, true);
    assert.equal(result.booking_id, undefined);
    assert.equal(result.customer_name, 'Alice Smith');
  });

  it('book_appointment returns error for expired/missing slot', async () => {
    const provider = {};

    const result = await executeSchedulingFunction(
      { name: 'book_appointment', args: { slot_id: 's1', customer_name: 'Bob' } },
      provider, BUSINESS, '+1234567890',
    );

    assert.ok(result.error);
    assert.ok(result.error.includes('Could not resolve slot'));
  });

  it('book_appointment resolves slot via date+time+service_id fallback', async () => {
    // Use a business with UTC timezone so test times match directly
    const utcBusiness = {
      ...BUSINESS,
      scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'fake-key', event_type_id: '42', timezone: 'UTC' }),
    };
    const provider = {
      getServices: async () => [{ id: '42', name: 'Haircut', duration: 30, description: null }],
      getAvailableSlots: async () => [
        { start: '2099-01-01T10:00:00Z', end: '2099-01-01T10:30:00Z', eventTypeId: '42' },
        { start: '2099-01-01T11:00:00Z', end: '2099-01-01T11:30:00Z', eventTypeId: '42' },
      ],
      bookAppointment: async () => ({
        bookingId: 'cal-fallback-1',
        status: 'confirmed',
        start: '2099-01-01T11:00:00Z',
        end: '2099-01-01T11:30:00Z',
      }),
    };

    const result = await executeSchedulingFunction(
      { name: 'book_appointment', args: { customer_name: 'Eve', date: '2099-01-01', time: '11:00', service_id: '42' } },
      provider, utcBusiness, '+1234567890',
    );

    assert.equal(result.success, true);
    assert.equal(result.customer_name, 'Eve');
  });

  it('book_appointment fallback handles non-zero-padded time', async () => {
    const utcBusiness = {
      ...BUSINESS,
      scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'fake-key', event_type_id: '7', timezone: 'UTC' }),
    };
    const provider = {
      getServices: async () => [{ id: '7', name: 'Consult', duration: 15, description: null }],
      getAvailableSlots: async () => [
        { start: '2099-01-01T09:00:00Z', end: '2099-01-01T09:15:00Z', eventTypeId: '7' },
      ],
      bookAppointment: async () => ({
        bookingId: 'cal-pad-1',
        status: 'confirmed',
        start: '2099-01-01T09:00:00Z',
        end: '2099-01-01T09:15:00Z',
      }),
    };

    const result = await executeSchedulingFunction(
      { name: 'book_appointment', args: { customer_name: 'Dan', date: '2099-01-01', time: '9:00', service_id: '7' } },
      provider, utcBusiness, '+1234567890',
    );

    assert.equal(result.success, true);
    assert.equal(result.customer_name, 'Dan');
  });

  it('book_appointment fallback returns error for invalid service_id', async () => {
    const provider = {
      getServices: async () => [{ id: '42', name: 'Haircut', duration: 30, description: null }],
    };

    const result = await executeSchedulingFunction(
      { name: 'book_appointment', args: { customer_name: 'Bob', date: '2099-01-01', time: '10:00', service_id: 'bad-id' } },
      provider, BUSINESS, '+1234567890',
    );

    assert.ok(result.error);
    assert.ok(result.error.includes('Unknown service_id'));
    assert.ok(result.services);
  });

  it('book_appointment fallback returns error when time slot unavailable', async () => {
    const provider = {
      getServices: async () => [{ id: '42', name: 'Haircut', duration: 30, description: null }],
      getAvailableSlots: async () => [
        { start: '2099-01-01T10:00:00Z', end: '2099-01-01T10:30:00Z', eventTypeId: '42' },
      ],
    };

    const result = await executeSchedulingFunction(
      { name: 'book_appointment', args: { customer_name: 'Bob', date: '2099-01-01', time: '15:00', service_id: '42' } },
      provider, BUSINESS, '+1234567890',
    );

    assert.ok(result.error);
    assert.ok(result.error.includes('No available slot'));
  });

  it('cancel_appointment succeeds via provider', async () => {
    let cancelledId;
    const provider = {
      cancelAppointment: async (id) => { cancelledId = id; return { success: true }; },
    };

    const result = await executeSchedulingFunction(
      { name: 'cancel_appointment', args: { booking_id: 'bk-to-cancel' } },
      provider, BUSINESS, '+1234567890',
    );

    assert.equal(result.success, true);
    assert.equal(result.booking_id, 'bk-to-cancel');
    assert.equal(cancelledId, 'bk-to-cancel');
  });

  it('propagates provider errors', async () => {
    const provider = {
      getServices: async () => { throw new Error('API timeout'); },
    };

    await assert.rejects(
      () => executeSchedulingFunction(
        { name: 'get_services', args: {} },
        provider, BUSINESS, '+1234567890',
      ),
      { message: 'API timeout' },
    );
  });

  it('get_my_appointments returns bookings from provider', async () => {
    const provider = {
      getBookings: async () => [
        { bookingId: 'bk-1', title: 'Consultation', start: '2099-06-15T10:00:00Z', end: '2099-06-15T10:30:00Z', status: 'confirmed', attendeeName: 'Alice' },
        { bookingId: 'bk-2', title: 'Follow-up', start: '2099-06-16T14:00:00Z', end: '2099-06-16T14:30:00Z', status: 'confirmed', attendeeName: 'Alice' },
      ],
    };

    const result = await executeSchedulingFunction(
      { name: 'get_my_appointments', args: {} },
      provider, BUSINESS, '+1234567890',
    );

    assert.ok(result.appointments);
    assert.equal(result.appointments.length, 2);
    assert.equal(result.appointments[0].booking_id, 'bk-1');
    assert.equal(result.appointments[0].service, 'Consultation');
    assert.ok(result.appointments[0].formatted_start);
    assert.equal(result.appointments[0].status, 'confirmed');
  });

  it('get_my_appointments returns empty result with message when no bookings', async () => {
    const provider = {
      getBookings: async () => [],
    };

    const result = await executeSchedulingFunction(
      { name: 'get_my_appointments', args: {} },
      provider, BUSINESS, '+1234567890',
    );

    assert.deepEqual(result.appointments, []);
    assert.ok(result.message);
    assert.ok(result.message.includes('No appointments'));
  });

  it('get_my_appointments passes status filter to provider', async () => {
    let receivedOptions;
    const provider = {
      getBookings: async (phone, opts) => {
        receivedOptions = opts;
        return [];
      },
    };

    await executeSchedulingFunction(
      { name: 'get_my_appointments', args: { status: 'past' } },
      provider, BUSINESS, '+1234567890',
    );

    assert.equal(receivedOptions.status, 'past');
  });

  it('get_my_appointments defaults status to upcoming', async () => {
    let receivedOptions;
    const provider = {
      getBookings: async (phone, opts) => {
        receivedOptions = opts;
        return [];
      },
    };

    await executeSchedulingFunction(
      { name: 'get_my_appointments', args: {} },
      provider, BUSINESS, '+1234567890',
    );

    assert.equal(receivedOptions.status, 'upcoming');
  });

  it('returns error for unknown function name', async () => {
    const result = await executeSchedulingFunction(
      { name: 'unknown_function', args: {} },
      {}, BUSINESS, '+1234567890',
    );

    assert.ok(result.error);
    assert.ok(result.error.includes('Unknown scheduling function'));
  });

  it('check_availability passes service_id to provider', async () => {
    let receivedServiceId;
    const provider = {
      getServices: async () => [{ id: 'svc-abc', name: 'Test', duration: 30, description: null }],
      getAvailableSlots: async (date, serviceId) => {
        receivedServiceId = serviceId;
        return [];
      },
    };

    await executeSchedulingFunction(
      { name: 'check_availability', args: { date: '2099-01-01', service_id: 'svc-abc' } },
      provider, BUSINESS, '+1234567890',
    );

    assert.equal(receivedServiceId, 'svc-abc');
  });

  // --- Item 3: Enriched booking results ---

  it('book_appointment returns enriched result with formatted times and service_name', async () => {
    slotCache.cacheSlots('exec-biz:+1234567890', [
      { start: '2099-01-01T10:00:00Z', end: '2099-01-01T10:30:00Z', eventTypeId: '42', serviceName: 'Haircut' },
    ]);

    const provider = {
      bookAppointment: async () => ({
        bookingId: 'cal-rich-1',
        status: 'confirmed',
        start: '2099-01-01T10:00:00Z',
        end: '2099-01-01T10:30:00Z',
      }),
    };

    const result = await executeSchedulingFunction(
      { name: 'book_appointment', args: { slot_id: 's1', customer_name: 'Alice' } },
      provider, BUSINESS, '+1234567890',
    );

    assert.equal(result.success, true);
    assert.equal(result.start_time, '2099-01-01T10:00:00Z');
    assert.equal(result.end_time, '2099-01-01T10:30:00Z');
    assert.ok(result.formatted_start_time);
    assert.ok(result.formatted_end_time);
    assert.equal(result.service_name, 'Haircut');
    assert.equal(result.customer_name, 'Alice');
    assert.equal(result.booking_id, undefined);
  });

  it('book_appointment fallback returns enriched result with service_name', async () => {
    const utcBusiness = {
      ...BUSINESS,
      scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'fake-key', event_type_id: '42', timezone: 'UTC' }),
    };
    const provider = {
      getServices: async () => [{ id: '42', name: 'Massage', duration: 60, description: null }],
      getAvailableSlots: async () => [
        { start: '2099-01-01T14:00:00Z', end: '2099-01-01T15:00:00Z', eventTypeId: '42' },
      ],
      bookAppointment: async () => ({
        bookingId: 'cal-rich-2',
        status: 'confirmed',
        start: '2099-01-01T14:00:00Z',
        end: '2099-01-01T15:00:00Z',
      }),
    };

    const result = await executeSchedulingFunction(
      { name: 'book_appointment', args: { customer_name: 'Bob', date: '2099-01-01', time: '14:00', service_id: '42' } },
      provider, utcBusiness, '+1234567890',
    );

    assert.equal(result.success, true);
    assert.equal(result.service_name, 'Massage');
    assert.equal(result.formatted_start_time, '14:00');
    assert.equal(result.formatted_end_time, '15:00');
  });

  it('check_availability includes service_name in slot results', async () => {
    const provider = {
      getServices: async () => [{ id: '42', name: 'Haircut', duration: 30, description: null }],
      getAvailableSlots: async () => [
        { start: '2099-01-01T10:00:00Z', end: '2099-01-01T10:30:00Z' },
      ],
    };

    const result = await executeSchedulingFunction(
      { name: 'check_availability', args: { date: '2099-01-01', service_id: '42' } },
      provider, BUSINESS, '+1234567890',
    );

    assert.equal(result.available_slots[0].service_name, 'Haircut');
  });

  // --- Item 4: Better error messages ---

  it('check_availability returns suggestion when no slots available', async () => {
    const provider = {
      getServices: async () => [{ id: '42', name: 'Haircut', duration: 30, description: null }],
      getAvailableSlots: async () => [],
    };

    const result = await executeSchedulingFunction(
      { name: 'check_availability', args: { date: '2099-01-01', service_id: '42' } },
      provider, BUSINESS, '+1234567890',
    );

    assert.equal(result.available_slots.length, 0);
    assert.ok(result.suggestion);
    assert.ok(result.suggestion.includes('next or previous day'));
  });

  it('book_appointment fallback returns available_times when slot not found', async () => {
    const utcBusiness = {
      ...BUSINESS,
      scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'fake-key', event_type_id: '42', timezone: 'UTC' }),
    };
    const provider = {
      getServices: async () => [{ id: '42', name: 'Haircut', duration: 30, description: null }],
      getAvailableSlots: async () => [
        { start: '2099-01-01T10:00:00Z', end: '2099-01-01T10:30:00Z', eventTypeId: '42' },
        { start: '2099-01-01T11:00:00Z', end: '2099-01-01T11:30:00Z', eventTypeId: '42' },
      ],
    };

    const result = await executeSchedulingFunction(
      { name: 'book_appointment', args: { customer_name: 'Bob', date: '2099-01-01', time: '15:00', service_id: '42' } },
      provider, utcBusiness, '+1234567890',
    );

    assert.ok(result.error);
    assert.ok(result.available_times);
    assert.ok(result.available_times.includes('10:00'));
    assert.ok(result.available_times.includes('11:00'));
    assert.ok(result.suggestion);
  });

  it('book_appointment fallback returns suggestion when no slots at all', async () => {
    const utcBusiness = {
      ...BUSINESS,
      scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'fake-key', event_type_id: '42', timezone: 'UTC' }),
    };
    const provider = {
      getServices: async () => [{ id: '42', name: 'Haircut', duration: 30, description: null }],
      getAvailableSlots: async () => [],
    };

    const result = await executeSchedulingFunction(
      { name: 'book_appointment', args: { customer_name: 'Bob', date: '2099-01-01', time: '15:00', service_id: '42' } },
      provider, utcBusiness, '+1234567890',
    );

    assert.ok(result.error);
    assert.ok(result.suggestion);
    assert.ok(result.suggestion.includes('next or previous day'));
    assert.equal(result.available_times, undefined);
  });

  // --- Item 5: Time normalization in fallback ---

  it('book_appointment fallback handles AM/PM format', async () => {
    const utcBusiness = {
      ...BUSINESS,
      scheduling_config: JSON.stringify({ provider: 'cal-com', api_key: 'fake-key', event_type_id: '42', timezone: 'UTC' }),
    };
    const provider = {
      getServices: async () => [{ id: '42', name: 'Haircut', duration: 30, description: null }],
      getAvailableSlots: async () => [
        { start: '2099-01-01T14:30:00Z', end: '2099-01-01T15:00:00Z', eventTypeId: '42' },
      ],
      bookAppointment: async () => ({
        bookingId: 'cal-ampm-1',
        status: 'confirmed',
        start: '2099-01-01T14:30:00Z',
        end: '2099-01-01T15:00:00Z',
      }),
    };

    const result = await executeSchedulingFunction(
      { name: 'book_appointment', args: { customer_name: 'Eve', date: '2099-01-01', time: '2:30 PM', service_id: '42' } },
      provider, utcBusiness, '+1234567890',
    );

    assert.equal(result.success, true);
    assert.equal(result.customer_name, 'Eve');
  });

  it('book_appointment fallback returns error for unparseable time', async () => {
    const provider = {
      getServices: async () => [{ id: '42', name: 'Haircut', duration: 30, description: null }],
    };

    const result = await executeSchedulingFunction(
      { name: 'book_appointment', args: { customer_name: 'Bob', date: '2099-01-01', time: 'noon', service_id: '42' } },
      provider, BUSINESS, '+1234567890',
    );

    assert.ok(result.error);
    assert.ok(result.error.includes('Could not parse time'));
    assert.ok(result.error.includes('HH:MM'));
  });
});

// ---------------------------------------------------------------------------
// normalizeTimeToHHMM
// ---------------------------------------------------------------------------
describe('normalizeTimeToHHMM', () => {
  it('normalizes HH:MM format', () => {
    assert.equal(normalizeTimeToHHMM('09:00'), '09:00');
    assert.equal(normalizeTimeToHHMM('14:30'), '14:30');
    assert.equal(normalizeTimeToHHMM('00:00'), '00:00');
    assert.equal(normalizeTimeToHHMM('23:59'), '23:59');
  });

  it('normalizes H:MM format (no leading zero)', () => {
    assert.equal(normalizeTimeToHHMM('9:00'), '09:00');
    assert.equal(normalizeTimeToHHMM('2:30'), '02:30');
  });

  it('normalizes HHMM format (no colon)', () => {
    assert.equal(normalizeTimeToHHMM('0900'), '09:00');
    assert.equal(normalizeTimeToHHMM('1430'), '14:30');
    assert.equal(normalizeTimeToHHMM('0000'), '00:00');
  });

  it('normalizes 12-hour AM/PM format', () => {
    assert.equal(normalizeTimeToHHMM('2:30 PM'), '14:30');
    assert.equal(normalizeTimeToHHMM('2:30PM'), '14:30');
    assert.equal(normalizeTimeToHHMM('12:00 PM'), '12:00');
    assert.equal(normalizeTimeToHHMM('12:00 AM'), '00:00');
    assert.equal(normalizeTimeToHHMM('9:00 AM'), '09:00');
    assert.equal(normalizeTimeToHHMM('11:30 am'), '11:30');
  });

  it('returns null for unparseable formats', () => {
    assert.equal(normalizeTimeToHHMM('noon'), null);
    assert.equal(normalizeTimeToHHMM('abc'), null);
    assert.equal(normalizeTimeToHHMM(''), null);
    assert.equal(normalizeTimeToHHMM(null), null);
    assert.equal(normalizeTimeToHHMM(undefined), null);
  });

  it('returns null for invalid times', () => {
    assert.equal(normalizeTimeToHHMM('25:00'), null);
    assert.equal(normalizeTimeToHHMM('12:60'), null);
  });

  it('handles whitespace', () => {
    assert.equal(normalizeTimeToHHMM('  09:00  '), '09:00');
    assert.equal(normalizeTimeToHHMM(' 2:30 PM '), '14:30');
  });
});

// ---------------------------------------------------------------------------
// isTimezoneAware
// ---------------------------------------------------------------------------
describe('isTimezoneAware', () => {
  it('returns true for Z suffix', () => {
    assert.equal(isTimezoneAware('2026-03-05T09:30:00Z'), true);
  });

  it('returns true for positive offset', () => {
    assert.equal(isTimezoneAware('2026-03-05T09:30:00+02:00'), true);
    assert.equal(isTimezoneAware('2026-03-05T09:30:00+0200'), true);
  });

  it('returns true for negative offset', () => {
    assert.equal(isTimezoneAware('2026-03-05T09:30:00-05:00'), true);
    assert.equal(isTimezoneAware('2026-03-05T09:30:00-0500'), true);
  });

  it('returns false for naive timestamps', () => {
    assert.equal(isTimezoneAware('2026-03-05T09:30:00'), false);
    assert.equal(isTimezoneAware('2026-03-05T18:00:00'), false);
  });

  it('returns false for plain time strings', () => {
    assert.equal(isTimezoneAware('09:30'), false);
    assert.equal(isTimezoneAware('18:00:00'), false);
  });
});

// ---------------------------------------------------------------------------
// formatSlotTime
// ---------------------------------------------------------------------------
describe('formatSlotTime', () => {
  it('extracts HH:MM directly from naive ISO timestamp', () => {
    // Must return the time as-is regardless of server timezone
    assert.equal(formatSlotTime('2026-03-05T09:30:00', 'Asia/Jerusalem'), '09:30');
    assert.equal(formatSlotTime('2026-03-05T18:00:00', 'Asia/Jerusalem'), '18:00');
    assert.equal(formatSlotTime('2026-03-05T00:00:00', 'UTC'), '00:00');
  });

  it('extracts HH:MM from plain time string', () => {
    assert.equal(formatSlotTime('09:30', 'Asia/Jerusalem'), '09:30');
    assert.equal(formatSlotTime('17:45:00', 'Asia/Jerusalem'), '17:45');
  });

  it('converts timezone-aware Z timestamps to target timezone', () => {
    // 10:00 UTC = 12:00 in Asia/Jerusalem (UTC+2, standard time in January)
    const result = formatSlotTime('2026-01-15T10:00:00Z', 'Asia/Jerusalem');
    assert.equal(result, '12:00');
  });

  it('converts timezone-aware offset timestamps to target timezone', () => {
    // 10:00+00:00 is the same as 10:00Z
    const result = formatSlotTime('2026-01-15T10:00:00+00:00', 'Asia/Jerusalem');
    assert.equal(result, '12:00');
  });

  it('returns fallback for malformed string', () => {
    const result = formatSlotTime('not-a-date', 'Asia/Jerusalem');
    assert.ok(typeof result === 'string');
  });

  it('handles UTC target timezone with Z timestamps', () => {
    assert.equal(formatSlotTime('2026-03-05T14:30:00Z', 'UTC'), '14:30');
  });
});

// ---------------------------------------------------------------------------
// Timezone-safe integration: naive timestamps through executeSchedulingFunction
// ---------------------------------------------------------------------------
describe('executeSchedulingFunction with naive timestamps (internal provider)', () => {
  const INTERNAL_BUSINESS = {
    id: 'tz-biz',
    scheduling_config: JSON.stringify({
      provider: 'internal',
      timezone: 'Asia/Jerusalem',
      services: [{ id: 'cut', name: 'Haircut', duration: 30 }],
      working_hours: { thursday: [{ start: '09:00', end: '18:00' }] },
    }),
  };

  beforeEach(() => {
    mock.restoreAll();
    invalidateServicesCache();
    slotCache.clearSlots('tz-biz:+972501111111');
    db.db.exec('DELETE FROM customer_memory');
    db.db.exec('DELETE FROM businesses');
    db.createBusiness({ id: 'tz-biz', name: 'TZ Biz', scheduling_config: INTERNAL_BUSINESS.scheduling_config });
  });

  it('check_availability formats naive slot times correctly', async () => {
    const provider = {
      getServices: async () => [{ id: 'cut', name: 'Haircut', duration: 30 }],
      getAvailableSlots: async () => [
        { start: '2026-03-05T09:30:00', end: '2026-03-05T10:00:00' },
        { start: '2026-03-05T17:30:00', end: '2026-03-05T18:00:00' },
      ],
    };

    const result = await executeSchedulingFunction(
      { name: 'check_availability', args: { date: '2026-03-05', service_id: 'cut' } },
      provider, INTERNAL_BUSINESS, '+972501111111',
    );

    // Must show 09:30 and 17:30, NOT shifted by server timezone
    assert.equal(result.available_slots[0].formatted_start, '09:30');
    assert.equal(result.available_slots[0].formatted_end, '10:00');
    assert.equal(result.available_slots[1].formatted_start, '17:30');
    assert.equal(result.available_slots[1].formatted_end, '18:00');
  });

  it('book_appointment fallback matches naive slot times correctly', async () => {
    const provider = {
      getServices: async () => [{ id: 'cut', name: 'Haircut', duration: 30 }],
      getAvailableSlots: async () => [
        { start: '2026-03-05T09:30:00', end: '2026-03-05T10:00:00' },
        { start: '2026-03-05T17:30:00', end: '2026-03-05T18:00:00' },
      ],
      bookAppointment: async (slot) => ({
        bookingId: 'int-1',
        status: 'confirmed',
        start: slot.start,
        end: slot.end,
      }),
    };

    // Request 17:30 — must match the naive "17:30:00" slot, not a shifted time
    const result = await executeSchedulingFunction(
      { name: 'book_appointment', args: { customer_name: 'Test', date: '2026-03-05', time: '17:30', service_id: 'cut' } },
      provider, INTERNAL_BUSINESS, '+972501111111',
    );

    assert.equal(result.success, true);
    assert.equal(result.formatted_start_time, '17:30');
    assert.equal(result.formatted_end_time, '18:00');
  });

  it('get_my_appointments formats naive booking times correctly', async () => {
    const provider = {
      getBookings: async () => [
        { bookingId: '1', title: 'Haircut', start: '2026-03-05T09:30:00', end: '2026-03-05T10:00:00', status: 'confirmed' },
      ],
    };

    const result = await executeSchedulingFunction(
      { name: 'get_my_appointments', args: {} },
      provider, INTERNAL_BUSINESS, '+972501111111',
    );

    assert.equal(result.appointments[0].formatted_start, '09:30');
    assert.equal(result.appointments[0].formatted_end, '10:00');
  });
});

