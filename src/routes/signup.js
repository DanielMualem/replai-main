const { Router } = require('express');
const config = require('../config');
const db = require('../services/db');
const logger = require('../logger');
const { validate, whatsappSignupSchema } = require('../validation');

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
  .btn { display: inline-block; margin-top: 1.5rem; padding: .85rem 2rem; background: #1877F2; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; border: none; cursor: pointer; font-size: 1rem; transition: background .2s; }
  .btn:hover { background: #166fe5; }
  .btn:disabled { background: #ccc; cursor: not-allowed; }
  .btn-success { background: #25D366; }
  .btn-success:hover { background: #1da851; }
  .status { margin-top: 1rem; padding: 1rem; border-radius: 8px; display: none; }
  .status.error { display: block; background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
  .status.success { display: block; background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
  .spinner { display: inline-block; width: 20px; height: 20px; border: 3px solid #fff; border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; vertical-align: middle; margin-right: 8px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head><body>
<div class="card">${body}</div>
</body></html>`;
}

// Landing page — WhatsApp signup
router.get('/signup/:token', (req, res) => {
  const invite = db.getSignupInvite(req.params.token);

  if (!invite || !invite.business_active) {
    return res.status(404).send(renderPage('Not Found', '<h2>Link not found</h2><p>This invite link is invalid, expired, or has already been used.</p>'));
  }

  const appId = config.facebookAppId;
  const configId = config.facebookLoginConfigId;

  if (!appId || !configId) {
    return res.status(500).send(renderPage('Configuration Error', '<h2>Setup incomplete</h2><p>WhatsApp Embedded Signup is not fully configured on this server.</p>'));
  }

  const businessName = escapeHtml(invite.business_name);
  const token = escapeHtml(req.params.token);

  res.send(renderPage('Connect WhatsApp - ' + businessName, `
  <div class="logo">Aiyelet</div>
  <h2>Connect WhatsApp</h2>
  <p>Connect a WhatsApp number for <span class="business-name">${businessName}</span></p>

  <button class="btn" id="connect-btn" onclick="launchSignup()">Connect WhatsApp</button>

  <div class="status" id="status"></div>

  <script>
    window.fbAsyncInit = function() {
      FB.init({
        appId: '${escapeHtml(appId)}',
        autoLogAppEvents: true,
        xfbml: false,
        version: 'v25.0'
      });
    };

    (function(d, s, id) {
      var js, fjs = d.getElementsByTagName(s)[0];
      if (d.getElementById(id)) return;
      js = d.createElement(s); js.id = id;
      js.src = 'https://connect.facebook.net/en_US/sdk.js';
      fjs.parentNode.insertBefore(js, fjs);
    }(document, 'script', 'facebook-jssdk'));

    var signupData = {};

    window.addEventListener('message', function(event) {
      if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') return;
      try {
        var data = JSON.parse(event.data);
        if (data.type === 'WA_EMBEDDED_SIGNUP') {
          if (data.event === 'FINISH') {
            signupData.waba_id = data.data.waba_id;
            signupData.phone_number_id = data.data.phone_number_id;
          } else if (data.event === 'CANCEL') {
            showStatus('Signup was cancelled.', 'error');
          }
        }
      } catch (_) {}
    });

    function launchSignup() {
      if (typeof FB === 'undefined') {
        showStatus('Facebook SDK is still loading. Please try again in a moment.', 'error');
        return;
      }

      FB.login(function(response) {
        if (response.authResponse && response.authResponse.code) {
          completeSignup(response.authResponse.code);
        } else {
          showStatus('Login was not completed. Please try again.', 'error');
        }
      }, {
        config_id: '${escapeHtml(configId)}',
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: '',
          sessionInfoVersion: 2
        }
      });
    }

    function completeSignup(code) {
      var btn = document.getElementById('connect-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Connecting...';
      hideStatus();

      var payload = {
        code: code,
        waba_id: signupData.waba_id || '',
        phone_number_id: signupData.phone_number_id || ''
      };

      fetch('/signup/${token}/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
      .then(function(result) {
        if (result.ok) {
          btn.className = 'btn btn-success';
          btn.innerHTML = 'Connected!';
          showStatus('WhatsApp has been connected successfully. You can close this page.', 'success');
        } else {
          btn.disabled = false;
          btn.textContent = 'Connect WhatsApp';
          showStatus(result.data.error || 'Something went wrong. Please try again.', 'error');
        }
      })
      .catch(function() {
        btn.disabled = false;
        btn.textContent = 'Connect WhatsApp';
        showStatus('Network error. Please check your connection and try again.', 'error');
      });
    }

    function showStatus(msg, type) {
      var el = document.getElementById('status');
      el.textContent = msg;
      el.className = 'status ' + type;
    }

    function hideStatus() {
      document.getElementById('status').className = 'status';
    }
  </script>`));
});

// Process signup — exchange code and configure business
router.post('/signup/:token/complete', validate(whatsappSignupSchema), async (req, res) => {
  const invite = db.getSignupInvite(req.params.token);
  if (!invite || !invite.business_active) {
    return res.status(404).json({ error: 'Invalid or expired invite link' });
  }

  const { code, waba_id, phone_number_id } = req.validated;

  if (!config.facebookAppId || !config.facebookAppSecret || !config.systemUserAccessToken) {
    return res.status(500).json({ error: 'WhatsApp Embedded Signup is not fully configured' });
  }

  // Atomically mark invite as used to prevent race conditions
  const consumed = db.markSignupInviteUsed(req.params.token);
  if (!consumed) {
    return res.status(404).json({ error: 'Invalid or expired invite link' });
  }

  const log = req.log || logger;

  try {
    // Step 1: Exchange code for user access token
    const tokenRes = await fetch('https://graph.facebook.com/v25.0/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.facebookAppId,
        client_secret: config.facebookAppSecret,
        code,
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      log.error({ status: tokenRes.status, metaError: tokenData?.error?.message || 'Unknown error' }, 'Failed to exchange code for access token');
      return res.status(502).json({ error: 'Failed to exchange authorization code with Meta' });
    }

    log.info({ waba_id, phone_number_id }, 'Exchanged code for user access token');

    // Step 2: Subscribe WABA to webhooks using System User token
    const subscribeRes = await fetch(`https://graph.facebook.com/v25.0/${waba_id}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.systemUserAccessToken}` },
    });
    const subscribeData = await subscribeRes.json();

    if (!subscribeRes.ok) {
      log.error({ status: subscribeRes.status, metaError: subscribeData?.error?.message || 'Unknown error' }, 'Failed to subscribe WABA to webhooks');
      return res.status(502).json({ error: 'Failed to subscribe WhatsApp Business Account to webhooks' });
    }

    log.info({ waba_id }, 'Subscribed WABA to app webhooks');

    // Step 3: Register phone number for messaging (may already be done by Embedded Signup)
    try {
      const registerRes = await fetch(`https://graph.facebook.com/v25.0/${phone_number_id}/register`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.systemUserAccessToken}`,
          'Content-Type': 'application/json',
        },
        // Standard placeholder PIN for Cloud API registration (required by Meta API)
        body: JSON.stringify({ messaging_product: 'whatsapp', pin: '000000' }),
      });
      const registerData = await registerRes.json();

      if (registerRes.ok) {
        log.info({ phone_number_id }, 'Registered phone number for messaging');
      } else {
        // Non-fatal — Embedded Signup may have already handled this
        log.warn({ status: registerRes.status, metaError: registerData?.error?.message || 'Unknown error' }, 'Phone registration returned error (may already be registered)');
      }
    } catch (regErr) {
      log.warn({ error: regErr.message }, 'Phone registration request failed (non-fatal)');
    }

    // Step 4: Update business record
    db.updateBusiness(invite.business_id, {
      phone_number_id,
      whatsapp_access_token: config.systemUserAccessToken,
      waba_id,
    });

    log.info({ businessId: invite.business_id, waba_id, phone_number_id }, 'WhatsApp Embedded Signup completed');

    res.json({ success: true, message: 'WhatsApp connected successfully' });
  } catch (err) {
    log.error({ error: err.message, stack: err.stack }, 'WhatsApp Embedded Signup failed');
    res.status(500).json({ error: 'Internal error during signup process' });
  }
});

module.exports = router;
