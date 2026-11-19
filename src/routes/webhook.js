const { Router } = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const config = require('../config');
const logger = require('../logger');
const whatsapp = require('../services/whatsapp');

const router = Router();

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  keyGenerator: (req) => {
    try {
      return req.body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id || ipKeyGenerator(req);
    } catch {
      return ipKeyGenerator(req);
    }
  },
  message: 'Too many requests',
});

// Verify webhook signature from Meta (HMAC-SHA256)
function verifySignature(req, res, next) {
  if (!config.whatsappAppSecret) return next();

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    logger.warn('Webhook request missing x-hub-signature-256 header');
    return res.sendStatus(401);
  }

  const expected = 'sha256=' + crypto.createHmac('sha256', config.whatsappAppSecret)
    .update(req.rawBody)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    logger.warn('Webhook signature verification failed');
    return res.sendStatus(401);
  }

  next();
}

// Meta webhook verification
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.whatsappVerifyToken) {
    logger.info('Webhook verified');
    return res.status(200).send(challenge);
  }

  logger.warn('Webhook verification failed');
  res.sendStatus(403);
});

// Meta webhook incoming messages
router.post('/webhook', webhookLimiter, verifySignature, (req, res) => {
  // Always respond 200 immediately per Meta requirements
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entries = body.entry;
    if (!entries) return;

    for (const entry of entries) {
      const changes = entry.changes;
      if (!changes) continue;

      for (const change of changes) {
        if (change.field !== 'messages') continue;
        const value = change.value;
        if (!value || !value.messages) continue;

        whatsapp.handleIncomingMessage(value).catch((err) => {
          logger.error({ error: err.message }, 'Error handling incoming message');
        });
      }
    }
  } catch (err) {
    logger.error({ error: err.message }, 'Error processing webhook');
  }
});

module.exports = router;
