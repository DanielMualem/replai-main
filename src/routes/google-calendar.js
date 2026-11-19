const { Router } = require('express');
const { OAuth2Client } = require('google-auth-library');
const config = require('../config');
const db = require('../services/db');
const logger = require('../logger');
const { escapeHtml } = require('../utils');

const router = Router();

function renderPage(title, body) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f0f2f5; }
  .card { background: #fff; border-radius: 16px; padding: 2.5rem; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,.08); max-width: 420px; width: 90%; }
  .logo { font-size: 1.5rem; font-weight: 700; color: #1a73e8; margin-bottom: .5rem; }
  h2 { margin: .5rem 0; font-size: 1.3rem; color: #1a1a1a; }
  p { color: #666; margin: .5rem 0; line-height: 1.5; }
  .business-name { font-weight: 600; color: #333; }
  .btn { display: inline-block; margin-top: 1.5rem; padding: .85rem 2rem; background: #4285F4; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; border: none; cursor: pointer; font-size: 1rem; transition: background .2s; }
  .btn:hover { background: #3367d6; }
  .btn-success { background: #25D366; }
  .btn-success:hover { background: #1da851; }
  .status { margin-top: 1rem; padding: 1rem; border-radius: 8px; display: none; }
  .status.error { display: block; background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
  .status.success { display: block; background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
</style>
</head><body>
<div class="card">${body}</div>
</body></html>`;
}

// OAuth callback — must be registered before /:token to avoid Express greedy matching
router.get('/google-calendar/callback', async (req, res) => {
  const { code, state: token, error } = req.query;

  if (error) {
    return res.send(renderPage('Connection Cancelled', '<h2>Connection cancelled</h2><p>Google Calendar was not connected. You can close this page.</p>'));
  }

  if (!code || !token) {
    return res.status(400).send(renderPage('Error', '<h2>Invalid request</h2><p>Missing authorization code or state parameter.</p>'));
  }

  const invite = db.getGoogleCalendarInvite(token);
  if (!invite) {
    return res.status(404).send(renderPage('Not Found', '<h2>Link not found</h2><p>This invite link is invalid, expired, or has already been used.</p>'));
  }

  const log = req.log || logger;

  try {
    const oauth2Client = new OAuth2Client(
      config.googleClientId,
      config.googleClientSecret,
      `${config.baseUrl}/google-calendar/callback`
    );

    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      return res.status(400).send(renderPage('Error', '<h2>Missing permissions</h2><p>Google did not provide offline access. Please try again and ensure you grant all requested permissions.</p>'));
    }

    // Atomically mark invite as used
    const consumed = db.markGoogleCalendarInviteUsed(token);
    if (!consumed) {
      return res.status(404).send(renderPage('Not Found', '<h2>Link already used</h2><p>This invite link has already been used or expired.</p>'));
    }

    // Store refresh_token in business's scheduling_config
    const business = db.getBusiness(invite.business_id);
    if (!business) {
      return res.status(404).send(renderPage('Error', '<h2>Business not found</h2><p>The associated business no longer exists.</p>'));
    }

    let schedulingConfig = {};
    if (business.scheduling_config) {
      try {
        schedulingConfig = typeof business.scheduling_config === 'string'
          ? JSON.parse(business.scheduling_config) : business.scheduling_config;
      } catch (_) { /* start fresh */ }
    }

    schedulingConfig.refresh_token = tokens.refresh_token;
    schedulingConfig.provider = 'google-calendar';
    if (!schedulingConfig.calendar_id) {
      schedulingConfig.calendar_id = 'primary';
    }

    db.updateBusiness(invite.business_id, {
      scheduling_config: JSON.stringify(schedulingConfig),
    });

    log.info({ businessId: invite.business_id }, 'Google Calendar connected via OAuth');

    res.send(renderPage('Connected!', `
    <div class="logo">Aiyelet</div>
    <h2 style="color:#16a34a">Google Calendar Connected!</h2>
    <p>Your Google Calendar has been successfully connected. Aiyelet can now manage appointments.</p>
    <p style="font-size:13px;color:#888">You can close this page.</p>`));
  } catch (err) {
    log.error({ error: err.message, stack: err.stack }, 'Google Calendar OAuth callback failed');
    res.status(500).send(renderPage('Error', '<h2>Connection failed</h2><p>An error occurred while connecting Google Calendar. Please try again or contact support.</p>'));
  }
});

// Landing page — Connect Google Calendar
router.get('/google-calendar/:token', (req, res) => {
  const invite = db.getGoogleCalendarInvite(req.params.token);

  if (!invite) {
    return res.status(404).send(renderPage('Not Found', '<h2>Link not found</h2><p>This invite link is invalid, expired, or has already been used.</p>'));
  }

  if (!config.googleClientId || !config.googleClientSecret || !config.baseUrl) {
    return res.status(500).send(renderPage('Configuration Error', '<h2>Setup incomplete</h2><p>Google Calendar connection is not fully configured on this server.</p>'));
  }

  const oauth2Client = new OAuth2Client(
    config.googleClientId,
    config.googleClientSecret,
    `${config.baseUrl}/google-calendar/callback`
  );

  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: req.params.token,
    prompt: 'consent',
  });

  const businessName = escapeHtml(invite.business_name);

  res.send(renderPage('Connect Google Calendar - ' + businessName, `
  <div class="logo">Aiyelet</div>
  <h2>Connect Google Calendar</h2>
  <p>Connect a Google Calendar for <span class="business-name">${businessName}</span></p>
  <p style="font-size:13px;color:#888">This will allow Aiyelet to check your availability and create appointment events.</p>
  <a class="btn" href="${escapeHtml(authorizeUrl)}">Connect Google Calendar</a>`));
});

module.exports = router;
