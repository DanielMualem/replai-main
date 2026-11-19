const { OAuth2Client } = require('google-auth-library');
const logger = require('../../../logger');

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

class GoogleCalendarProvider {
  constructor(providerConfig) {
    this.businessId = providerConfig.business_id;
    this.timezone = providerConfig.timezone || 'Asia/Jerusalem';
    this.services = providerConfig.services || [];
    this.workingHours = providerConfig.working_hours || {};
    this.slotInterval = providerConfig.slot_interval || 30;
    this.bufferMinutes = providerConfig.buffer_minutes || 0;
    this.blockedDates = providerConfig.blocked_dates || [];
    this.calendarId = providerConfig.calendar_id || 'primary';

    this.oauth2Client = new OAuth2Client(
      providerConfig.google_client_id,
      providerConfig.google_client_secret
    );
    this.oauth2Client.setCredentials({
      refresh_token: providerConfig.refresh_token,
    });
  }

  async getServices() {
    return this.services.map((s) => ({
      id: s.id,
      name: s.name,
      duration: s.duration,
      description: s.description || null,
    }));
  }

  async getAvailableSlots(date, serviceId) {
    if (this.blockedDates.includes(date)) return [];

    const dateObj = new Date(`${date}T12:00:00`);
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = dayNames[dateObj.getDay()];
    const windows = this.workingHours[dayName];
    if (!windows || windows.length === 0) return [];

    const service = serviceId && this.services.find((s) => s.id === serviceId);
    const duration = service ? service.duration : this.slotInterval;

    // Determine "now" in the business timezone for today filtering
    const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: this.timezone }));
    const todayStr = `${nowInTz.getFullYear()}-${String(nowInTz.getMonth() + 1).padStart(2, '0')}-${String(nowInTz.getDate()).padStart(2, '0')}`;
    const isToday = date === todayStr;
    const nowMinutes = isToday ? nowInTz.getHours() * 60 + nowInTz.getMinutes() : 0;

    // Generate candidate slots from working hours
    const candidates = [];
    for (const window of windows) {
      const [startH, startM] = window.start.split(':').map(Number);
      const [endH, endM] = window.end.split(':').map(Number);
      const windowStart = startH * 60 + startM;
      const windowEnd = endH * 60 + endM;

      for (let t = windowStart; t + duration <= windowEnd; t += this.slotInterval) {
        if (isToday && t < nowMinutes) continue;
        candidates.push({ startMinutes: t, endMinutes: t + duration });
      }
    }

    if (candidates.length === 0) return [];

    // Query Google Calendar Free/Busy API to filter conflicts
    const busyPeriods = await this._getFreeBusy(date, candidates);

    const slots = [];
    for (const candidate of candidates) {
      const hasConflict = busyPeriods.some((busy) => {
        const busyStart = busy.startMinutes;
        const busyEnd = busy.endMinutes + this.bufferMinutes;
        return candidate.startMinutes < busyEnd && busyStart < candidate.endMinutes;
      });

      if (!hasConflict) {
        slots.push({
          start: `${date}T${this._minutesToTime(candidate.startMinutes)}:00`,
          end: `${date}T${this._minutesToTime(candidate.endMinutes)}:00`,
        });
      }
    }

    return slots;
  }

  async bookAppointment(slot, customerInfo) {
    const service = this._findServiceBySlot(slot);
    const duration = service ? service.duration : this.slotInterval;
    const serviceName = service ? service.name : 'Appointment';

    const startMinutes = this._timeToMinutes(slot.start);
    const endMinutes = startMinutes + duration;
    const dateStr = slot.start.split('T')[0];

    // Re-check free/busy (race condition guard)
    const busyPeriods = await this._getFreeBusy(dateStr, [{ startMinutes, endMinutes }]);
    const hasConflict = busyPeriods.some((busy) => {
      const busyEnd = busy.endMinutes + this.bufferMinutes;
      return startMinutes < busyEnd && busy.startMinutes < endMinutes;
    });

    if (hasConflict) {
      throw new Error('Time slot is no longer available. Please check availability again.');
    }

    const startTime = slot.start.includes('T') ? slot.start : `${dateStr}T${this._minutesToTime(startMinutes)}:00`;
    const endTime = `${dateStr}T${this._minutesToTime(endMinutes)}:00`;

    const event = {
      summary: `${serviceName} - ${customerInfo.name || 'Customer'}`,
      start: { dateTime: `${startTime}`, timeZone: this.timezone },
      end: { dateTime: `${endTime}`, timeZone: this.timezone },
      description: `Booked via Aiyelet\nCustomer: ${customerInfo.name || 'Customer'}\nPhone: ${customerInfo.phone || 'N/A'}`,
      extendedProperties: {
        private: {
          aiyelet_booking: 'true',
          customer_phone: customerInfo.phone || '',
          service_id: service ? service.id : 'unknown',
          service_name: serviceName,
          service_duration: String(duration),
        },
      },
    };

    const headers = await this._getAuthHeaders();
    const res = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(this.calendarId)}/events`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      }
    );

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`Failed to create calendar event: ${res.status}: ${errData.error?.message || 'Unknown error'}`);
    }

    const created = await res.json();

    logger.debug({ eventId: created.id, start: startTime, end: endTime }, 'Google Calendar provider: appointment booked');

    return {
      bookingId: created.id,
      status: 'confirmed',
      start: startTime,
      end: endTime,
    };
  }

  async cancelAppointment(bookingId) {
    const headers = await this._getAuthHeaders();
    const res = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(bookingId)}`,
      { method: 'DELETE', headers }
    );

    if (!res.ok && res.status !== 410) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`Failed to cancel appointment: ${res.status}: ${errData.error?.message || 'Unknown error'}`);
    }

    logger.debug({ bookingId }, 'Google Calendar provider: appointment cancelled');
    return { success: true, bookingId };
  }

  async getBookings(customerPhone, options = {}) {
    const status = options.status || 'upcoming';
    const headers = await this._getAuthHeaders();

    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
    });
    // Google Calendar API supports multiple privateExtendedProperty params via append
    params.append('privateExtendedProperty', `customer_phone=${customerPhone}`);
    params.append('privateExtendedProperty', 'aiyelet_booking=true');

    // Use actual UTC time — Google Calendar API handles UTC correctly
    const nowISO = new Date().toISOString();

    if (status === 'upcoming') {
      params.set('timeMin', nowISO);
    } else if (status === 'past') {
      params.set('timeMax', nowISO);
    }
    // Note: 'cancelled' status will return empty — cancelAppointment deletes events

    const res = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(this.calendarId)}/events?${params}`,
      { headers }
    );

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`Failed to fetch bookings: ${res.status}: ${errData.error?.message || 'Unknown error'}`);
    }

    const data = await res.json();
    const events = data.items || [];

    return events.map((e) => {
      const props = e.extendedProperties?.private || {};
      return {
        bookingId: e.id,
        title: props.service_name || e.summary || 'Appointment',
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        status: e.status === 'cancelled' ? 'cancelled' : 'confirmed',
        attendeeName: (e.summary || '').replace(/^.*? - /, '') || 'Customer',
      };
    });
  }

  // --- Internal helpers ---

  async _getAuthHeaders() {
    const { token } = await this.oauth2Client.getAccessToken();
    return { Authorization: `Bearer ${token}` };
  }

  async _getFreeBusy(date, candidates) {
    // Determine the full time range we need to query
    let minMinutes = Infinity;
    let maxMinutes = -Infinity;
    for (const c of candidates) {
      if (c.startMinutes < minMinutes) minMinutes = c.startMinutes;
      if (c.endMinutes > maxMinutes) maxMinutes = c.endMinutes;
    }

    // Build proper RFC 3339 timestamps with timezone offset
    const tzOffset = this._getTimezoneOffset(date);
    const timeMin = `${date}T${this._minutesToTime(minMinutes)}:00${tzOffset}`;
    const timeMax = `${date}T${this._minutesToTime(maxMinutes)}:00${tzOffset}`;

    const headers = await this._getAuthHeaders();
    const res = await fetch(`${CALENDAR_API}/freeBusy`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeMin,
        timeMax,
        timeZone: this.timezone,
        items: [{ id: this.calendarId }],
      }),
    });

    if (!res.ok) {
      logger.warn({ status: res.status, date }, 'Google Calendar Free/Busy API failed, returning no conflicts');
      return [];
    }

    const data = await res.json();
    const busySlots = data.calendars?.[this.calendarId]?.busy || [];

    return busySlots.map((b) => {
      // Parse busy period times into minutes for the given date
      const startDt = new Date(b.start);
      const endDt = new Date(b.end);
      // Convert to business timezone
      const startLocal = new Date(startDt.toLocaleString('en-US', { timeZone: this.timezone }));
      const endLocal = new Date(endDt.toLocaleString('en-US', { timeZone: this.timezone }));
      return {
        startMinutes: startLocal.getHours() * 60 + startLocal.getMinutes(),
        endMinutes: endLocal.getHours() * 60 + endLocal.getMinutes(),
      };
    });
  }

  _getTimezoneOffset(date) {
    // Compute the UTC offset for this.timezone on the given date
    // by comparing UTC and local representations
    const dt = new Date(`${date}T12:00:00Z`);
    const utcStr = dt.toLocaleString('en-US', { timeZone: 'UTC', hour12: false, hour: '2-digit', minute: '2-digit' });
    const tzStr = dt.toLocaleString('en-US', { timeZone: this.timezone, hour12: false, hour: '2-digit', minute: '2-digit' });
    const [utcH, utcM] = utcStr.split(':').map(Number);
    const [tzH, tzM] = tzStr.split(':').map(Number);
    const diffMinutes = (tzH * 60 + tzM) - (utcH * 60 + utcM);
    const sign = diffMinutes >= 0 ? '+' : '-';
    const absMinutes = Math.abs(diffMinutes);
    const offH = String(Math.floor(absMinutes / 60)).padStart(2, '0');
    const offM = String(absMinutes % 60).padStart(2, '0');
    return `${sign}${offH}:${offM}`;
  }

  _timeToMinutes(timeStr) {
    let timePart = timeStr;
    if (timeStr.includes('T')) {
      timePart = timeStr.split('T')[1];
    }
    const [h, m] = timePart.split(':').map(Number);
    return h * 60 + m;
  }

  _minutesToTime(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  _findServiceBySlot(slot) {
    if (slot.serviceName) {
      return this.services.find((s) => s.name === slot.serviceName) || this.services[0] || null;
    }
    if (slot.serviceId) {
      return this.services.find((s) => s.id === slot.serviceId) || this.services[0] || null;
    }
    return this.services[0] || null;
  }
}

module.exports = GoogleCalendarProvider;
