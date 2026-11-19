const db = require('../../db');
const logger = require('../../../logger');

class InternalProvider {
  constructor(providerConfig) {
    this.businessId = providerConfig.business_id;
    this.timezone = providerConfig.timezone || 'Asia/Jerusalem';
    this.services = providerConfig.services || [];
    this.workingHours = providerConfig.working_hours || {};
    this.slotInterval = providerConfig.slot_interval || 30;
    this.bufferMinutes = providerConfig.buffer_minutes || 0;
    this.blockedDates = providerConfig.blocked_dates || [];
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
    // Check blocked dates
    if (this.blockedDates.includes(date)) return [];

    // Look up day of week
    const dateObj = new Date(`${date}T12:00:00`); // noon to avoid timezone edge cases in day-of-week
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = dayNames[dateObj.getDay()];
    const windows = this.workingHours[dayName];
    if (!windows || windows.length === 0) return [];

    // Get service duration
    const service = serviceId && this.services.find((s) => s.id === serviceId);
    const duration = service ? service.duration : this.slotInterval;

    // Get existing appointments for the date
    const existing = db.getAppointmentsByDate(this.businessId, date);

    // Determine "now" in the business timezone for today filtering
    const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: this.timezone }));
    const todayStr = `${nowInTz.getFullYear()}-${String(nowInTz.getMonth() + 1).padStart(2, '0')}-${String(nowInTz.getDate()).padStart(2, '0')}`;
    const isToday = date === todayStr;
    const nowMinutes = isToday ? nowInTz.getHours() * 60 + nowInTz.getMinutes() : 0;

    const slots = [];

    for (const window of windows) {
      const [startH, startM] = window.start.split(':').map(Number);
      const [endH, endM] = window.end.split(':').map(Number);
      const windowStart = startH * 60 + startM;
      const windowEnd = endH * 60 + endM;

      for (let t = windowStart; t + duration <= windowEnd; t += this.slotInterval) {
        // Skip past slots for today
        if (isToday && t < nowMinutes) continue;

        const slotStart = t;
        const slotEnd = t + duration;

        // Check for overlap with existing appointments
        // Buffer is post-appointment only (cleanup/prep time after each booking)
        const hasConflict = existing.some((appt) => {
          const apptStart = this._timeToMinutes(appt.start_time);
          const apptEnd = apptStart + appt.service_duration + this.bufferMinutes;

          // Two intervals overlap if one starts before the other ends
          return slotStart < apptEnd && apptStart < slotEnd;
        });

        if (!hasConflict) {
          const startISO = `${date}T${this._minutesToTime(slotStart)}:00`;
          const endISO = `${date}T${this._minutesToTime(slotEnd)}:00`;
          slots.push({ start: startISO, end: endISO });
        }
      }
    }

    return slots;
  }

  async bookAppointment(slot, customerInfo) {
    const service = this._findServiceBySlot(slot);
    const duration = service ? service.duration : this.slotInterval;
    const serviceName = service ? service.name : 'Appointment';
    const serviceId = service ? service.id : 'unknown';

    const startMinutes = this._timeToMinutes(slot.start);
    const endMinutes = startMinutes + duration;
    const dateStr = slot.start.split('T')[0];

    // Double-check for conflicts (race condition guard)
    // Buffer is post-appointment only, consistent with getAvailableSlots
    const existing = db.getAppointmentsByDate(this.businessId, dateStr);
    const hasConflict = existing.some((appt) => {
      const apptStart = this._timeToMinutes(appt.start_time);
      const apptEnd = apptStart + appt.service_duration + this.bufferMinutes;
      return startMinutes < apptEnd && apptStart < endMinutes;
    });

    if (hasConflict) {
      throw new Error('Time slot is no longer available. Please check availability again.');
    }

    const startTime = slot.start.includes('T') ? slot.start : `${dateStr}T${this._minutesToTime(startMinutes)}:00`;
    const endTime = `${dateStr}T${this._minutesToTime(endMinutes)}:00`;

    const appointment = db.createAppointment({
      business_id: this.businessId,
      customer_phone: customerInfo.phone,
      customer_name: customerInfo.name || 'Customer',
      service_id: serviceId,
      service_name: serviceName,
      service_duration: duration,
      start_time: startTime,
      end_time: endTime,
    });

    logger.debug({ appointmentId: appointment.id, start: startTime, end: endTime }, 'Internal provider: appointment booked');

    return {
      bookingId: appointment.id,
      status: 'confirmed',
      start: startTime,
      end: endTime,
    };
  }

  async cancelAppointment(bookingId) {
    const appointment = db.getAppointment(bookingId);
    if (!appointment || appointment.business_id !== this.businessId) {
      throw new Error(`Appointment ${bookingId} not found.`);
    }
    if (appointment.status === 'cancelled') {
      throw new Error(`Appointment ${bookingId} is already cancelled.`);
    }

    db.updateAppointmentStatus(bookingId, 'cancelled');
    logger.debug({ bookingId }, 'Internal provider: appointment cancelled');
    return { success: true, bookingId };
  }

  async getBookings(customerPhone, options = {}) {
    const status = options.status || 'upcoming';
    // Use local "now" in business timezone to match stored naive-local timestamps
    const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: this.timezone }));
    const now = `${nowInTz.getFullYear()}-${String(nowInTz.getMonth() + 1).padStart(2, '0')}-${String(nowInTz.getDate()).padStart(2, '0')}T${String(nowInTz.getHours()).padStart(2, '0')}:${String(nowInTz.getMinutes()).padStart(2, '0')}:${String(nowInTz.getSeconds()).padStart(2, '0')}`;

    let appointments;
    if (status === 'upcoming') {
      appointments = db.getAppointmentsByCustomer(this.businessId, customerPhone, 'confirmed')
        .filter((a) => a.start_time >= now);
    } else if (status === 'past') {
      appointments = db.getAppointmentsByCustomer(this.businessId, customerPhone, 'confirmed')
        .filter((a) => a.start_time < now);
    } else if (status === 'cancelled') {
      appointments = db.getAppointmentsByCustomer(this.businessId, customerPhone, 'cancelled');
    } else {
      appointments = db.getAppointmentsByCustomer(this.businessId, customerPhone);
    }

    return appointments.map((a) => ({
      bookingId: a.id,
      title: a.service_name,
      start: a.start_time,
      end: a.end_time,
      status: a.status,
      attendeeName: a.customer_name,
    }));
  }

  // --- Internal helpers ---

  _timeToMinutes(timeStr) {
    // Handle ISO format "2026-03-01T09:00:00" or plain "09:00"
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
    // If slot has a serviceName, match by name; otherwise try matching by duration or return first service
    if (slot.serviceName) {
      return this.services.find((s) => s.name === slot.serviceName) || this.services[0] || null;
    }
    if (slot.serviceId) {
      return this.services.find((s) => s.id === slot.serviceId) || this.services[0] || null;
    }
    return this.services[0] || null;
  }
}

module.exports = InternalProvider;
