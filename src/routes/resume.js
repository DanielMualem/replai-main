const { Router } = require('express');
const db = require('../services/db');
const { sendMessage, getEscalationMessage } = require('../services/whatsapp');

const { escapeHtml } = require('../utils');

const router = Router();

function renderPage(title, body) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: #fff; border-radius: 12px; padding: 2rem; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,.1); max-width: 320px; }
  h2 { margin: 0 0 .5rem; font-size: 1.2rem; }
  p { color: #666; margin: .25rem 0; }
  button, .btn { display: inline-block; margin-top: 1rem; padding: .75rem 1.5rem; background: #25D366; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; border: none; cursor: pointer; font-size: 1rem; }
  button:hover, .btn:hover { background: #1da851; }
</style>
</head><body>
<div class="card">${body}</div>
</body></html>`;
}

// Landing page — confirm resume bot
router.get('/resume/:id', (req, res) => {
  const escalation = db.getEscalation(req.params.id);

  if (!escalation) {
    return res.status(404).send(renderPage('Not Found', '<h2>Link not found</h2><p>This link is invalid or has expired.</p>'));
  }

  if (escalation.status !== 'active') {
    return res.send(renderPage('Already Resolved', '<h2>Already resolved</h2><p>This escalation has already been closed. The bot is active.</p>'));
  }

  res.send(renderPage('Resume Bot', `
  <h2>Resume Bot</h2>
  <p>Click below to close the escalation and return the customer to the AI assistant.</p>
  <form method="POST" action="/resume/${escapeHtml(req.params.id)}">
    <button type="submit">Resume Bot</button>
  </form>`));
});

// Process resume — resolve escalation and notify customer
router.post('/resume/:id', async (req, res) => {
  const escalation = db.getEscalation(req.params.id);

  if (!escalation) {
    return res.status(404).send(renderPage('Not Found', '<h2>Link not found</h2><p>This link is invalid or has expired.</p>'));
  }

  if (escalation.status !== 'active') {
    return res.send(renderPage('Already Resolved', '<h2>Already resolved</h2><p>This escalation was already closed.</p>'));
  }

  const business = db.getBusiness(escalation.business_id);
  if (!business) {
    return res.status(404).send(renderPage('Error', '<h2>Business not found</h2><p>The associated business no longer exists.</p>'));
  }

  db.resolveEscalation(escalation.id);

  // Notify customer that they're back to AI
  const lastConv = db.getConversation(business.id, escalation.customer_phone);
  const lastMsg = lastConv?.messages?.slice(-1)?.[0]?.content || '';
  const backMsg = getEscalationMessage('backToAI', lastMsg);

  try {
    await sendMessage(business.phone_number_id, business.whatsapp_access_token, escalation.customer_phone, backMsg);
  } catch {
    // Best effort — escalation is already resolved
  }

  res.send(renderPage('Done', '<h2>Bot resumed</h2><p>The customer has been returned to the AI assistant.</p>'));
});

module.exports = router;
