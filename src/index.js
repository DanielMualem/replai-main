const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');
const logger = require('./logger');
const webhookRoutes = require('./routes/webhook');
const calendarRoutes = require('./routes/calendar');
const resumeRoutes = require('./routes/resume');
const signupRoutes = require('./routes/signup');
const facebookDeletionRoutes = require('./routes/facebook-deletion');
const authRoutes = require('./routes/auth');
const googleCalendarRoutes = require('./routes/google-calendar');
const adminRoutes = require('./routes/admin');
const db = require('./services/db');
const { checkExpiredEscalations, checkStaleEscalations } = require('./services/whatsapp');
const { cleanCsrfStates } = require('./routes/auth');
const { cleanExpired: cleanExpiredSlots } = require('./services/scheduling/slot-cache');

// --- Sentry error tracking (optional) ---
if (config.sentryDsn) {
  const Sentry = require('@sentry/node');
  Sentry.init({ dsn: config.sentryDsn });
  logger.info('Sentry error tracking enabled');
}

const app = express();

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));

// Admin dashboard
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(cookieParser());

app.get('/health', (_req, res) => {
  try {
    db.db.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptime: process.uptime() });
  } catch {
    res.status(503).json({ status: 'error' });
  }
});

app.use(express.json({
  limit: '100kb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.use((req, _res, next) => {
  req.id = crypto.randomUUID();
  req.log = logger.child({ requestId: req.id });
  req.log.info({ method: req.method, url: req.url }, 'request');
  next();
});

// Webhook routes first (no /api prefix, no admin auth)
app.use(webhookRoutes);

// Calendar .ics download (public, no auth)
app.use(calendarRoutes);

// Resume bot link (public, no auth)
app.use(resumeRoutes);

// WhatsApp Embedded Signup (public, no admin auth)
app.use(signupRoutes);

// Facebook Data Deletion Callback (public, no admin auth)
app.use(facebookDeletionRoutes);

// Google Calendar OAuth (public, no admin auth)
app.use(googleCalendarRoutes);

// Auth routes (public, no admin auth)
app.use('/auth', authRoutes);

app.use('/api', adminRoutes);

app.use((err, req, res, _next) => {
  const log = req.log || logger;
  log.error({ error: err.message, stack: err.stack }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error', requestId: req.id });
});

// --- Startup checks (before listening) ---

db.cleanExpiredSessions();

if (!config.whatsappAppSecret) {
  if (process.env.NODE_ENV === 'production') {
    logger.fatal('WHATSAPP_APP_SECRET is required in production — refusing to start without webhook signature verification');
    process.exit(1);
  }
  logger.warn('WHATSAPP_APP_SECRET is not set — webhook signature verification is disabled. Set it in .env for production.');
}
if (!config.tokenEncryptionKey) {
  if (process.env.NODE_ENV === 'production') {
    logger.fatal('TOKEN_ENCRYPTION_KEY is required in production — refusing to start without token encryption');
    process.exit(1);
  }
  logger.warn('TOKEN_ENCRYPTION_KEY is not set — WhatsApp tokens will be stored in plaintext. Set it in .env for production.');
}
const hasAdminAuth = config.adminApiKey || (config.googleClientId && config.googleClientSecret);
if (!hasAdminAuth) {
  if (process.env.NODE_ENV === 'production') {
    logger.fatal('No admin auth configured — set ADMIN_API_KEY or Google OAuth (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET) in production');
    process.exit(1);
  }
  logger.warn('No admin auth configured — dashboard is open. Set ADMIN_API_KEY or Google OAuth for production.');
}
if (config.googleClientId && config.googleClientSecret && config.googleAllowedEmails.length === 0) {
  if (process.env.NODE_ENV === 'production') {
    logger.fatal('Google OAuth configured but GOOGLE_ALLOWED_EMAILS is empty — all logins will be rejected');
    process.exit(1);
  }
  logger.warn('Google OAuth configured but GOOGLE_ALLOWED_EMAILS is empty — all logins will be rejected.');
}

if (config.facebookAppId && (!config.facebookAppSecret || !config.systemUserAccessToken)) {
  logger.warn('FACEBOOK_APP_ID is set but FACEBOOK_APP_SECRET or SYSTEM_USER_ACCESS_TOKEN is missing — WhatsApp Embedded Signup will not work.');
}

if (!config.telegramBotToken) {
  const businesses = db.listBusinesses();
  const withTelegram = businesses.filter(b => b.boss_telegram_chat_id);
  if (withTelegram.length > 0) {
    logger.warn({ count: withTelegram.length }, 'TELEGRAM_BOT_TOKEN is not set but some businesses have boss_telegram_chat_id configured — boss notifications will not be sent');
  }
}

const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port }, 'Aiyelet server started');
});

// Periodic maintenance (hourly)
const maintenanceInterval = setInterval(async () => {
  try {
    await checkExpiredEscalations();
    await checkStaleEscalations();
    db.cleanExpiredSessions();
    cleanCsrfStates();
    db.deleteOldConversations(config.conversationTtlDays);
    cleanExpiredSlots();
    db.cleanExpiredInvites();
    db.cleanOldDeletionRequests();
    db.cleanExpiredTelegramLinks();
    db.cleanExpiredGoogleCalendarInvites();
    // Expire trials that have passed their trial_ends_at date
    const expiredTrials = db.expireTrials();
    if (expiredTrials.length > 0) {
      logger.info({ expired: expiredTrials.map(t => ({ id: t.id, name: t.name })) }, 'Expired trials');
    }
  } catch (err) {
    logger.error({ error: err.message }, 'Periodic maintenance failed');
  }
}, 60 * 60 * 1000);

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception — shutting down');
  shutdown('uncaughtException');
});

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');

  clearInterval(maintenanceInterval);
  db.db.close();
  server.close(() => process.exit(0));

  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
