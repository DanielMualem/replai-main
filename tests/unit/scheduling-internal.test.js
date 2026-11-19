const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBusiness, cleanDb, db } = require('../helpers/setup');

const InternalProvider = require('../../src/services/scheduling/providers/internal');

function makeConfig(overrides = {}) {
  return {
    provider: 'internal',
    timezone: 'Asia/Jerusalem',
    services: [
      { id: 'haircut', name: 'Haircut', duration: 30 },
      { id: 'color', name: 'Hair Coloring', duration: 90 },
    ],
    working_hours: {
      sunday: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }],
      monday: [{ start: '09:00', end: '18:00' }],
      tuesday: [{ start: '09:00', end: '18:00' }],
      wednesday: [{ start: '09:00', end: '18:00' }],
      thursday: [{ start: '09:00', end: '18:00' }],
      friday: [{ start: '09:00', end: '14:00' }],
      saturday: [],
    },
    slot_interval: 30,
    buffer_minutes: 0,
    blocked_dates: ['2026-03-17'],
    ...overrides,
  };
}

function createProvider(businessId, configOverrides = {}) {
  const config = makeConfig(configOverrides);
  config.business_id = businessId;
  return new InternalProvider(config);
}

function formatLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Find a future weekday date (monday) in YYYY-MM-DD format
function getFutureMonday() {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); // next Monday
  return formatLocalDate(d);
}

// Find a future Friday
function getFutureFriday() {
  const d = new Date();
  d.setDate(d.getDate() + ((12 - d.getDay()) % 7 || 7)); // next Friday
  return formatLocalDate(d);
}

// Find a future Saturday
function getFutureSaturday() {
  const d = new Date();
  d.setDate(d.getDate() + ((13 - d.getDay()) % 7 || 7)); // next Saturday
  return formatLocalDate(d);
}

// Find a future Sunday
function getFutureSunday() {
  const d = new Date();
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7)); // next Sunday
  return formatLocalDate(d);
}

describe('InternalProvider', () => {
  let business;
  let provider;

  beforeEach(() => {
    cleanDb();
    business = createTestBusiness({ scheduling_config: JSON.stringify(makeConfig()) });
    provider = createProvider(business.id);
  });

  describe('getServices', () => {
    it('returns services from config in standard format', async () => {
      const services = await provider.getServices();
      assert.equal(services.length, 2);
      assert.deepStrictEqual(services[0], { id: 'haircut', name: 'Haircut', duration: 30, description: null });
      assert.deepStrictEqual(services[1], { id: 'color', name: 'Hair Coloring', duration: 90, description: null });
    });

    it('returns empty array when no services configured', async () => {
      const p = createProvider(business.id, { services: [] });
      const services = await p.getServices();
      assert.deepStrictEqual(services, []);
    });
  });

  describe('getAvailableSlots', () => {
    it('returns slots for a normal working day (Monday)', async () => {
      const date = getFutureMonday();
      const slots = await provider.getAvailableSlots(date, 'haircut');
      // Monday 09:00-18:00, 30min slots for 30min service = 18 slots
      assert.equal(slots.length, 18);
      assert.ok(slots[0].start.startsWith(date));
      assert.ok(slots[0].start.includes('T09:00'));
      assert.ok(slots[0].end.includes('T09:30'));
    });

    it('returns empty for closed day (Saturday)', async () => {
      const date = getFutureSaturday();
      const slots = await provider.getAvailableSlots(date, 'haircut');
      assert.equal(slots.length, 0);
    });

    it('returns empty for blocked date', async () => {
      const slots = await provider.getAvailableSlots('2026-03-17', 'haircut');
      assert.equal(slots.length, 0);
    });

    it('handles split shifts (Sunday with lunch break)', async () => {
      const date = getFutureSunday();
      const slots = await provider.getAvailableSlots(date, 'haircut');
      // Sunday: 09:00-13:00 (8 slots) + 14:00-18:00 (8 slots) = 16 slots
      assert.equal(slots.length, 16);

      // Verify no slots during lunch (13:00-14:00)
      const times = slots.map(s => s.start.split('T')[1].slice(0, 5));
      assert.ok(!times.includes('13:00'));
      assert.ok(!times.includes('13:30'));
    });

    it('filters out slots that overlap existing appointments', async () => {
      const date = getFutureMonday();

      // Book 10:00-10:30
      db.createAppointment({
        business_id: business.id,
        customer_phone: '1234567890',
        customer_name: 'Test',
        service_id: 'haircut',
        service_name: 'Haircut',
        service_duration: 30,
        start_time: `${date}T10:00:00`,
        end_time: `${date}T10:30:00`,
      });

      const slots = await provider.getAvailableSlots(date, 'haircut');
      const times = slots.map(s => s.start.split('T')[1].slice(0, 5));
      assert.ok(!times.includes('10:00'), '10:00 should not be available');
      assert.ok(times.includes('09:30'), '09:30 should still be available');
      assert.ok(times.includes('10:30'), '10:30 should still be available');
    });

    it('respects buffer between appointments', async () => {
      const date = getFutureMonday();
      const p = createProvider(business.id, { buffer_minutes: 10 });

      // Book 10:00-10:30 with 10min post-appointment buffer
      // Effective blocked range: 10:00-10:40
      // → 10:00 blocked (appointment), 10:30 blocked (starts within buffer), 09:30 free (ends at 10:00, before appt)
      db.createAppointment({
        business_id: business.id,
        customer_phone: '1234567890',
        customer_name: 'Test',
        service_id: 'haircut',
        service_name: 'Haircut',
        service_duration: 30,
        start_time: `${date}T10:00:00`,
        end_time: `${date}T10:30:00`,
      });

      const slots = await p.getAvailableSlots(date, 'haircut');
      const times = slots.map(s => s.start.split('T')[1].slice(0, 5));
      assert.ok(!times.includes('10:00'), '10:00 should be blocked (appointment)');
      assert.ok(!times.includes('10:30'), '10:30 should be blocked (buffer)');
      assert.ok(times.includes('09:00'), '09:00 should be available');
      assert.ok(times.includes('09:30'), '09:30 should be available (ends exactly at appt start)');
      assert.ok(times.includes('11:00'), '11:00 should be available');
    });

    it('handles service duration longer than slot interval', async () => {
      const date = getFutureMonday();
      // Hair Coloring is 90 minutes with 30-min slot interval
      const slots = await provider.getAvailableSlots(date, 'color');
      // Monday 09:00-18:00, need 90min window, starting every 30min
      // Last possible: 16:30 (16:30 + 90 = 18:00)
      assert.ok(slots.length > 0);
      assert.ok(slots.length < 18, 'Fewer slots than 30-min service');

      // Verify each slot has 90-min duration
      for (const slot of slots) {
        const startMin = parseInt(slot.start.split('T')[1].split(':')[0]) * 60 +
          parseInt(slot.start.split('T')[1].split(':')[1]);
        const endMin = parseInt(slot.end.split('T')[1].split(':')[0]) * 60 +
          parseInt(slot.end.split('T')[1].split(':')[1]);
        assert.equal(endMin - startMin, 90);
      }
    });

    it('returns fewer slots on short day (Friday)', async () => {
      const date = getFutureFriday();
      const slots = await provider.getAvailableSlots(date, 'haircut');
      // Friday 09:00-14:00 = 10 slots
      assert.equal(slots.length, 10);
    });

    it('returns no slots when day has no working hours config', async () => {
      const p = createProvider(business.id, { working_hours: {} });
      const date = getFutureMonday();
      const slots = await p.getAvailableSlots(date, 'haircut');
      assert.equal(slots.length, 0);
    });

    it('returns no slots when all slots are taken', async () => {
      const date = getFutureFriday();
      // Friday: 09:00-14:00, 30-min haircut = 10 slots (09:00 through 13:30)
      for (let t = 9 * 60; t + 30 <= 14 * 60; t += 30) {
        const startH = Math.floor(t / 60);
        const startM = t % 60;
        const endT = t + 30;
        const endH = Math.floor(endT / 60);
        const endM = endT % 60;
        db.createAppointment({
          business_id: business.id,
          customer_phone: '1234567890',
          customer_name: 'Test',
          service_id: 'haircut',
          service_name: 'Haircut',
          service_duration: 30,
          start_time: `${date}T${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}:00`,
          end_time: `${date}T${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`,
        });
      }

      const slots = await provider.getAvailableSlots(date, 'haircut');
      assert.equal(slots.length, 0);
    });
  });

  describe('bookAppointment', () => {
    it('books an appointment successfully', async () => {
      const date = getFutureMonday();
      const slot = { start: `${date}T10:00:00`, end: `${date}T10:30:00`, serviceName: 'Haircut' };
      const result = await provider.bookAppointment(slot, { name: 'John', phone: '1234567890' });

      assert.ok(result.bookingId);
      assert.equal(result.status, 'confirmed');
      assert.ok(result.start.includes('T10:00'));
      assert.ok(result.end.includes('T10:30'));

      // Verify it's in the DB
      const appt = db.getAppointment(result.bookingId);
      assert.ok(appt);
      assert.equal(appt.customer_name, 'John');
      assert.equal(appt.customer_phone, '1234567890');
      assert.equal(appt.service_name, 'Haircut');
    });

    it('prevents double-booking (race condition guard)', async () => {
      const date = getFutureMonday();
      const slot = { start: `${date}T10:00:00`, end: `${date}T10:30:00`, serviceName: 'Haircut' };

      // Book the slot first
      await provider.bookAppointment(slot, { name: 'John', phone: '1234567890' });

      // Try to book the same slot
      await assert.rejects(
        () => provider.bookAppointment(slot, { name: 'Jane', phone: '0987654321' }),
        { message: /no longer available/i }
      );
    });

    it('stores correct service info', async () => {
      const date = getFutureMonday();
      const slot = { start: `${date}T10:00:00`, end: `${date}T11:30:00`, serviceName: 'Hair Coloring' };
      const result = await provider.bookAppointment(slot, { name: 'Jane', phone: '5555555555' });

      const appt = db.getAppointment(result.bookingId);
      assert.equal(appt.service_id, 'color');
      assert.equal(appt.service_name, 'Hair Coloring');
      assert.equal(appt.service_duration, 90);
    });
  });

  describe('cancelAppointment', () => {
    it('cancels an existing appointment', async () => {
      const date = getFutureMonday();
      const slot = { start: `${date}T10:00:00`, end: `${date}T10:30:00`, serviceName: 'Haircut' };
      const booking = await provider.bookAppointment(slot, { name: 'John', phone: '1234567890' });

      const result = await provider.cancelAppointment(booking.bookingId);
      assert.equal(result.success, true);
      assert.equal(result.bookingId, booking.bookingId);

      const appt = db.getAppointment(booking.bookingId);
      assert.equal(appt.status, 'cancelled');
    });

    it('throws for non-existent appointment', async () => {
      await assert.rejects(
        () => provider.cancelAppointment('nonexistent-id'),
        { message: /not found/i }
      );
    });

    it('throws for already cancelled appointment', async () => {
      const date = getFutureMonday();
      const slot = { start: `${date}T10:00:00`, end: `${date}T10:30:00`, serviceName: 'Haircut' };
      const booking = await provider.bookAppointment(slot, { name: 'John', phone: '1234567890' });

      await provider.cancelAppointment(booking.bookingId);
      await assert.rejects(
        () => provider.cancelAppointment(booking.bookingId),
        { message: /already cancelled/i }
      );
    });

    it('frees the slot after cancellation', async () => {
      const date = getFutureMonday();
      const slot = { start: `${date}T10:00:00`, end: `${date}T10:30:00`, serviceName: 'Haircut' };
      const booking = await provider.bookAppointment(slot, { name: 'John', phone: '1234567890' });

      // Verify slot is taken
      let slots = await provider.getAvailableSlots(date, 'haircut');
      let times = slots.map(s => s.start.split('T')[1].slice(0, 5));
      assert.ok(!times.includes('10:00'));

      // Cancel
      await provider.cancelAppointment(booking.bookingId);

      // Verify slot is free again
      slots = await provider.getAvailableSlots(date, 'haircut');
      times = slots.map(s => s.start.split('T')[1].slice(0, 5));
      assert.ok(times.includes('10:00'));
    });
  });

  describe('getBookings', () => {
    it('returns upcoming appointments', async () => {
      const date = getFutureMonday();
      const slot = { start: `${date}T10:00:00`, end: `${date}T10:30:00`, serviceName: 'Haircut' };
      await provider.bookAppointment(slot, { name: 'John', phone: '1234567890' });

      const bookings = await provider.getBookings('1234567890', { status: 'upcoming' });
      assert.equal(bookings.length, 1);
      assert.equal(bookings[0].title, 'Haircut');
      assert.equal(bookings[0].status, 'confirmed');
      assert.equal(bookings[0].attendeeName, 'John');
    });

    it('returns cancelled appointments', async () => {
      const date = getFutureMonday();
      const slot = { start: `${date}T10:00:00`, end: `${date}T10:30:00`, serviceName: 'Haircut' };
      const booking = await provider.bookAppointment(slot, { name: 'John', phone: '1234567890' });
      await provider.cancelAppointment(booking.bookingId);

      const bookings = await provider.getBookings('1234567890', { status: 'cancelled' });
      assert.equal(bookings.length, 1);
      assert.equal(bookings[0].status, 'cancelled');
    });

    it('does not return cancelled in upcoming', async () => {
      const date = getFutureMonday();
      const slot = { start: `${date}T10:00:00`, end: `${date}T10:30:00`, serviceName: 'Haircut' };
      const booking = await provider.bookAppointment(slot, { name: 'John', phone: '1234567890' });
      await provider.cancelAppointment(booking.bookingId);

      const bookings = await provider.getBookings('1234567890', { status: 'upcoming' });
      assert.equal(bookings.length, 0);
    });

    it('returns empty for different customer', async () => {
      const date = getFutureMonday();
      const slot = { start: `${date}T10:00:00`, end: `${date}T10:30:00`, serviceName: 'Haircut' };
      await provider.bookAppointment(slot, { name: 'John', phone: '1234567890' });

      const bookings = await provider.getBookings('0000000000', { status: 'upcoming' });
      assert.equal(bookings.length, 0);
    });
  });

  describe('DB functions', () => {
    it('getAppointmentsByDate returns confirmed only', () => {
      const date = getFutureMonday();
      db.createAppointment({
        business_id: business.id,
        customer_phone: '111',
        customer_name: 'A',
        service_id: 'haircut',
        service_name: 'Haircut',
        service_duration: 30,
        start_time: `${date}T09:00:00`,
        end_time: `${date}T09:30:00`,
      });
      const cancelled = db.createAppointment({
        business_id: business.id,
        customer_phone: '222',
        customer_name: 'B',
        service_id: 'haircut',
        service_name: 'Haircut',
        service_duration: 30,
        start_time: `${date}T10:00:00`,
        end_time: `${date}T10:30:00`,
      });
      db.updateAppointmentStatus(cancelled.id, 'cancelled');

      const results = db.getAppointmentsByDate(business.id, date);
      assert.equal(results.length, 1);
      assert.equal(results[0].customer_phone, '111');
    });

    it('listAppointments with status filter', () => {
      const date = getFutureMonday();
      db.createAppointment({
        business_id: business.id,
        customer_phone: '111',
        customer_name: 'A',
        service_id: 'haircut',
        service_name: 'Haircut',
        service_duration: 30,
        start_time: `${date}T09:00:00`,
        end_time: `${date}T09:30:00`,
      });
      const appt = db.createAppointment({
        business_id: business.id,
        customer_phone: '222',
        customer_name: 'B',
        service_id: 'haircut',
        service_name: 'Haircut',
        service_duration: 30,
        start_time: `${date}T10:00:00`,
        end_time: `${date}T10:30:00`,
      });
      db.updateAppointmentStatus(appt.id, 'cancelled');

      const confirmed = db.listAppointments(business.id, { status: 'confirmed' });
      assert.equal(confirmed.length, 1);

      const all = db.listAppointments(business.id);
      assert.equal(all.length, 2);
    });
  });
});
