const axios = require('axios');
const logger = require('../../../logger');

const CALENDLY_API_BASE = 'https://api.calendly.com';

/**
 * Extract a useful error message from a Calendly API error response.
 */
function extractCalendlyError(err) {
  if (err.response?.data) {
    const data = err.response.data;
    const detail = data.message || data.title;
    if (detail) {
      const msg = typeof detail === 'object' ? JSON.stringify(detail) : detail;
      return `${err.response.status}: ${msg}`;
    }
  }
  return err.message;
}

class CalendlyProvider {
  constructor(providerConfig) {
    this.apiKey = providerConfig.api_key;
    this.timezone = providerConfig.timezone || 'Asia/Jerusalem';
    this._userUri = null;
    this.client = axios.create({
      baseURL: CALENDLY_API_BASE,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Get the current user's URI. Cached after first call.
   */
  async _getUserUri() {
    if (this._userUri) return this._userUri;
    const res = await this.client.get('/users/me');
    this._userUri = res.data.resource.uri;
    return this._userUri;
  }

  async getServices() {
    try {
      const userUri = await this._getUserUri();
      const res = await this.client.get('/event_types', {
        params: { user: userUri, active: true },
      });
      const eventTypes = res.data.collection || [];
      logger.debug({ count: eventTypes.length }, 'Calendly event types response');
      return eventTypes.map((et) => ({
        id: et.uri,
        name: et.name,
        duration: et.duration,
        description: et.description_plain || et.description_html || null,
      }));
    } catch (err) {
      const detail = extractCalendlyError(err);
      logger.error({ error: detail }, 'Calendly getServices failed');
      throw new Error(`Failed to fetch services: ${detail}`);
    }
  }

  async getAvailableSlots(date, serviceId) {
    try {
      if (!serviceId) throw new Error('No event type URI provided. Call get_services first.');

      const nextDay = new Date(`${date}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const endDate = nextDay.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const startDate = `${date}T00:00:00Z`;

      const res = await this.client.get('/event_type_available_times', {
        params: {
          event_type: serviceId,
          start_time: startDate,
          end_time: endDate,
        },
      });

      const collection = res.data.collection || [];
      logger.debug({ date, slotsCount: collection.length }, 'Calendly parsed slots');

      return collection.map((item) => ({
        start: item.start_time,
        end: null,
        eventTypeUri: serviceId,
        date,
      }));
    } catch (err) {
      const detail = extractCalendlyError(err);
      logger.error({ error: detail, date }, 'Calendly getAvailableSlots failed');
      throw new Error(`Failed to fetch availability: ${detail}`);
    }
  }

  async bookAppointment(slot, customerInfo) {
    try {
      const eventTypeUri = slot.eventTypeUri;
      if (!eventTypeUri) throw new Error('No event type URI for booking');

      const res = await this.client.post('/scheduled_events', {
        event_type_uri: eventTypeUri,
        start_time: slot.start,
        invitee: {
          name: customerInfo.name || 'Customer',
          email: customerInfo.email || `${customerInfo.phone || 'unknown'}@placeholder.whatsapp`,
          timezone: this.timezone,
        },
        location: {
          kind: 'custom',
          location: 'WhatsApp',
        },
      });

      const event = res.data.resource || res.data;
      const bookingId = event.uri ? event.uri.split('/').pop() : null;
      logger.debug({ bookingId, status: event.status }, 'Calendly booking response');
      return {
        bookingId,
        status: event.status || 'active',
        start: event.start_time || slot.start,
        end: event.end_time || slot.end,
        meetingUrl: event.location?.join_url || null,
      };
    } catch (err) {
      const detail = extractCalendlyError(err);
      logger.error({ error: detail }, 'Calendly bookAppointment failed');
      throw new Error(`Failed to book appointment: ${detail}`);
    }
  }

  async cancelAppointment(bookingId) {
    try {
      // Extract UUID from full URI if needed
      const eventId = bookingId.startsWith('http') ? bookingId.split('/').pop() : bookingId;
      logger.debug({ bookingId, eventId }, 'Calendly cancelling booking');
      await this.client.post(`/scheduled_events/${eventId}/cancellation`, {
        reason: 'Cancelled via WhatsApp',
      });
      logger.debug({ bookingId }, 'Calendly cancel response');
      return { success: true, bookingId };
    } catch (err) {
      const detail = extractCalendlyError(err);
      logger.error({ error: detail, bookingId }, 'Calendly cancelAppointment failed');
      throw new Error(`Failed to cancel appointment: ${detail}`);
    }
  }

  async getBookings(customerPhone, options = {}) {
    const status = options.status || 'upcoming';
    const results = new Map();

    const userUri = await this._getUserUri();

    // Map status to Calendly API parameters
    const now = new Date().toISOString();
    const params = {
      user: userUri,
      count: 10,
      sort: 'start_time:asc',
    };

    if (status === 'upcoming') {
      params.status = 'active';
      params.min_start_time = now;
    } else if (status === 'cancelled') {
      params.status = 'canceled';
    } else if (status === 'past') {
      params.status = 'active';
      params.max_start_time = now;
    }

    // Strategy 1: lookup by placeholder email
    try {
      const email = `${customerPhone}@placeholder.whatsapp`;
      const res = await this.client.get('/scheduled_events', {
        params: { ...params, invitee_email: email },
      });
      for (const event of (res.data.collection || [])) {
        const uid = event.uri.split('/').pop();
        results.set(uid, event);
      }
    } catch (err) {
      logger.warn({ error: extractCalendlyError(err) }, 'Calendly getBookings email lookup failed');
    }

    // Normalize results
    return [...results.values()].map((event) => ({
      bookingId: event.uri.split('/').pop(),
      title: event.name || null,
      start: event.start_time,
      end: event.end_time,
      status: event.status,
      attendeeName: null,
    }));
  }
}

module.exports = CalendlyProvider;
