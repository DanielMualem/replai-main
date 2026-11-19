const CalComProvider = require('./providers/cal-com');
const AcuityProvider = require('./providers/acuity');
const CalendlyProvider = require('./providers/calendly');
const SquareProvider = require('./providers/square');
const InternalProvider = require('./providers/internal');
const GoogleCalendarProvider = require('./providers/google-calendar');
const logger = require('../../logger');
const appConfig = require('../../config');
const { parseSchedulingConfig } = require('./tools');

const providers = new Map();

// Register built-in providers
providers.set('cal-com', (config) => new CalComProvider(config));
providers.set('acuity', (config) => new AcuityProvider(config));
providers.set('calendly', (config) => new CalendlyProvider(config));
providers.set('square', (config) => new SquareProvider(config));
providers.set('internal', (config) => new InternalProvider(config));
providers.set('google-calendar', (config) => new GoogleCalendarProvider(config));

/**
 * Register a new scheduling provider factory.
 */
function registerProvider(name, factory) {
  providers.set(name, factory);
}

/**
 * List available provider names.
 */
function listProviders() {
  return Array.from(providers.keys());
}

/**
 * Get a provider instance for a business based on its scheduling_config.
 * Returns null if scheduling is not configured.
 */
function getProvider(business) {
  const config = parseSchedulingConfig(business);
  if (!config) return null;

  if (!config.provider) {
    logger.error({ businessId: business.id }, 'scheduling_config missing provider field');
    return null;
  }

  const factory = providers.get(config.provider);
  if (!factory) {
    logger.error({ businessId: business.id, provider: config.provider }, 'Unknown scheduling provider');
    return null;
  }

  // Inject business_id so providers like 'internal' can access the DB
  config.business_id = business.id;

  // Inject Google OAuth credentials for google-calendar provider
  if (config.provider === 'google-calendar') {
    config.google_client_id = appConfig.googleClientId;
    config.google_client_secret = appConfig.googleClientSecret;
  }

  return factory(config);
}

module.exports = { getProvider, listProviders, registerProvider };
