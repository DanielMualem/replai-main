const { Router } = require('express');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const config = require('../config');
const db = require('../services/db');
const logger = require('../logger');
const { escapeHtml } = require('../utils');

const router = Router();

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CSRF_STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const COOKIE_NAME = 'replai_session';

// In-memory CSRF state store with TTL
const csrfStates = new Map();

function isGoogleConfigured() {
  return !!(config.googleClientId && config.googleClientSecret);
}

function getRedirectUri(req) {
  const base = config.baseUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/auth/google/callback`;
}

function getCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || (config.baseUrl ? config.baseUrl.startsWith('https') : false),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  };
}

const CSRF_MAX_STATES = 1000;

// Sweep expired CSRF states and enforce cap
function cleanCsrfStates() {
  const now = Date.now();
  for (const [key, val] of csrfStates) {
    if (val.expires < now) csrfStates.delete(key);
  }
  // If still over cap after expiry sweep, remove oldest entries
  if (csrfStates.size > CSRF_MAX_STATES) {
    const excess = csrfStates.size - CSRF_MAX_STATES;
    let removed = 0;
    for (const key of csrfStates.keys()) {
      if (removed >= excess) break;
      csrfStates.delete(key);
      removed++;
    }
  }
}

// GET /auth/config — tell the frontend what auth methods are available
router.get('/config', (_req, res) => {
  res.json({ google: isGoogleConfigured() });
});

// GET /auth/google — redirect to Google OAuth consent screen
router.get('/google', (req, res) => {
  if (!isGoogleConfigured()) {
    return res.status(404).json({ error: 'Google OAuth not configured' });
  }

  const client = new OAuth2Client(
    config.googleClientId,
    config.googleClientSecret,
    getRedirectUri(req),
  );

  const state = crypto.randomBytes(24).toString('hex');
  cleanCsrfStates();
  csrfStates.set(state, { expires: Date.now() + CSRF_STATE_TTL_MS });

  const url = client.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account',
  });

  res.redirect(url);
});

// GET /auth/google/callback — exchange code for tokens, create session
router.get('/google/callback', async (req, res) => {
  if (!isGoogleConfigured()) {
    return res.status(404).json({ error: 'Google OAuth not configured' });
  }

  const { code, state } = req.query;

  // Verify CSRF state
  if (!state || !csrfStates.has(state)) {
    return res.status(400).send(errorPage('Invalid or expired login attempt. Please try again.'));
  }
  csrfStates.delete(state);

  if (!code) {
    return res.status(400).send(errorPage('No authorization code received from Google.'));
  }

  try {
    const client = new OAuth2Client(
      config.googleClientId,
      config.googleClientSecret,
      getRedirectUri(req),
    );

    const { tokens } = await client.getToken(code);
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: config.googleClientId,
    });

    const payload = ticket.getPayload();
    const email = payload.email?.toLowerCase();

    if (!email) {
      return res.status(400).send(errorPage('Could not retrieve email from Google account.'));
    }

    // Check allowlist (required — empty allowlist blocks all logins)
    if (!config.googleAllowedEmails.includes(email)) {
      logger.warn({ email }, 'Google OAuth login rejected: email not in allowlist');
      return res.status(403).send(errorPage(
        `The email <strong>${escapeHtml(email)}</strong> is not authorized to access this dashboard.`,
      ));
    }

    // Remove any existing sessions for this email to prevent accumulation
    db.deleteSessionsByEmail(email);

    // Create session
    const sessionId = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString().replace('T', ' ').replace('Z', '');
    db.createSession({ id: sessionId, email, expires_at: expiresAt });

    res.cookie(COOKIE_NAME, sessionId, getCookieOptions());
    res.redirect('/admin');
  } catch (err) {
    logger.error({ error: err.message }, 'Google OAuth callback failed');
    res.status(500).send(errorPage('Authentication failed. Please try again.'));
  }
});

// GET /auth/me — return current session info
router.get('/me', (req, res) => {
  const sessionId = req.cookies?.[COOKIE_NAME];
  if (!sessionId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = db.getSession(sessionId);
  if (!session) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return res.status(401).json({ error: 'Session expired' });
  }

  res.json({ email: session.email });
});

// POST /auth/logout — destroy session
router.post('/logout', (req, res) => {
  const sessionId = req.cookies?.[COOKIE_NAME];
  if (sessionId) {
    db.deleteSession(sessionId);
  }
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ success: true });
});


function errorPage(message) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Authentication Error</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f1f5f9;color:#1e293b}
.card{background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1);padding:32px;max-width:400px;text-align:center}
h2{margin:0 0 12px;color:#dc2626}p{margin:0 0 16px;color:#64748b;line-height:1.5}
a{display:inline-block;padding:8px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:500}</style>
</head><body><div class="card"><h2>Access Denied</h2><p>${message}</p><a href="/admin">Back to Dashboard</a></div></body></html>`;
}

module.exports = router;
module.exports.COOKIE_NAME = COOKIE_NAME;
module.exports.cleanCsrfStates = cleanCsrfStates;
