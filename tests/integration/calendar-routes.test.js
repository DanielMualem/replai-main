const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildApp } = require('../helpers/setup');
const { storeBooking, cache } = require('../../src/services/calendar');

const app = buildApp();

describe('GET /cal/:id (landing page)', () => {
  beforeEach(() => {
    cache.clear();
  });

  it('returns HTML landing page with download link', async () => {
    const id = storeBooking({
      start_time: '2026-03-15T14:00:00+02:00',
      end_time: '2026-03-15T15:00:00+02:00',
      service_name: 'Consultation',
    }, 'Dan', 'TestBiz');

    const res = await request(app).get(`/cal/${id}`);

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /Add to Calendar/);
    assert.match(res.text, new RegExp(`/cal/${id}\\.ics`));
    assert.match(res.text, /Consultation/);
  });

  it('returns 404 for unknown ID', async () => {
    const res = await request(app).get('/cal/nonexistent-id');

    assert.equal(res.status, 404);
    assert.match(res.text, /expired|not found/i);
  });
});

describe('GET /cal/:id.ics', () => {
  beforeEach(() => {
    cache.clear();
  });

  it('returns valid .ics file for a stored booking', async () => {
    const id = storeBooking({
      start_time: '2026-03-15T14:00:00+02:00',
      end_time: '2026-03-15T15:00:00+02:00',
      service_name: 'Consultation',
    }, 'Dan', 'TestBiz');

    const res = await request(app).get(`/cal/${id}.ics`);

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/calendar/);
    assert.match(res.headers['content-disposition'], /inline/);
    assert.match(res.headers['content-disposition'], new RegExp(`${id}\\.ics`));
    assert.match(res.text, /BEGIN:VCALENDAR/);
    assert.match(res.text, /METHOD:PUBLISH/);
    assert.match(res.text, /BEGIN:VEVENT/);
    assert.match(res.text, /Consultation/);
    assert.match(res.text, /END:VCALENDAR/);
  });

  it('returns 404 for unknown ID', async () => {
    const res = await request(app).get('/cal/nonexistent-id.ics');

    assert.equal(res.status, 404);
    assert.match(res.body.error, /not found/i);
  });

  it('returns 404 for expired booking', async () => {
    const id = storeBooking({
      start_time: '2026-03-15T14:00:00Z',
    }, 'Dan', 'TestBiz');

    // Manually expire it
    const entry = cache.get(id);
    entry.expires = Date.now() - 1000;

    const res = await request(app).get(`/cal/${id}.ics`);

    assert.equal(res.status, 404);
  });
});
