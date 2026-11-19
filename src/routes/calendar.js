const { Router } = require('express');
const { getBooking, generateIcs } = require('../services/calendar');
const { escapeHtml } = require('../utils');

const router = Router();

// Direct .ics file download (must be before /cal/:id to avoid greedy match)
router.get('/cal/:id.ics', (req, res) => {
  const data = getBooking(req.params.id);
  if (!data) {
    return res.status(404).json({ error: 'Not found or expired' });
  }

  const ics = generateIcs(data);
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `inline; filename="${req.params.id}.ics"`);
  res.send(ics);
});

// Landing page that triggers the .ics download — this is the link sent in WhatsApp
router.get('/cal/:id', (req, res) => {
  const data = getBooking(req.params.id);
  if (!data) {
    return res.status(404).send('<!DOCTYPE html><html><body><p>Link expired or not found.</p></body></html>');
  }

  const { bookingResult, label } = data;
  const service = bookingResult.service_name || 'Appointment';

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Add to Calendar</title>
<style>
  body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: #fff; border-radius: 12px; padding: 2rem; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,.1); max-width: 320px; }
  h2 { margin: 0 0 .5rem; font-size: 1.2rem; }
  p { color: #666; margin: .25rem 0; }
  a { display: inline-block; margin-top: 1rem; padding: .75rem 1.5rem; background: #25D366; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; }
</style>
</head><body>
<div class="card">
  <h2>${escapeHtml(service)}</h2>
  <p>${escapeHtml(label)}</p>
  <a href="/cal/${req.params.id}.ics">Add to Calendar</a>
</div>
<script>window.location.href="/cal/${req.params.id}.ics";</script>
</body></html>`);
});



module.exports = router;
