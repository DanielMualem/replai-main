const { Type } = require('@google/genai');
const db = require('../db');
const slotCache = require('./slot-cache');
const serviceCache = require('./service-cache');
const { canAccess } = require('../../middleware/plan-gate');

// ---------------------------------------------------------------------------
// Shared config parser
// ---------------------------------------------------------------------------
function parseSchedulingConfig(business) {
  if (!business.scheduling_config) return null;
  try {
    return typeof business.scheduling_config === 'string'
      ? JSON.parse(business.scheduling_config)
      : business.scheduling_config;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Function declarations (Gemini tools format)
// ---------------------------------------------------------------------------
const SCHEDULING_FUNCTION_DECLARATIONS = [
  {
    name: 'get_services',
    description: 'Retrieve the list of available services or appointment types.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'check_availability',
    description: 'Check available time slots for a specific date.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        date: { type: Type.STRING, description: 'Date to check in YYYY-MM-DD format' },
        service_id: { type: Type.STRING, description: 'The service ID from get_services (call get_services first to obtain this)' },
      },
      required: ['date'],
    },
  },
  {
    name: 'book_appointment',
    description: 'Book a specific time slot for the customer. Use slot_id if available from a recent check_availability call, otherwise provide date + time + service_id to book directly.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        slot_id: { type: Type.STRING, description: 'The short slot ID (e.g. s1, s2) from availability results' },
        customer_name: { type: Type.STRING, description: 'The customer\'s real name (ask them if unknown — never guess or make up a name)' },
        date: { type: Type.STRING, description: 'Date in YYYY-MM-DD format (used when slot_id is unavailable)' },
        time: { type: Type.STRING, description: 'Time in HH:MM format, 24h (used when slot_id is unavailable)' },
        service_id: { type: Type.STRING, description: 'The service ID from get_services (used when slot_id is unavailable)' },
      },
      required: ['customer_name'],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel an existing appointment by its booking ID.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        booking_id: { type: Type.STRING, description: 'The booking ID of the appointment to cancel' },
      },
      required: ['booking_id'],
    },
  },
  {
    name: 'get_my_appointments',
    description: 'Retrieve the customer\'s existing appointments from the scheduling system.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: {
          type: Type.STRING,
          description: 'Filter by status: "upcoming" (default), "past", or "cancelled"',
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// getSchedulingTools — returns tools config for Gemini model, or undefined
// ---------------------------------------------------------------------------
function getSchedulingTools(business) {
  if (!canAccess(business, 'scheduling')) return undefined;
  const schedulingConfig = parseSchedulingConfig(business);
  if (!schedulingConfig?.provider) return undefined;

  return [{ functionDeclarations: SCHEDULING_FUNCTION_DECLARATIONS }];
}

// ---------------------------------------------------------------------------
// getServicesWithCache — fetch services from cache or provider
// ---------------------------------------------------------------------------
async function getServicesWithCache(provider, businessId) {
  const cached = serviceCache.getCachedServices(businessId);
  if (cached) return cached;

  const services = await provider.getServices();
  serviceCache.cacheServices(businessId, services);
  return services;
}

// ---------------------------------------------------------------------------
// buildSchedulingSystemPrompt — short prompt replacing verbose marker syntax
// ---------------------------------------------------------------------------
function buildSchedulingSystemPrompt(business) {
  if (!canAccess(business, 'scheduling')) return null;
  const schedulingConfig = parseSchedulingConfig(business);
  if (!schedulingConfig?.provider) return null;

  const cachedServices = serviceCache.getCachedServices(business.id);
  let servicesInstruction;
  if (cachedServices && cachedServices.length > 0) {
    const list = cachedServices.map(s => {
      const duration = s.duration ? ` (${s.duration} min)` : '';
      return `${s.title || s.name}${duration}, ID: ${s.id}`;
    }).join('; ');
    servicesInstruction = `Available services: ${list}. Use these service IDs directly when checking availability or booking — no need to call get_services unless the customer asks to refresh the list.`;
  } else {
    servicesInstruction = 'When a customer asks to book, first call get_services to discover the available appointment types (services) and their durations. Present the options to the customer so they can choose, unless they already specified what they want.';
  }

  return `

## SCHEDULING INSTRUCTIONS

You can help customers schedule, view, and cancel appointments using the provided scheduling tools.

${servicesInstruction}

Once a service is chosen, use its service ID when checking availability.

### RULE 1 — CRITICAL BOOKING RULE
1. You MUST call the book_appointment function to actually create a booking.
2. NEVER generate a booking confirmation message without first calling book_appointment and receiving a success response.
3. If you tell the customer their appointment is confirmed without calling book_appointment, the appointment DOES NOT EXIST — the customer will show up and have no appointment. This is a serious error.
4. After book_appointment succeeds, use ONLY the returned start_time, end_time, and service_name in your confirmation message. Do NOT paraphrase or convert the times yourself.

### RULE 2 — CUSTOMER NAME RULE
1. Before calling book_appointment, you MUST know the customer's real name.
2. If you do not already know it from the conversation or customer memory, ASK the customer for their name first.
3. NEVER guess, invent, or make up a name.

### Presentation Guidelines
- When presenting services to the customer, translate service names to the customer's language. Keep the original name only if it is a proper noun or brand name that would look unnatural translated.
- When presenting available time slots, list them compactly separated by commas on one line (e.g. "09:00, 09:30, 10:00, 10:30") instead of one per line.
- Always guide the customer helpfully.

### Existing Appointments
When a customer asks about their existing appointments, ALWAYS call get_my_appointments — never rely on conversation history or memory. The scheduling system is the single source of truth for appointment data. Conversation history may be outdated or incorrect.`;
}

// ---------------------------------------------------------------------------
// executeSchedulingFunction — routes function calls to provider methods
// ---------------------------------------------------------------------------
async function executeSchedulingFunction(functionCall, provider, business, customerPhone) {
  const cacheKey = `${business.id}:${customerPhone}`;
  const tz = getTimezone(business);

  switch (functionCall.name) {
    case 'get_services': {
      const services = await getServicesWithCache(provider, business.id);
      return { services };
    }

    case 'check_availability': {
      const { date, service_id } = functionCall.args;
      const services = await getServicesWithCache(provider, business.id);

      // Validate service_id against real services
      const match = service_id && services.find((s) => s.id === service_id);
      if (!match) {
        return {
          error: service_id
            ? `Unknown service_id "${service_id}". Pick a valid one from the list.`
            : 'service_id is required. Pick one from the list.',
          services,
        };
      }

      const serviceName = match.title || match.name || null;
      const slots = await provider.getAvailableSlots(date, match.id);
      if (slots.length === 0) {
        return {
          date,
          available_slots: [],
          suggestion: `No availability on ${date}. Try checking the next or previous day.`,
        };
      }
      // Attach serviceName to each slot before caching so book_appointment can use it
      const slotsWithService = slots.map((s) => ({ ...s, serviceName }));
      const cached = slotCache.cacheSlots(cacheKey, slotsWithService);
      const available_slots = cached.map((s) => ({
        slot_id: s.shortId,
        start_time: s.start,
        end_time: s.end || null,
        formatted_start: formatSlotTime(s.start, tz),
        formatted_end: s.end ? formatSlotTime(s.end, tz) : null,
        service_name: s.serviceName || null,
      }));
      return { date, available_slots };
    }

    case 'book_appointment': {
      const { slot_id, customer_name, date, time, service_id } = functionCall.args;
      let slot = slot_id ? slotCache.resolveSlot(cacheKey, slot_id) : null;
      let serviceName = slot?.serviceName || null;

      // Fallback: resolve slot by date + time + service_id when cache is empty
      if (!slot && date && time && service_id) {
        const normalizedTime = normalizeTimeToHHMM(time);
        if (!normalizedTime) {
          return { error: `Could not parse time "${time}". Please use HH:MM 24-hour format (e.g. "09:00", "14:30").` };
        }
        const services = await getServicesWithCache(provider, business.id);
        const match = services.find((s) => s.id === service_id);
        if (!match) {
          return { error: `Unknown service_id "${service_id}".`, services };
        }
        serviceName = match.title || match.name || null;
        const slots = await provider.getAvailableSlots(date, match.id);
        const target = normalizedTime.replace(':', '');
        slot = slots.find((s) => {
          const slotTime = formatSlotTime(s.start, tz).replace(':', '');
          return slotTime === target;
        });
        if (!slot) {
          if (slots.length > 0) {
            const availableTimes = slots.map((s) => formatSlotTime(s.start, tz)).join(', ');
            return {
              error: `No available slot at ${time} on ${date} for this service.`,
              available_times: availableTimes,
              suggestion: `Available times on ${date}: ${availableTimes}. Suggest one of these to the customer.`,
            };
          }
          return {
            error: `No available slot at ${time} on ${date} for this service.`,
            suggestion: `No availability on ${date}. Try checking the next or previous day.`,
          };
        }
        // Attach serviceName for the booking result
        slot = { ...slot, serviceName };
      }

      if (!slot) {
        return { error: 'Could not resolve slot. Provide slot_id from check_availability, or date + time + service_id.' };
      }

      const memory = db.getCustomerMemory(business.id, customerPhone);
      const customerInfo = {
        name: customer_name || memory?.facts?.name || 'Customer',
        phone: customerPhone,
      };

      const booking = await provider.bookAppointment(slot, customerInfo);

      slotCache.clearSlots(cacheKey);

      const startTime = booking.start || slot.start;
      const endTime = booking.end || slot.end || null;

      return {
        success: true,
        start_time: startTime,
        end_time: endTime,
        formatted_start_time: formatSlotTime(startTime, tz),
        formatted_end_time: endTime ? formatSlotTime(endTime, tz) : null,
        service_name: serviceName || slot.serviceName || null,
        customer_name: customerInfo.name,
      };
    }

    case 'get_my_appointments': {
      const { status } = functionCall.args || {};
      const bookings = await provider.getBookings(customerPhone, {
        status: status || 'upcoming',
      });

      if (bookings.length === 0) {
        return { appointments: [], message: 'No appointments found.' };
      }

      return {
        appointments: bookings.map(b => ({
          booking_id: b.bookingId,
          service: b.title || 'Appointment',
          start_time: b.start,
          end_time: b.end || null,
          formatted_start: formatSlotTime(b.start, tz),
          formatted_end: b.end ? formatSlotTime(b.end, tz) : null,
          status: b.status,
        })),
      };
    }

    case 'cancel_appointment': {
      const { booking_id } = functionCall.args;
      await provider.cancelAppointment(booking_id);
      return { success: true, booking_id };
    }

    default:
      return { error: `Unknown scheduling function: ${functionCall.name}` };
  }
}

// ---------------------------------------------------------------------------
// Utilities (moved from markers.js)
// ---------------------------------------------------------------------------
function getTimezone(business) {
  const cfg = parseSchedulingConfig(business);
  return cfg?.timezone || 'Asia/Jerusalem';
}

/**
 * Check if an ISO string includes timezone info (Z or ±HH:MM offset).
 * Naive timestamps (no suffix) are assumed to already be in the business timezone.
 */
function isTimezoneAware(isoString) {
  return /Z$|[+-]\d{2}:?\d{2}$/.test(isoString);
}

function formatSlotTime(isoString, tz = 'Asia/Jerusalem') {
  try {
    // Naive timestamps (from internal provider) are already in business timezone —
    // extract HH:MM directly to avoid server-timezone-dependent Date parsing shifts.
    if (!isTimezoneAware(isoString)) {
      const timePart = isoString.includes('T') ? isoString.split('T')[1] : isoString;
      const match = timePart.match(/^(\d{2}):(\d{2})/);
      if (match) return `${match[1]}:${match[2]}`;
    }
    return new Date(isoString).toLocaleString('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch (_) {
    return isoString;
  }
}

/**
 * Normalize various time formats to HH:MM (24h).
 * Handles: "09:00", "9:00", "0900", "2:30 PM", "14:30", "2:30PM", "12:00 AM".
 * Returns null if the format is unparseable.
 */
function normalizeTimeToHHMM(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const t = timeStr.trim();

  // Try HH:MM or H:MM with optional AM/PM
  const colonMatch = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (colonMatch) {
    let hours = parseInt(colonMatch[1], 10);
    const minutes = parseInt(colonMatch[2], 10);
    const ampm = colonMatch[3];
    if (ampm) {
      if (ampm.toUpperCase() === 'PM' && hours < 12) hours += 12;
      if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;
    }
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }
    return null;
  }

  // Try HHMM (4 digits, no colon)
  const fourDigitMatch = t.match(/^(\d{4})$/);
  if (fourDigitMatch) {
    const hours = parseInt(t.slice(0, 2), 10);
    const minutes = parseInt(t.slice(2), 10);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }
    return null;
  }

  return null;
}

function invalidateServicesCache(businessId) {
  const geminiCache = require('../gemini-cache');
  if (businessId) {
    serviceCache.invalidateServices(businessId);
    geminiCache.markInvalid(businessId);
  } else {
    serviceCache.invalidateAll();
    geminiCache.markAllInvalid();
  }
}

module.exports = {
  parseSchedulingConfig,
  getSchedulingTools,
  buildSchedulingSystemPrompt,
  executeSchedulingFunction,
  invalidateServicesCache,
  normalizeTimeToHHMM,
  formatSlotTime,
  isTimezoneAware,
};
