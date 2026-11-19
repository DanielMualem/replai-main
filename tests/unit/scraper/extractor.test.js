const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const { extractPageContent, extractStructuredText, extractFAQs, extractMetadata, extractJsonLd, extractHoursFromText, truncateAtBoundary } = require('../../../src/services/scraper/extractor');

// ---------------------------------------------------------------------------
// truncateAtBoundary(text, maxLen)
// ---------------------------------------------------------------------------
describe('truncateAtBoundary', () => {
  it('returns short text unchanged when under maxLen', () => {
    const text = 'Hello world';
    assert.equal(truncateAtBoundary(text, 100), 'Hello world');
  });

  it('cuts at paragraph boundary (\\n\\n) when possible', () => {
    const text = 'First paragraph with some content.\n\nSecond paragraph here.\n\nThird paragraph that pushes over the limit.';
    const result = truncateAtBoundary(text, 70);
    assert.ok(result.endsWith('Second paragraph here.'), `Expected paragraph cut, got: "${result}"`);
    assert.ok(!result.includes('Third paragraph'));
  });

  it('cuts at sentence boundary (". ") when no paragraph boundary in range', () => {
    const text = 'First sentence here. Second sentence here. Third sentence that is long enough to push us well past the maximum length limit for this test case.';
    const result = truncateAtBoundary(text, 80);
    assert.ok(result.endsWith('.'), `Expected sentence cut ending with period, got: "${result}"`);
    assert.ok(!result.includes('Third sentence'));
  });

  it('cuts at word boundary as last resort', () => {
    // No paragraph breaks, no sentence breaks (". ") — just words
    const text = 'word ' .repeat(30).trim();
    const result = truncateAtBoundary(text, 50);
    assert.ok(!result.endsWith(' '), 'Should not end with a space');
    assert.ok(result.length <= 50);
    // Should have cut at a space boundary (full words only)
    assert.ok(result.endsWith('word'), `Expected word boundary cut, got: "${result}"`);
  });
});

// ---------------------------------------------------------------------------
// extractFAQs($)
// ---------------------------------------------------------------------------
describe('extractFAQs', () => {
  it('extracts FAQs from JSON-LD FAQPage schema', () => {
    const $ = cheerio.load(`<html><head>
      <script type="application/ld+json">{
        "@type": "FAQPage",
        "mainEntity": [
          {"@type": "Question", "name": "What is ReplAI?", "acceptedAnswer": {"text": "An AI chatbot service."}},
          {"@type": "Question", "name": "How much does it cost?", "acceptedAnswer": {"text": "Contact us for pricing."}}
        ]
      }</script>
    </head><body></body></html>`);

    const faqs = extractFAQs($);
    assert.equal(faqs.length, 2);
    assert.equal(faqs[0].question, 'What is ReplAI?');
    assert.equal(faqs[0].answer, 'An AI chatbot service.');
    assert.equal(faqs[1].question, 'How much does it cost?');
    assert.equal(faqs[1].answer, 'Contact us for pricing.');
  });

  it('extracts FAQs from <details>/<summary> elements', () => {
    const $ = cheerio.load(`<html><body>
      <details>
        <summary>How do I sign up?</summary>
        <p>Visit our registration page.</p>
      </details>
    </body></html>`);

    const faqs = extractFAQs($);
    assert.equal(faqs.length, 1);
    assert.equal(faqs[0].question, 'How do I sign up?');
    assert.ok(faqs[0].answer.includes('Visit our registration page'));
  });

  it('extracts FAQs from accordion class elements', () => {
    const $ = cheerio.load(`<html><body>
      <div class="faq-item">
        <div class="question">What payment methods do you accept?</div>
        <div class="answer">We accept credit cards and PayPal.</div>
      </div>
    </body></html>`);

    const faqs = extractFAQs($);
    assert.equal(faqs.length, 1);
    assert.equal(faqs[0].question, 'What payment methods do you accept?');
    assert.equal(faqs[0].answer, 'We accept credit cards and PayPal.');
  });

  it('extracts FAQs from <dl>/<dt>/<dd> elements', () => {
    const $ = cheerio.load(`<html><body>
      <dl>
        <dt>What are your hours?</dt>
        <dd>We are open 9am to 5pm weekdays.</dd>
        <dt>Where are you located?</dt>
        <dd>123 Main Street, Tel Aviv.</dd>
      </dl>
    </body></html>`);

    const faqs = extractFAQs($);
    assert.equal(faqs.length, 2);
    assert.equal(faqs[0].question, 'What are your hours?');
    assert.equal(faqs[0].answer, 'We are open 9am to 5pm weekdays.');
    assert.equal(faqs[1].question, 'Where are you located?');
    assert.equal(faqs[1].answer, '123 Main Street, Tel Aviv.');
  });

  it('extracts FAQs from question headings (h2/h3 ending with ?)', () => {
    const $ = cheerio.load(`<html><body>
      <h2>Do you offer refunds?</h2>
      <p>Yes, within 30 days of purchase.</p>
      <h2>Other Section</h2>
      <p>This is not a FAQ.</p>
    </body></html>`);

    const faqs = extractFAQs($);
    assert.equal(faqs.length, 1);
    assert.equal(faqs[0].question, 'Do you offer refunds?');
    assert.equal(faqs[0].answer, 'Yes, within 30 days of purchase.');
  });

  it('deduplicates questions that appear from multiple sources', () => {
    const $ = cheerio.load(`<html><head>
      <script type="application/ld+json">{
        "@type": "FAQPage",
        "mainEntity": [
          {"@type": "Question", "name": "What is the return policy?", "acceptedAnswer": {"text": "30 day returns."}}
        ]
      }</script>
    </head><body>
      <dl>
        <dt>What is the return policy?</dt>
        <dd>30 day returns for all items.</dd>
      </dl>
    </body></html>`);

    const faqs = extractFAQs($);
    assert.equal(faqs.length, 1, 'Duplicate FAQ question should appear only once');
  });

  it('returns empty array for page with no FAQs', () => {
    const $ = cheerio.load('<html><body><p>Just a plain page.</p></body></html>');
    const faqs = extractFAQs($);
    assert.deepEqual(faqs, []);
  });
});

// ---------------------------------------------------------------------------
// extractMetadata($)
// ---------------------------------------------------------------------------
describe('extractMetadata', () => {
  it('finds phone numbers from itemprop="telephone"', () => {
    const $ = cheerio.load('<html><body><span itemprop="telephone">+972-50-123-4567</span></body></html>');
    const meta = extractMetadata($);
    assert.ok(meta.phones.includes('+972-50-123-4567'));
  });

  it('finds emails from itemprop="email"', () => {
    const $ = cheerio.load('<html><body><span itemprop="email">info@example.com</span></body></html>');
    const meta = extractMetadata($);
    assert.ok(meta.emails.includes('info@example.com'));
  });

  it('finds phone numbers from tel: links', () => {
    const $ = cheerio.load('<html><body><a href="tel:+15551234567">Call us</a></body></html>');
    const meta = extractMetadata($);
    assert.ok(meta.phones.includes('+15551234567'));
  });

  it('finds emails from mailto: links', () => {
    const $ = cheerio.load('<html><body><a href="mailto:support@example.com">Email us</a></body></html>');
    const meta = extractMetadata($);
    assert.ok(meta.emails.includes('support@example.com'));
  });

  it('finds phone numbers via regex from body text', () => {
    const $ = cheerio.load('<html><body><p>Call us at +1-555-123-4567 for support.</p></body></html>');
    const meta = extractMetadata($);
    assert.ok(meta.phones.some(p => p.includes('555-123-4567')), `Expected phone in ${JSON.stringify(meta.phones)}`);
  });

  it('filters out false-positive emails ending in image/script extensions', () => {
    const $ = cheerio.load(`<html><body>
      <p>Contact: real@example.com icon@image.png bg@style.css tracker@code.js photo@site.jpg</p>
    </body></html>`);
    const meta = extractMetadata($);
    assert.ok(meta.emails.includes('real@example.com'));
    assert.ok(!meta.emails.some(e => e.endsWith('.png')), 'Should filter .png emails');
    assert.ok(!meta.emails.some(e => e.endsWith('.jpg')), 'Should filter .jpg emails');
    assert.ok(!meta.emails.some(e => e.endsWith('.js')), 'Should filter .js emails');
    assert.ok(!meta.emails.some(e => e.endsWith('.css')), 'Should filter .css emails');
  });
});

// ---------------------------------------------------------------------------
// extractHoursFromText / hours in extractMetadata
// ---------------------------------------------------------------------------
describe('extractHoursFromText', () => {
  it('extracts hours from Hebrew abbreviated days (borochov pattern)', () => {
    const $ = cheerio.load(`<html><body>
      <div>שעות פתיחה:</div>
      <div>א'-ה' 09:30-18:00</div>
      <div>ו' + ערב חג 09:00-15:00</div>
    </body></html>`);
    const meta = extractMetadata($);
    assert.equal(meta.hours.length, 2);
    assert.ok(meta.hours.some(h => h.includes("א'") && h.includes('09:30-18:00')));
    assert.ok(meta.hours.some(h => h.includes("ו'") && h.includes('09:00-15:00')));
  });

  it('extracts hours with Hebrew day range using en-dash', () => {
    const $ = cheerio.load(`<html><body><p>א'–ה' 08:00–17:00</p></body></html>`);
    const meta = extractMetadata($);
    assert.equal(meta.hours.length, 1);
    assert.ok(meta.hours[0].includes('08:00'));
    assert.ok(meta.hours[0].includes('17:00'));
  });

  it('extracts hours from Hebrew full day names', () => {
    const $ = cheerio.load(`<html><body>
      <p>ראשון-חמישי 09:00-18:00</p>
      <p>שישי 09:00-14:00</p>
    </body></html>`);
    const meta = extractMetadata($);
    assert.ok(meta.hours.some(h => h.includes('ראשון') && h.includes('09:00-18:00')));
    assert.ok(meta.hours.some(h => h.includes('שישי') && h.includes('09:00-14:00')));
  });

  it('extracts hours from English day names', () => {
    const $ = cheerio.load(`<html><body>
      <p>Sunday-Thursday: 09:00-17:00</p>
      <p>Friday: 09:00-14:00</p>
    </body></html>`);
    const meta = extractMetadata($);
    assert.ok(meta.hours.some(h => h.includes('Sunday-Thursday') && h.includes('09:00-17:00')));
    assert.ok(meta.hours.some(h => h.includes('Friday') && h.includes('09:00-14:00')));
  });

  it('extracts hours from abbreviated English day names', () => {
    const $ = cheerio.load(`<html><body><p>Mon-Fri 8:00-17:00</p></body></html>`);
    const meta = extractMetadata($);
    assert.equal(meta.hours.length, 1);
    assert.ok(meta.hours[0].includes('Mon-Fri'));
  });

  it('does not produce false positives from phone numbers', () => {
    const $ = cheerio.load(`<html><body>
      <p>Call us at 054-1234567 or 03-9876543</p>
    </body></html>`);
    const meta = extractMetadata($);
    assert.equal(meta.hours.length, 0);
  });

  it('extracts hours from inside widget elements (before DOM stripping)', () => {
    const $ = cheerio.load(`<html><body>
      <div class="widget-hours">
        <p>א'-ה' 10:00-20:00</p>
      </div>
      <main><p>Main content</p></main>
    </body></html>`);
    const meta = extractMetadata($);
    assert.equal(meta.hours.length, 1);
    assert.ok(meta.hours[0].includes('10:00-20:00'));
  });

  it('works with extractHoursFromText directly', () => {
    const hours = [];
    extractHoursFromText("Opening hours: Sunday-Thursday 9:00-18:00 Friday 9:00-13:00", hours);
    assert.equal(hours.length, 2);
  });

  it('deduplicates identical hour entries', () => {
    const hours = [];
    extractHoursFromText("א'-ה' 09:00-17:00 footer: א'-ה' 09:00-17:00", hours);
    assert.equal(hours.length, 1);
  });
});

// ---------------------------------------------------------------------------
// extractJsonLd($)
// ---------------------------------------------------------------------------
describe('extractJsonLd', () => {
  it('returns array with single JSON-LD object', () => {
    const $ = cheerio.load(`<html><head>
      <script type="application/ld+json">{"@type": "Organization", "name": "Acme"}</script>
    </head><body></body></html>`);

    const results = extractJsonLd($);
    assert.equal(results.length, 1);
    assert.equal(results[0]['@type'], 'Organization');
    assert.equal(results[0].name, 'Acme');
  });

  it('returns flattened array when JSON-LD contains an array', () => {
    const $ = cheerio.load(`<html><head>
      <script type="application/ld+json">[
        {"@type": "Organization", "name": "Acme"},
        {"@type": "WebSite", "name": "Acme Site"}
      ]</script>
    </head><body></body></html>`);

    const results = extractJsonLd($);
    assert.equal(results.length, 2);
    assert.equal(results[0]['@type'], 'Organization');
    assert.equal(results[1]['@type'], 'WebSite');
  });

  it('gracefully returns empty array for invalid JSON', () => {
    const $ = cheerio.load(`<html><head>
      <script type="application/ld+json">{ not valid json !!!</script>
    </head><body></body></html>`);

    const results = extractJsonLd($);
    assert.deepEqual(results, []);
  });
});

// ---------------------------------------------------------------------------
// extractPageContent($, url)
// ---------------------------------------------------------------------------
describe('extractPageContent', () => {
  it('extracts title from <title> tag', () => {
    const $ = cheerio.load('<html><head><title>My Page Title</title></head><body><p>Content</p></body></html>');
    const result = extractPageContent($, 'https://example.com');
    assert.equal(result.title, 'My Page Title');
  });

  it('falls back to og:title when no <title>', () => {
    const $ = cheerio.load(`<html><head>
      <meta property="og:title" content="OG Title Here">
    </head><body><p>Content</p></body></html>`);
    const result = extractPageContent($, 'https://example.com');
    assert.equal(result.title, 'OG Title Here');
  });

  it('falls back to h1 when no <title> or og:title', () => {
    const $ = cheerio.load('<html><head></head><body><h1>Heading Title</h1><p>Content</p></body></html>');
    const result = extractPageContent($, 'https://example.com');
    assert.equal(result.title, 'Heading Title');
  });

  it('extracts description from meta description tag', () => {
    const $ = cheerio.load(`<html><head>
      <title>Test</title>
      <meta name="description" content="A page about testing.">
    </head><body><p>Content</p></body></html>`);
    const result = extractPageContent($, 'https://example.com');
    assert.equal(result.description, 'A page about testing.');
  });

  it('merges JSON-LD LocalBusiness phone into metadata.phones', () => {
    const $ = cheerio.load(`<html><head>
      <title>Test Biz</title>
      <script type="application/ld+json">{
        "@type": "LocalBusiness",
        "name": "Test Biz",
        "telephone": "+1-800-555-0000"
      }</script>
    </head><body><p>Welcome</p></body></html>`);
    const result = extractPageContent($, 'https://example.com');
    assert.ok(result.metadata.phones.includes('+1-800-555-0000'), `Expected phone in metadata, got: ${JSON.stringify(result.metadata.phones)}`);
  });
});

// ---------------------------------------------------------------------------
// extractStructuredText($)
// ---------------------------------------------------------------------------
describe('extractStructuredText', () => {
  it('converts headings to markdown format', () => {
    const $ = cheerio.load('<html><body><h1>Main Title</h1><h2>Subtitle</h2><p>Text here.</p></body></html>');
    const result = extractStructuredText($);
    assert.ok(result.text.includes('# Main Title'), `Expected markdown h1, got: "${result.text}"`);
    assert.ok(result.text.includes('## Subtitle'), `Expected markdown h2, got: "${result.text}"`);
  });

  it('converts list items to "- item" format', () => {
    const $ = cheerio.load('<html><body><ul><li>Apple</li><li>Banana</li></ul></body></html>');
    const result = extractStructuredText($);
    assert.ok(result.text.includes('- Apple'), `Expected "- Apple", got: "${result.text}"`);
    assert.ok(result.text.includes('- Banana'), `Expected "- Banana", got: "${result.text}"`);
  });

  it('removes nav and cookie elements (UNWANTED_SELECTORS)', () => {
    const $ = cheerio.load(`<html><body>
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <div class="cookie-notice">We use cookies.</div>
      <main><p>Main content here.</p></main>
    </body></html>`);
    const result = extractStructuredText($);
    assert.ok(result.text.includes('Main content here'), 'Should keep main content');
    assert.ok(!result.text.includes('Home'), 'Should remove nav content');
    assert.ok(!result.text.includes('cookie'), 'Should remove cookie notice');
  });

  it('converts <br> tags to newlines instead of skipping them', () => {
    const $ = cheerio.load('<html><body><p>Line one<br>Line two</p></body></html>');
    const result = extractStructuredText($);
    assert.ok(result.text.includes('Line one'), `Expected "Line one", got: "${result.text}"`);
    assert.ok(result.text.includes('Line two'), `Expected "Line two", got: "${result.text}"`);
    // Verify they are on separate lines, not merged
    assert.ok(result.text.includes('Line one\nLine two'), `Expected separate lines, got: "${result.text}"`);
  });
});

// ---------------------------------------------------------------------------
// Extraction fix: AM/PM hours support
// ---------------------------------------------------------------------------
describe('extractHoursFromText - AM/PM support', () => {
  it('extracts hours with AM/PM format (9AM-5PM)', () => {
    const hours = [];
    extractHoursFromText('Monday-Friday 9AM-5PM', hours);
    assert.equal(hours.length, 1);
    assert.ok(hours[0].includes('9AM-5PM'), `Expected AM/PM hours, got: "${hours[0]}"`);
  });

  it('extracts hours with spaced AM/PM format (9:00 AM - 5:00 PM)', () => {
    const hours = [];
    extractHoursFromText('Sunday-Thursday 9:00 AM - 5:00 PM', hours);
    assert.equal(hours.length, 1);
    assert.ok(hours[0].includes('9:00 AM'), `Expected spaced AM/PM, got: "${hours[0]}"`);
  });

  it('still extracts 24h format (09:00-17:00)', () => {
    const hours = [];
    extractHoursFromText('Mon-Fri 09:00-17:00', hours);
    assert.equal(hours.length, 1);
    assert.ok(hours[0].includes('09:00-17:00'), `Expected 24h format, got: "${hours[0]}"`);
  });
});

// ---------------------------------------------------------------------------
// Extraction fix: Closed/סגור detection
// ---------------------------------------------------------------------------
describe('extractHoursFromText - Closed/סגור detection', () => {
  it('detects "Saturday: Closed" in English', () => {
    const hours = [];
    extractHoursFromText('Saturday: Closed', hours);
    assert.equal(hours.length, 1);
    assert.ok(hours[0].includes('Saturday') && hours[0].toLowerCase().includes('closed'), `Expected Saturday Closed, got: "${hours[0]}"`);
  });

  it('detects Hebrew "שבת: סגור"', () => {
    const hours = [];
    extractHoursFromText('שבת: סגור', hours);
    assert.equal(hours.length, 1);
    assert.ok(hours[0].includes('שבת') && hours[0].includes('סגור'), `Expected שבת סגור, got: "${hours[0]}"`);
  });

  it('detects abbreviated Hebrew day Closed (ו\' - סגור)', () => {
    const hours = [];
    extractHoursFromText("ו' - סגור", hours);
    assert.equal(hours.length, 1);
    assert.ok(hours[0].includes('סגור'), `Expected סגור, got: "${hours[0]}"`);
  });
});

// ---------------------------------------------------------------------------
// Extraction fix: Broadened JSON-LD schema types
// ---------------------------------------------------------------------------
describe('extractPageContent - broadened JSON-LD schema types', () => {
  it('extracts phone from MedicalBusiness JSON-LD', () => {
    const $ = cheerio.load(`<html><head>
      <title>Dr. Smith</title>
      <script type="application/ld+json">{
        "@type": "MedicalBusiness",
        "name": "Dr. Smith Clinic",
        "telephone": "+972-3-555-1234"
      }</script>
    </head><body><p>Welcome</p></body></html>`);
    const result = extractPageContent($, 'https://example.com');
    assert.ok(result.metadata.phones.includes('+972-3-555-1234'), `Expected phone from MedicalBusiness, got: ${JSON.stringify(result.metadata.phones)}`);
  });

  it('extracts email from Dentist JSON-LD', () => {
    const $ = cheerio.load(`<html><head>
      <title>Dentist</title>
      <script type="application/ld+json">{
        "@type": "Dentist",
        "name": "Smile Clinic",
        "email": "info@smile.com"
      }</script>
    </head><body><p>Welcome</p></body></html>`);
    const result = extractPageContent($, 'https://example.com');
    assert.ok(result.metadata.emails.includes('info@smile.com'), `Expected email from Dentist, got: ${JSON.stringify(result.metadata.emails)}`);
  });

  it('skips structural types like WebSite and WebPage', () => {
    const $ = cheerio.load(`<html><head>
      <title>Test</title>
      <script type="application/ld+json">{
        "@type": "WebSite",
        "name": "Test Site",
        "telephone": "+1-800-000-0000"
      }</script>
    </head><body><p>Welcome</p></body></html>`);
    const result = extractPageContent($, 'https://example.com');
    assert.ok(!result.metadata.phones.includes('+1-800-000-0000'), 'Should skip WebSite type');
  });
});

// ---------------------------------------------------------------------------
// Extraction fix: Phone regex max 15 digits
// ---------------------------------------------------------------------------
describe('extractMetadata - phone max digits', () => {
  it('rejects phone-like strings with more than 15 digits', () => {
    const $ = cheerio.load('<html><body><p>ID: 1234567890123456789</p></body></html>');
    const meta = extractMetadata($);
    const longMatch = meta.phones.find(p => p.replace(/\D/g, '').length > 15);
    assert.equal(longMatch, undefined, 'Should reject numbers longer than 15 digits');
  });

  it('accepts phone numbers with up to 15 digits', () => {
    const $ = cheerio.load('<html><body><p>Call +972-50-123-4567</p></body></html>');
    const meta = extractMetadata($);
    assert.ok(meta.phones.length > 0, 'Should accept valid phone numbers');
  });
});

// ---------------------------------------------------------------------------
// Extraction fix: Expanded email false-positive filter
// ---------------------------------------------------------------------------
describe('extractMetadata - expanded email filter', () => {
  it('filters out .gif, .svg, .webp, .woff, .woff2, .ttf, .eot, .jpeg, .ico, .map extensions', () => {
    const $ = cheerio.load(`<html><body><p>
      real@example.com
      icon@image.gif
      bg@site.svg
      photo@img.webp
      font@cdn.woff
      font2@cdn.woff2
      type@cdn.ttf
      type2@cdn.eot
      pic@site.jpeg
      fav@site.ico
      src@site.map
    </p></body></html>`);
    const meta = extractMetadata($);
    assert.ok(meta.emails.includes('real@example.com'), 'Should keep real emails');
    assert.ok(!meta.emails.some(e => e.endsWith('.gif')), 'Should filter .gif');
    assert.ok(!meta.emails.some(e => e.endsWith('.svg')), 'Should filter .svg');
    assert.ok(!meta.emails.some(e => e.endsWith('.webp')), 'Should filter .webp');
    assert.ok(!meta.emails.some(e => e.endsWith('.woff')), 'Should filter .woff');
    assert.ok(!meta.emails.some(e => e.endsWith('.woff2')), 'Should filter .woff2');
    assert.ok(!meta.emails.some(e => e.endsWith('.ttf')), 'Should filter .ttf');
    assert.ok(!meta.emails.some(e => e.endsWith('.eot')), 'Should filter .eot');
    assert.ok(!meta.emails.some(e => e.endsWith('.jpeg')), 'Should filter .jpeg');
    assert.ok(!meta.emails.some(e => e.endsWith('.ico')), 'Should filter .ico');
    assert.ok(!meta.emails.some(e => e.endsWith('.map')), 'Should filter .map');
  });
});

// ---------------------------------------------------------------------------
// Extraction fix: FAQ h5/h6 headings
// ---------------------------------------------------------------------------
describe('extractFAQs - h5/h6 support', () => {
  it('extracts FAQ from h5 heading ending with ?', () => {
    const $ = cheerio.load(`<html><body>
      <h5>Can I cancel my subscription?</h5>
      <p>Yes, you can cancel anytime.</p>
      <h5>Other heading</h5>
    </body></html>`);
    const faqs = extractFAQs($);
    assert.equal(faqs.length, 1);
    assert.equal(faqs[0].question, 'Can I cancel my subscription?');
    assert.equal(faqs[0].answer, 'Yes, you can cancel anytime.');
  });

  it('extracts FAQ from h6 heading ending with ?', () => {
    const $ = cheerio.load(`<html><body>
      <h6>Is there a free trial?</h6>
      <p>Yes, 14 days free.</p>
    </body></html>`);
    const faqs = extractFAQs($);
    assert.equal(faqs.length, 1);
    assert.equal(faqs[0].question, 'Is there a free trial?');
    assert.equal(faqs[0].answer, 'Yes, 14 days free.');
  });
});
