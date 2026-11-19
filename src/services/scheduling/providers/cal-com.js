const axios = require('axios');
const logger = require('../../../logger');

const CAL_API_BASE = 'https://api.cal.com/v2';

/**
 * Extract a useful error message from a Cal.com API error response.
 */
function extractCalError(err) {
  if (err.response?.data) {
    const data = err.response.data;
    const detail = data.message || data.error || (Array.isArray(data.errors) && data.errors[0]?.message);
    if (detail) {
      const msg = typeof detail === 'object' ? JSON.stringify(detail) : detail;
      return `${err.response.status}: ${msg}`;
    }
  }
  return err.message;
}

class CalComProvider {
  constructor(providerConfig) {
    this.apiKey = providerConfig.api_key;
    this.eventTypeId = providerConfig.event_type_id;
    this.timezone = providerConfig.timezone || 'Asia/Jerusalem';
    this.client = axios.create({
      baseURL: CAL_API_BASE,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'cal-api-version': '2024-08-13',
        'Content-Type': 'application/json',
      },
    });
  }

  async getServices() {
    try {
      const res = await this.client.get('/event-types', {
        headers: { 'cal-api-version': '2024-06-14' },
      });
      const eventTypes = res.data.data || res.data;
      logger.debug({ count: Array.isArray(eventTypes) ? eventTypes.length : 0 }, 'Cal.com event types response');
      return (Array.isArray(eventTypes) ? eventTypes : []).map((et) => ({
        id: String(et.id),
        name: et.title || et.slug,
        duration: et.lengthInMinutes || et.length,
        description: et.description || null,
      }));
    } catch (err) {
      const detail = extractCalError(err);
      logger.error({ error: detail }, 'Cal.com getServices failed');
      throw new Error(`Failed to fetch services: ${detail}`);
    }
  }

  async getAvailableSlots(date, serviceId) {
    try {
      const eventTypeId = Number(serviceId || this.eventTypeId);
      if (!eventTypeId || Number.isNaN(eventTypeId)) throw new Error('No valid event_type_id or service_id provided. Call get_services first.');

      // Compute next day for end range (Cal.com expects exclusive end date)
      const nextDay = new Date(`${date}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const endDate = nextDay.toISOString().split('T')[0];

      // Use newer /slots endpoint (v2 2024-09-04) — the older /slots/available
      // endpoint (2024-08-13) may return empty data on newer Cal.com instances.
      const res = await this.client.get('/slots', {
        params: {
          start: date,
          end: endDate,
          eventTypeId,
          timeZone: this.timezone,
        },
        headers: { 'cal-api-version': '2024-09-04' },
      });

      logger.debug({ date, eventTypeId, responseData: JSON.stringify(res.data).slice(0, 2000) }, 'Cal.com slots raw response');

      const slotsData = res.data.data || res.data;
      // Cal.com returns slots grouped by date: { "2026-02-20": [{ start, end }, ...] }
      const allSlots = [];
      if (slotsData && typeof slotsData === 'object' && !Array.isArray(slotsData)) {
        // Handle both old format (nested under .slots) and new format (dates at top level)
        const slotArrays = slotsData.slots || slotsData;
        if (typeof slotArrays === 'object' && !Array.isArray(slotArrays)) {
          for (const [slotDate, slots] of Object.entries(slotArrays)) {
            if (Array.isArray(slots)) {
              for (const slot of slots) {
                allSlots.push({
                  start: slot.time || slot.start,
                  end: slot.endTime || slot.end || null,
                  eventTypeId,
                  date: slotDate,
                });
              }
            }
          }
        }
      }

      logger.debug({ date, slotsCount: allSlots.length }, 'Cal.com parsed slots');
      return allSlots;
    } catch (err) {
      const detail = extractCalError(err);
      logger.error({ error: detail, date }, 'Cal.com getAvailableSlots failed');
      throw new Error(`Failed to fetch availability: ${detail}`);
    }
  }

  async bookAppointment(slot, customerInfo) {
    try {
      const eventTypeId = slot.eventTypeId || this.eventTypeId;
      if (!eventTypeId) throw new Error('No event_type_id for booking');

      const res = await this.client.post('/bookings', {
        eventTypeId: Number(eventTypeId),
        start: slot.start,
        attendee: {
          name: customerInfo.name || 'Customer',
          email: customerInfo.email || `${customerInfo.phone || 'unknown'}@placeholder.whatsapp`,
          timeZone: this.timezone,
        },
        metadata: {
          source: 'replai-whatsapp',
          customerPhone: customerInfo.phone || null,
        },
      });

      const booking = res.data.data || res.data;
      logger.debug({ bookingUid: booking.uid, bookingId: booking.id, status: booking.status }, 'Cal.com booking response');
      return {
        bookingId: String(booking.uid || booking.id),
        status: booking.status || 'confirmed',
        start: booking.start || booking.startTime || slot.start,
        end: booking.end || booking.endTime || slot.end,
        meetingUrl: booking.meetingUrl || null,
      };
    } catch (err) {
      const detail = extractCalError(err);
      logger.error({ error: detail }, 'Cal.com bookAppointment failed');
      throw new Error(`Failed to book appointment: ${detail}`);
    }
  }

  async cancelAppointment(bookingId) {
    try {
      logger.debug({ bookingId }, 'Cal.com cancelling booking');
      const res = await this.client.post(`/bookings/${bookingId}/cancel`, {
        cancellationReason: 'Cancelled via WhatsApp',
      });
      logger.debug({ bookingId, status: res.data?.data?.status || res.data?.status }, 'Cal.com cancel response');
      return { success: true, bookingId };
    } catch (err) {
      const detail = extractCalError(err);
      logger.error({ error: detail, bookingId }, 'Cal.com cancelAppointment failed');
      throw new Error(`Failed to cancel appointment: ${detail}`);
    }
  }

  async getBookings(customerPhone, options = {}) {
    const status = options.status || 'upcoming';
    const results = new Map();

    // Strategy 1: find by placeholder email (bookings made through our system)
    try {
      const email = `${customerPhone}@placeholder.whatsapp`;
      const res = await this.client.get('/bookings', {
        params: { attendeeEmail: email, status, take: 10, sortStart: 'asc' },
      });
      for (const b of (res.data.data || [])) {
        results.set(String(b.uid || b.id), b);
      }
    } catch (err) {
      logger.warn({ error: extractCalError(err) }, 'Cal.com getBookings email lookup failed');
    }

    // Strategy 2: client-side phone match across all bookings (external bookings)
    try {
      const res = await this.client.get('/bookings', {
        params: { status, take: 50, sortStart: 'asc' },
      });
      for (const b of (res.data.data || [])) {
        const key = String(b.uid || b.id);
        if (results.has(key)) continue;
        const phoneMatch =
          b.metadata?.customerPhone === customerPhone ||
          b.attendees?.some(a => a.phoneNumber === customerPhone);
        if (phoneMatch) results.set(key, b);
      }
    } catch (err) {
      logger.warn({ error: extractCalError(err) }, 'Cal.com getBookings phone lookup failed');
    }

    // Normalize results
    return [...results.values()].map(b => ({
      bookingId: String(b.uid || b.id),
      title: b.title || null,
      start: b.start,
      end: b.end,
      status: b.status,
      attendeeName: b.attendees?.[0]?.name || null,
    }));
  }
}

module.exports = CalComProvider;
