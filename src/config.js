const fs = require("fs");
const path = require("path");

require("dotenv").config();

/**
 * Resolve a secret from env var, supporting the _FILE suffix convention.
 * If VAR_FILE is set, reads the secret from that file path (trimmed).
 * Otherwise falls back to VAR. Returns defaultVal if neither is set.
 */
function secret(name, defaultVal = null) {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch (err) {
      // Log to stderr since logger may not be initialized yet
      process.stderr.write(`WARNING: Could not read secret file ${filePath} for ${name}: ${err.message}\n`);
      return defaultVal;
    }
  }
  return process.env[name] || defaultVal;
}

// Warn if .env is world-readable (POSIX only)
try {
  const envPath = path.join(__dirname, '..', '.env');
  const stat = fs.statSync(envPath);
  const worldReadable = stat.mode & 0o004;
  if (worldReadable) {
    process.stderr.write(
      'WARNING: .env file is world-readable. Run: chmod 600 .env\n'
    );
  }
} catch (_) {
  // .env may not exist (e.g. secrets injected via env vars) — that's fine
}

module.exports = {
  host: process.env.HOST || '127.0.0.1',
  port: parseInt(process.env.PORT, 10) || 3000,
  geminiApiKey: secret('GEMINI_API_KEY'),
  defaultGeminiModel: process.env.DEFAULT_GEMINI_MODEL || "gemini-3-flash-preview",
  maxConversationMessages:
    parseInt(process.env.MAX_CONVERSATION_MESSAGES, 10) || 20,
  scraper: {
    maxPages: parseInt(process.env.SCRAPER_MAX_PAGES, 10) || 10,
    timeoutMs: parseInt(process.env.SCRAPER_TIMEOUT_MS, 10) || 10000,
    contextMaxChars: parseInt(process.env.SCRAPER_CONTEXT_MAX_CHARS, 10) || 30000,
    pageMaxChars: parseInt(process.env.SCRAPER_PAGE_MAX_CHARS, 10) || 8000,
    userAgent: process.env.SCRAPER_USER_AGENT || 'Aiyelet-Bot/1.0 (website-scraper)',
  },
  adminApiKey: secret('ADMIN_API_KEY'),
  dbPath: path.join(__dirname, "..", "data", "replai.db"),
  messageBufferMs: parseInt(process.env.MESSAGE_BUFFER_MS, 10) || 5000,
  messageBufferMaxMs: parseInt(process.env.MESSAGE_BUFFER_MAX_MS, 10) || 15000,
  whatsappApiVersion: process.env.WHATSAPP_API_VERSION || "v21.0",
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
  whatsappAppSecret: secret('WHATSAPP_APP_SECRET', ''),
  telegramBotToken: secret('TELEGRAM_BOT_TOKEN'),
  escalationTimeoutHours: parseInt(process.env.ESCALATION_TIMEOUT_HOURS, 10) || 24,
  escalationReminderHours: parseInt(process.env.ESCALATION_REMINDER_HOURS, 10) || 4,
  bossBufferMs: parseInt(process.env.BOSS_BUFFER_MS, 10) || 3000,
  bossBufferMaxMs: parseInt(process.env.BOSS_BUFFER_MAX_MS, 10) || 10000,
  schedulingMaxIterations: parseInt(process.env.SCHEDULING_MAX_ITERATIONS, 10) || 8,
  geminiTimeoutMs: parseInt(process.env.GEMINI_TIMEOUT_MS, 10) || 30000,
  geminiRetries: parseInt(process.env.GEMINI_RETRIES, 10) || 2,
  tokenEncryptionKey: secret('TOKEN_ENCRYPTION_KEY', ''),
  servicesCacheTtlMs: parseInt(process.env.SERVICES_CACHE_TTL_MS, 10) || 24 * 60 * 60 * 1000,
  geminiCacheTtlSeconds: parseInt(process.env.GEMINI_CACHE_TTL_SECONDS, 10) || 86400,
  geminiCacheEnabled: process.env.GEMINI_CACHE_ENABLED !== 'false',
  conversationSummaryThreshold: parseInt(process.env.CONVERSATION_SUMMARY_THRESHOLD, 10) || 20,
  conversationRecentMessages: parseInt(process.env.CONVERSATION_RECENT_MESSAGES, 10) || 10,
  geminiThinkingLevel: process.env.GEMINI_THINKING_LEVEL || 'low',
  conversationTtlDays: parseInt(process.env.CONVERSATION_TTL_DAYS, 10) || 90,
  sentryDsn: secret('SENTRY_DSN'),
  geminiRateLimitPerBusiness: parseInt(process.env.GEMINI_RATE_LIMIT_PER_BUSINESS, 10) || 60,
  baseUrl: process.env.BASE_URL || null,
  googleClientId: process.env.GOOGLE_CLIENT_ID || null,
  googleClientSecret: secret('GOOGLE_CLIENT_SECRET'),
  googleAllowedEmails: process.env.GOOGLE_ALLOWED_EMAILS
    ? process.env.GOOGLE_ALLOWED_EMAILS.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    : [],
  facebookAppId: process.env.FACEBOOK_APP_ID || null,
  facebookAppSecret: secret('FACEBOOK_APP_SECRET'),
  facebookLoginConfigId: process.env.FACEBOOK_LOGIN_CONFIG_ID || null,
  systemUserAccessToken: secret('SYSTEM_USER_ACCESS_TOKEN'),
};
