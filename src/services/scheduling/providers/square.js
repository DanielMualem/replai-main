const axios = require('axios');
const logger = require('../../../logger');

const SQUARE_API_BASE = 'https://connect.squareup.com/v2';

/**
 * Extract a useful error message from a Square API error response.
 */
function extractSquareError(err) {
  if (err.response?.data) {
    const data = err.response.data;
    const detail = Array.isArray(data.errors) && data.errors[0]?.detail;
    if (detail) {
      const msg = typeof detail === 'object' ? JSON.stringify(detail) : detail;
      return `${err.response.status}: ${msg}`;
    }
  }
  return err.message;
}

class SquareProvider {
  constructor(providerConfig) {
    this.apiKey = providerConfig.api_key;
    this.locationId = providerConfig.location_id;
    this.timezone = providerConfig.timezone || 'Asia/Jerusalem';
    // Cache: catalog item ID -> first variation ID
    this._variationMap = new Map();
    this.client = axios.create({
      baseURL: SQUARE_API_BASE,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async getServices() {
    try {
      const res = await this.client.post('/catalog/search', {
        object_types: ['ITEM'],
        query: {
          exact_query: {
            attribute_name: 'product_type',
            attribute_value: 'APPOINTMENTS_SERVICE',
          },
        },
      });

      const objects = res.data.objects || [];
      logger.debug({ count: objects.length }, 'Square catalog search response');

      const services = objects
        .filter((item) => item.item_data?.product_type === 'APPOINTMENTS_SERVICE')
        .map((item) => {
          const variation = item.item_data.variations?.[0];
          if (variation) {
            this._variationMap.set(item.id, variation.id);
          }
          const durationMs = variation?.item_variation_data?.service_duration;
          return {
            id: item.id,
            name: item.item_data.name,
            duration: durationMs ? Math.round(durationMs / 60000) : null,
            description: item.item_data.description || null,
          };
        });

      return services;
    } catch (err) {
      const detail = extractSquareError(err);
      logger.error({ error: detail }, 'Square getServices failed');
      throw new Error(`Failed to fetch services: ${detail}`);
    }
  }

  /**
   * Resolve a catalog item ID to its first variation ID.
   * Uses the cached mapping from getServices, fetching if needed.
   */
  async _getServiceVariationId(serviceId) {
    if (this._variationMap.has(serviceId)) {
      return this._variationMap.get(serviceId);
    }
    // Fetch the specific catalog item to get its variation
    try {
      const res = await this.client.get(`/catalog/object/${serviceId}`);
      const item = res.data.object;
      const variation = item?.item_data?.variations?.[0];
      if (variation) {
        this._variationMap.set(serviceId, variation.id);
        return variation.id;
      }
      throw new Error(`No variation found for service ${serviceId}`);
    } catch (err) {
      if (err.message?.includes('No variation found')) throw err;
      const detail = extractSquareError(err);
      logger.error({ error: detail, serviceId }, 'Square _getServiceVariationId failed');
      throw new Error(`Failed to resolve service variation: ${detail}`);
    }
  }

  async getAvailableSlots(date, serviceId) {
    try {
      if (!serviceId) throw new Error('No service_id provided. Call get_services first.');

      const serviceVariationId = await this._getServiceVariationId(serviceId);

      const nextDay = new Date(`${date}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const endDate = nextDay.toISOString().split('T')[0];

      const res = await this.client.post('/bookings/availability/search', {
        query: {
          filter: {
            start_at_range: {
              start_at: `${date}T00:00:00Z`,
              end_at: `${endDate}T00:00:00Z`,
            },
            location_id: this.locationId,
            segment_filters: [{
              service_variation_id: serviceVariationId,
            }],
          },
        },
      });

      const availabilities = res.data.availabilities || [];
      logger.debug({ date, serviceId, slotsCount: availabilities.length }, 'Square availability response');

      return availabilities.map((avail) => ({
        start: avail.start_at,
        end: null,
        serviceVariationId,
        locationId: this.locationId,
        date,
      }));
    } catch (err) {
      if (err.message?.includes('No service_id') || err.message?.includes('No variation found')) throw err;
      const detail = extractSquareError(err);
      logger.error({ error: detail, date }, 'Square getAvailableSlots failed');
      throw new Error(`Failed to fetch availability: ${detail}`);
    }
  }

  /**
   * Find an existing Square customer or create a new one.
   */
  async _getOrCreateCustomer(customerInfo) {
    const email = customerInfo.email || `${customerInfo.phone || 'unknown'}@placeholder.whatsapp`;

    // Try to find by email
    try {
      const searchRes = await this.client.post('/customers/search', {
        query: {
          filter: {
            email_address: { exact: email },
          },
        },
      });
      const customers = searchRes.data.customers || [];
      if (customers.length > 0) {
        return customers[0].id;
      }
    } catch (err) {
      logger.warn({ error: extractSquareError(err) }, 'Square customer search failed, will create new');
    }

    // Create new customer
    const name = customerInfo.name || 'Customer';
    const spaceIdx = name.indexOf(' ');
    const givenName = spaceIdx > 0 ? name.slice(0, spaceIdx) : name;
    const familyName = spaceIdx > 0 ? name.slice(spaceIdx + 1) : '';

    const createRes = await this.client.post('/customers', {
      given_name: givenName,
      family_name: familyName,
      email_address: email,
      phone_number: customerInfo.phone || null,
    });

    return createRes.data.customer.id;
  }

  async bookAppointment(slot, customerInfo) {
    try {
      const customerId = await this._getOrCreateCustomer(customerInfo);

      const res = await this.client.post('/bookings', {
        booking: {
          location_id: this.locationId,
          customer_id: customerId,
          start_at: slot.start,
          appointment_segments: [{
            service_variation_id: slot.serviceVariationId,
          }],
        },
      });

      const booking = res.data.booking;
      logger.debug({ bookingId: booking.id, status: booking.status }, 'Square booking response');
      return {
        bookingId: String(booking.id),
        status: booking.status || 'ACCEPTED',
        start: booking.start_at,
        end: null,
        meetingUrl: null,
      };
    } catch (err) {
      const detail = extractSquareError(err);
      logger.error({ error: detail }, 'Square bookAppointment failed');
      throw new Error(`Failed to book appointment: ${detail}`);
    }
  }

  async cancelAppointment(bookingId) {
    try {
      logger.debug({ bookingId }, 'Square cancelling booking');

      // First fetch the booking to get its version
      const getRes = await this.client.get(`/bookings/${bookingId}`);
      const version = getRes.data.booking.version;

      await this.client.post(`/bookings/${bookingId}/cancel`, {
        booking_version: version,
      });

      logger.debug({ bookingId }, 'Square cancel response');
      return { success: true, bookingId };
    } catch (err) {
      const detail = extractSquareError(err);
      logger.error({ error: detail, bookingId }, 'Square cancelAppointment failed');
      throw new Error(`Failed to cancel appointment: ${detail}`);
    }
  }

  async getBookings(customerPhone, options = {}) {
    const status = options.status || 'upcoming';
    const results = new Map();

    // Build query params — only restrict to future bookings for 'upcoming'
    const bookingsParams = { location_id: this.locationId };
    if (status === 'upcoming') {
      bookingsParams.start_at_min = new Date().toISOString();
    }

    // Strategy 1: find by placeholder email
    try {
      const email = `${customerPhone}@placeholder.whatsapp`;
      const searchRes = await this.client.post('/customers/search', {
        query: {
          filter: {
            email_address: { exact: email },
          },
        },
      });
      const customers = searchRes.data.customers || [];
      if (customers.length > 0) {
        const customerId = customers[0].id;
        const bookingsRes = await this.client.get('/bookings', {
          params: { ...bookingsParams, customer_id: customerId },
        });
        for (const b of (bookingsRes.data.bookings || [])) {
          results.set(String(b.id), b);
        }
      }
    } catch (err) {
      logger.warn({ error: extractSquareError(err) }, 'Square getBookings email lookup failed');
    }

    // Strategy 2: find by phone number
    try {
      const searchRes = await this.client.post('/customers/search', {
        query: {
          filter: {
            phone_number: { exact: customerPhone },
          },
        },
      });
      const customers = searchRes.data.customers || [];
      for (const customer of customers) {
        const bookingsRes = await this.client.get('/bookings', {
          params: { ...bookingsParams, customer_id: customer.id },
        });
        for (const b of (bookingsRes.data.bookings || [])) {
          const key = String(b.id);
          if (!results.has(key)) results.set(key, b);
        }
      }
    } catch (err) {
      logger.warn({ error: extractSquareError(err) }, 'Square getBookings phone lookup failed');
    }

    // Filter by status
    const now = new Date();
    const filtered = [...results.values()].filter((b) => {
      if (status === 'upcoming') {
        return new Date(b.start_at) > now &&
          b.status !== 'CANCELLED_BY_CUSTOMER' &&
          b.status !== 'CANCELLED_BY_SELLER';
      }
      if (status === 'cancelled' || status === 'canceled') {
        return b.status === 'CANCELLED_BY_CUSTOMER' || b.status === 'CANCELLED_BY_SELLER';
      }
      return true;
    });

    // Normalize results
    return filtered.map((b) => ({
      bookingId: String(b.id),
      title: 'Appointment',
      start: b.start_at,
      end: null,
      status: b.status,
      attendeeName: b.customer_id || null,
    }));
  }
}

module.exports = SquareProvider;
