const crypto = require('crypto');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const cache = new Map();

function sweepExpired() {
  const now = Date.now();
  for (const [id, entry] of cache) {
    if (now > entry.expires) cache.delete(id);
  }
}

function storeBooking(bookingResult, label, businessName, role = 'boss') {
  sweepExpired();
  const id = crypto.randomUUID();
  cache.set(id, {
    data: { bookingResult, label, businessName, role },
    expires: Date.now() + CACHE_TTL_MS,
  });
  return id;
}

function getBooking(id) {
  const entry = cache.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(id);
    return null;
  }
  return entry.data;
}

function padTwo(n) {
  return String(n).padStart(2, '0');
}

function formatIcsDate(date) {
  return `${date.getUTCFullYear()}${padTwo(date.getUTCMonth() + 1)}${padTwo(date.getUTCDate())}T${padTwo(date.getUTCHours())}${padTwo(date.getUTCMinutes())}${padTwo(date.getUTCSeconds())}Z`;
}

function escapeIcsText(text) {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function generateIcs(data) {
  const { bookingResult, label, businessName, role } = data;

  const start = new Date(bookingResult.start_time);
  const end = bookingResult.end_time
    ? new Date(bookingResult.end_time)
    : new Date(start.getTime() + 60 * 60 * 1000);

  let summary, descParts;
  if (role === 'customer') {
    summary = bookingResult.service_name
      ? `${bookingResult.service_name} — ${businessName || 'Appointment'}`
      : `Appointment — ${businessName || 'Appointment'}`;
    descParts = [];
    if (businessName) descParts.push(`Business: ${businessName}`);
  } else {
    summary = bookingResult.service_name
      ? `${bookingResult.service_name} — ${label}`
      : `Appointment — ${label}`;
    descParts = [`Customer: ${label}`];
    if (businessName) descParts.push(`Business: ${businessName}`);
  }

  const uid = crypto.randomUUID();
  const dtstamp = formatIcsDate(new Date());

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Aiyelet//Booking//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `DESCRIPTION:${escapeIcsText(descParts.join('\n'))}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

module.exports = {
  storeBooking,
  getBooking,
  generateIcs,
  // Exposed for testing
  cache,
};
