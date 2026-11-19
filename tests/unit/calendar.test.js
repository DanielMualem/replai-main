const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { storeBooking, getBooking, generateIcs, cache } = require('../../src/services/calendar');

describe('calendar service', () => {
  beforeEach(() => {
    cache.clear();
  });

  describe('storeBooking / getBooking', () => {
    it('stores and retrieves booking data', () => {
      const bookingResult = {
        start_time: '2026-03-15T14:00:00+02:00',
        end_time: '2026-03-15T15:00:00+02:00',
        service_name: 'Haircut',
      };
      const id = storeBooking(bookingResult, 'Dan', 'TestBiz');
      assert.ok(id);

      const data = getBooking(id);
      assert.ok(data);
      assert.equal(data.bookingResult.service_name, 'Haircut');
      assert.equal(data.label, 'Dan');
      assert.equal(data.businessName, 'TestBiz');
    });

    it('returns null for unknown ID', () => {
      assert.equal(getBooking('nonexistent-id'), null);
    });

    it('returns null and cleans up expired entries', () => {
      const id = storeBooking({ start_time: '2026-01-01T00:00:00Z' }, 'X', 'B');
      // Manually expire it
      const entry = cache.get(id);
      entry.expires = Date.now() - 1000;

      assert.equal(getBooking(id), null);
      assert.equal(cache.has(id), false);
    });
  });

  describe('generateIcs', () => {
    it('generates valid iCalendar format with correct dates', () => {
      const ics = generateIcs({
        bookingResult: {
          start_time: '2026-03-15T12:00:00Z',
          end_time: '2026-03-15T12:30:00Z',
          service_name: 'Consultation',
        },
        label: 'John',
        businessName: 'MyBiz',
      });

      assert.match(ics, /BEGIN:VCALENDAR/);
      assert.match(ics, /VERSION:2\.0/);
      assert.match(ics, /BEGIN:VEVENT/);
      assert.match(ics, /DTSTART:20260315T120000Z/);
      assert.match(ics, /DTEND:20260315T123000Z/);
      assert.match(ics, /SUMMARY:Consultation — John/);
      assert.match(ics, /DESCRIPTION:Customer: John\\nBusiness: MyBiz/);
      assert.match(ics, /UID:/);
      assert.match(ics, /DTSTAMP:/);
      assert.match(ics, /END:VEVENT/);
      assert.match(ics, /END:VCALENDAR/);
    });

    it('defaults to 1h duration when end_time is missing', () => {
      const ics = generateIcs({
        bookingResult: {
          start_time: '2026-03-15T12:00:00Z',
          service_name: 'Haircut',
        },
        label: 'Dan',
        businessName: 'Shop',
      });

      assert.match(ics, /DTSTART:20260315T120000Z/);
      assert.match(ics, /DTEND:20260315T130000Z/);
    });

    it('uses generic title when service_name is missing', () => {
      const ics = generateIcs({
        bookingResult: {
          start_time: '2026-03-15T10:00:00Z',
        },
        label: 'Alex',
        businessName: null,
      });

      assert.match(ics, /SUMMARY:Appointment — Alex/);
      // No business in description
      assert.ok(!ics.includes('Business:'));
    });

    it('escapes special characters in text fields', () => {
      const ics = generateIcs({
        bookingResult: {
          start_time: '2026-03-15T10:00:00Z',
          service_name: 'Cut, Style; Wash',
        },
        label: 'A; B, C',
        businessName: 'Biz, Inc.',
      });

      assert.match(ics, /SUMMARY:Cut\\, Style\\; Wash — A\\; B\\, C/);
      assert.match(ics, /Biz\\, Inc\./);
    });

    it('uses business name in summary for customer role', () => {
      const ics = generateIcs({
        bookingResult: {
          start_time: '2026-03-15T12:00:00Z',
          end_time: '2026-03-15T12:30:00Z',
          service_name: 'Haircut',
        },
        label: 'Dan',
        businessName: 'MyBiz',
        role: 'customer',
      });

      assert.match(ics, /SUMMARY:Haircut — MyBiz/);
      assert.match(ics, /DESCRIPTION:Business: MyBiz/);
      assert.ok(!ics.includes('Customer:'));
    });

    it('uses customer name in summary for boss role', () => {
      const ics = generateIcs({
        bookingResult: {
          start_time: '2026-03-15T12:00:00Z',
          service_name: 'Consultation',
        },
        label: 'John',
        businessName: 'MyBiz',
        role: 'boss',
      });

      assert.match(ics, /SUMMARY:Consultation — John/);
      assert.match(ics, /Customer: John/);
    });

    it('uses \\r\\n line endings (RFC 5545)', () => {
      const ics = generateIcs({
        bookingResult: { start_time: '2026-01-01T00:00:00Z' },
        label: 'X',
        businessName: 'B',
      });

      // Every line should end with \r\n
      const lines = ics.split('\r\n');
      assert.ok(lines.length > 5);
      assert.equal(lines[0], 'BEGIN:VCALENDAR');
    });
  });
});
