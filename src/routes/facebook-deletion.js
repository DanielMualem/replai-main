const crypto = require('crypto');
const express = require('express');
const { Router } = express;
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
  .code { font-family: monospace; background: #f5f5f5; padding: .25rem .5rem; border-radius: 4px; }
  .status-badge { display: inline-block; padding: .25rem .75rem; border-radius: 12px; font-size: .85rem; font-weight: 600; background: #d1fae5; color: #065f46; }
</style>
</head><body>
<div class="card">${body}</div>
</body></html>`;
}

/**
 * Parse and verify a Facebook signed_request.
 * Returns the decoded payload object, or null if invalid.
 */
function parseSignedRequest(signedRequest, appSecret) {
  const parts = signedRequest.split('.');
  if (parts.length !== 2) return null;

  const [encodedSig, encodedPayload] = parts;

  // Verify HMAC-SHA256
  const expectedSig = crypto
    .createHmac('sha256', appSecret)
    .update(encodedPayload)
    .digest();

  const sig = Buffer.from(encodedSig, 'base64url');

  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    return payload;
  } catch {
    return null;
  }
}

// Facebook Data Deletion Callback
router.post('/facebook-data-deletion', express.urlencoded({ extended: false }), (req, res) => {
  const log = req.log || logger;

  if (!config.facebookAppSecret) {
    log.warn('Data deletion request received but FACEBOOK_APP_SECRET is not configured');
    return res.status(403).json({ error: 'Not configured' });
  }

  const { signed_request } = req.body;
  if (!signed_request) {
    return res.status(400).json({ error: 'Missing signed_request' });
  }

  const payload = parseSignedRequest(signed_request, config.facebookAppSecret);
  if (!payload) {
    log.warn('Data deletion request with invalid signature');
    return res.status(403).json({ error: 'Invalid signature' });
  }

  const userId = payload.user_id;
  const confirmationCode = crypto.randomUUID();

  db.createDataDeletionRequest(confirmationCode, userId);

  log.info({ userId, confirmationCode }, 'Facebook data deletion request processed');

  const baseUrl = config.baseUrl || `${req.protocol}://${req.get('host')}`;
  res.json({
    url: `${baseUrl}/facebook-data-deletion/${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
});

// Data Deletion Status Page
router.get('/facebook-data-deletion/:code', (req, res) => {
  const record = db.getDataDeletionRequest(req.params.code);

  if (!record) {
    return res.status(404).send(renderPage('Not Found', `
      <div class="logo">Aiyelet</div>
      <h2>Not Found</h2>
      <p>No data deletion request found with this confirmation code.</p>
    `));
  }

  res.send(renderPage('Data Deletion Status', `
    <div class="logo">Aiyelet</div>
    <h2>Data Deletion Request</h2>
    <p>Confirmation code: <span class="code">${escapeHtml(record.confirmation_code)}</span></p>
    <p>Status: <span class="status-badge">${escapeHtml(record.status)}</span></p>
    <p>This application does not store any personal Facebook user data. The deletion request has been acknowledged and completed.</p>
  `));
});

module.exports = router;
