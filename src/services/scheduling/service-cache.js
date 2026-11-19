const config = require('../../config');

// Map of businessId → { services: Array, expires: number }
const cache = new Map();

function cleanExpired() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expires < now) cache.delete(key);
  }
}

/**
 * Get cached services for a business, or null if cache miss / expired.
 */
function getCachedServices(businessId) {
  const entry = cache.get(businessId);
  if (!entry || entry.expires < Date.now()) {
    if (entry) cache.delete(businessId);
    return null;
  }
  return entry.services;
}

/**
 * Cache services for a business with TTL.
 * Returns the services array.
 */
function cacheServices(businessId, services, ttlMs) {
  cleanExpired();
  const ttl = ttlMs || config.servicesCacheTtlMs;
  cache.set(businessId, { services, expires: Date.now() + ttl });
  return services;
}

/**
 * Invalidate cached services for a specific business.
 */
function invalidateServices(businessId) {
  cache.delete(businessId);
}

/**
 * Invalidate all cached services.
 */
function invalidateAll() {
  cache.clear();
}

module.exports = { getCachedServices, cacheServices, invalidateServices, invalidateAll };
