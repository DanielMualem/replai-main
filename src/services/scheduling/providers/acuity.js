const axios = require('axios');
const logger = require('../../../logger');

const ACUITY_API_BASE = 'https://acuityscheduling.com/api/v1';

/**
 * Extract a useful error message from an Acuity API error response.
 */
function extractAcuityError(err) {
  if (err.response?.data) {
    const data = err.response.data;
    const detail = data.message || data.error;
    if (detail) {
      const msg = typeof detail === 'object' ? JSON.stringify(detail) : detail;
      return `${err.response.status}: ${msg}`;
    }
  }
  return err.message;
}

class AcuityProvider {
  constructor(providerConfig) {
    this.apiKey = providerConfig.api_key;
    this.userId = providerConfig.user_id;
    this.timezone = providerConfig.timezone || 'Asia/Jerusalem';
    this.client = axios.create({
      baseURL: ACUITY_API_BASE,
      auth: {
        username: this.userId,
        password: this.apiKey,
      },
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  async getServices() {
    try {
      const res = await this.client.get('/appointment-types');
      const types = Array.isArray(res.data) ? res.data : [];
      logger.debug({ count: types.length }, 'Acuity appointment types response');
      return types.map((t) => ({
        id: String(t.id),
        name: t.name,
        duration: t.duration,
        description: t.description || null,
      }));
    } catch (err) {
      const detail = extractAcuityError(err);
      logger.error({ error: detail }, 'Acuity getServices failed');
      throw new Error(`Failed to fetch services: ${detail}`);
    }
  }

  async getAvailableSlots(date, serviceId) {
    try {
      if (!serviceId) throw new Error('No service_id provided. Call get_services first.');

      const res = await this.client.get('/availability/times', {
        params: {
          date,
          appointmentTypeID: serviceId,
        },
      });

      const times = Array.isArray(res.data) ? res.data : [];
      logger.debug({ date, serviceId, slotsCount: times.length }, 'Acuity available times response');
      return times.map((t) => ({
        start: t.time,
        end: null,
        appointmentTypeId: serviceId,
        date,
      }));
    } catch (err) {
      const detail = extractAcuityError(err);
      logger.error({ error: detail, date }, 'Acuity getAvailableSlots failed');
      throw new Error(`Failed to fetch availability: ${detail}`);
    }
  }

  async bookAppointment(slot, customerInfo) {
    try {
      const serviceId = slot.appointmentTypeId;
      if (!serviceId) throw new Error('No appointmentTypeId for booking');

      const name = customerInfo.name || 'Customer';
      const spaceIdx = name.indexOf(' ');
      const firstName = spaceIdx > 0 ? name.slice(0, spaceIdx) : name;
      const lastName = spaceIdx > 0 ? name.slice(spaceIdx + 1) : '';

      const res = await this.client.post('/appointments', {
        datetime: slot.start,
        appointmentTypeID: Number(serviceId),
        firstName,
        lastName,
        email: customerInfo.email || `${customerInfo.phone || 'unknown'}@placeholder.whatsapp`,
        phone: customerInfo.phone || null,
      });

      const booking = res.data;
      logger.debug({ bookingId: booking.id, status: 'confirmed' }, 'Acuity booking response');
      return {
        bookingId: String(booking.id),
        status: 'confirmed',
        start: booking.datetime || slot.start,
        end: booking.endTime || null,
        meetingUrl: null,
      };
    } catch (err) {
      const detail = extractAcuityError(err);
      logger.error({ error: detail }, 'Acuity bookAppointment failed');
      throw new Error(`Failed to book appointment: ${detail}`);
    }
  }

  async cancelAppointment(bookingId) {
    try {
      logger.debug({ bookingId }, 'Acuity cancelling booking');
      await this.client.put(`/appointments/${bookingId}/cancel`);
      logger.debug({ bookingId }, 'Acuity cancel response');
      return { success: true, bookingId };
    } catch (err) {
      const detail = extractAcuityError(err);
      logger.error({ error: detail, bookingId }, 'Acuity cancelAppointment failed');
      throw new Error(`Failed to cancel appointment: ${detail}`);
    }
  }

  async getBookings(customerPhone, options = {}) {
    const status = options.status || 'upcoming';
    const results = new Map();

    // Strategy 1: find by placeholder email (bookings made through our system)
    try {
      const email = `${customerPhone}@placeholder.whatsapp`;
      const res = await this.client.get('/appointments', {
        params: { email },
      });
      for (const b of (Array.isArray(res.data) ? res.data : [])) {
        results.set(String(b.id), b);
      }
    } catch (err) {
      logger.warn({ error: extractAcuityError(err) }, 'Acuity getBookings email lookup failed');
    }

    // Strategy 2: client-side phone match across all bookings (external bookings)
    try {
      const res = await this.client.get('/appointments', {
        params: { max: 50 },
      });
      for (const b of (Array.isArray(res.data) ? res.data : [])) {
        const key = String(b.id);
        if (results.has(key)) continue;
        if (b.phone === customerPhone) results.set(key, b);
      }
    } catch (err) {
      logger.warn({ error: extractAcuityError(err) }, 'Acuity getBookings phone lookup failed');
    }

    // Filter by status
    const now = new Date();
    const filtered = [...results.values()].filter((b) => {
      if (status === 'upcoming') {
        return new Date(b.datetime) > now && !b.canceled;
      }
      if (status === 'cancelled' || status === 'canceled') {
        return !!b.canceled;
      }
      return true;
    });

    // Normalize results
    return filtered.map((b) => ({
      bookingId: String(b.id),
      title: b.type || null,
      start: b.datetime,
      end: b.endTime || null,
      status: b.canceled ? 'cancelled' : 'confirmed',
      attendeeName: [b.firstName, b.lastName].filter(Boolean).join(' ') || null,
    }));
  }
}

module.exports = AcuityProvider;
