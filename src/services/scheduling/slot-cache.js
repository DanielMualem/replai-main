const SLOT_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Map of "businessId:customerPhone" → { slots: Map<shortId, providerSlotData>, expires: number }
const cache = new Map();

function cleanExpired() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expires < now) cache.delete(key);
  }
}

/**
 * Cache slots for a business+customer pair, assigning short IDs (s1, s2, ...).
 * Returns an array of { shortId, ...slotData } objects.
 */
function cacheSlots(key, slots) {
  cleanExpired();
  const slotMap = new Map();
  const result = [];
  for (let i = 0; i < slots.length; i++) {
    const shortId = `s${i + 1}`;
    slotMap.set(shortId, slots[i]);
    result.push({ shortId, ...slots[i] });
  }
  cache.set(key, { slots: slotMap, expires: Date.now() + SLOT_TTL_MS });
  return result;
}

/**
 * Resolve a short slot ID back to the original provider slot data.
 */
function resolveSlot(key, shortId) {
  const entry = cache.get(key);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.slots.get(shortId) || null;
}

/**
 * Clear cache for a specific key.
 */
function clearSlots(key) {
  cache.delete(key);
}

module.exports = { cacheSlots, resolveSlot, clearSlots, cleanExpired };
