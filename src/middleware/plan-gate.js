'use strict';

const BUSINESS_ONLY_FEATURES = ['scheduling', 'knowledge_gaps', 'google_calendar', 'booking_notifications'];

/**
 * Check if a business can access a specific feature based on their subscription plan.
 * Trial gets full Business-tier access.
 */
function canAccess(business, feature) {
  const plan = business.subscription_plan || 'trial';
  if (plan === 'expired') return false;
  if (plan === 'trial' || plan === 'business') return true;
  // plan === 'starter'
  return !BUSINESS_ONLY_FEATURES.includes(feature);
}

/**
 * Get the scraper page limit based on plan.
 * Starter: 20 pages, Business/Trial: use config default.
 */
function getScraperPageLimit(business, configDefault) {
  const plan = business.subscription_plan || 'trial';
  if (plan === 'starter') return Math.min(20, configDefault);
  return configDefault;
}

module.exports = { canAccess, getScraperPageLimit };
