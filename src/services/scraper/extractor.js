const { URL } = require('url');
const logger = require('../../logger');

const UNWANTED_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'svg',
  'nav', '[role="navigation"]',
  '[class*="cookie"]', '[id*="cookie"]',
  '[class*="popup"]', '[id*="popup"]',
  '[class*="modal"]', '[id*="modal"]',
  '[class*="overlay"]', '[id*="overlay"]',
  '[class*="banner"]', '[id*="banner"]',
  '[class*="sidebar"]', '[id*="sidebar"]',
  '[class*="widget"]', '[id*="widget"]',
  '[class*="advert"]', '[id*="advert"]',
  '[class*="ad-"]', '[id*="ad-"]',
].join(', ');

const MAIN_CONTENT_SELECTORS = ['main', 'article', '[role="main"]', '#content', '.content', '#main', '.main'];

const PHONE_RE = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const STRUCTURAL_SCHEMA_TYPES = new Set(['WebSite', 'WebPage', 'BreadcrumbList', 'SearchAction', 'SiteNavigationElement']);
const EMAIL_FALSE_POSITIVE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.js', '.css', '.map', '.woff', '.woff2', '.ttf', '.eot']);

function extractPageContent($, url) {
  const title = $('title').text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('h1').first().text().trim() ||
    '';

  const description = $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    '';

  // Extract JSON-LD and FAQs BEFORE extractStructuredText, which removes <script> tags
  const jsonLd = extractJsonLd($);
  const faqs = extractFAQs($);
  const metadata = extractMetadata($);
  const { sections, text: content } = extractStructuredText($);

  // Merge JSON-LD data into metadata
  if (jsonLd.length > 0) {
    for (const item of jsonLd) {
      const type = item['@type'];
      if (!STRUCTURAL_SCHEMA_TYPES.has(type)) {
        if (item.telephone && !metadata.phones.includes(item.telephone)) {
          metadata.phones.push(item.telephone);
        }
        if (item.email && !metadata.emails.includes(item.email)) {
          metadata.emails.push(item.email);
        }
        if (item.address) {
          const addr = typeof item.address === 'string'
            ? item.address
            : [item.address.streetAddress, item.address.addressLocality, item.address.addressRegion, item.address.postalCode]
                .filter(Boolean).join(', ');
          if (addr && !metadata.addresses.includes(addr)) {
            metadata.addresses.push(addr);
          }
        }
        if (item.openingHoursSpecification) {
          const specs = Array.isArray(item.openingHoursSpecification)
            ? item.openingHoursSpecification
            : [item.openingHoursSpecification];
          for (const spec of specs) {
            const days = Array.isArray(spec.dayOfWeek) ? spec.dayOfWeek : [spec.dayOfWeek];
            const hoursStr = `${days.map(d => typeof d === 'string' ? d.replace('http://schema.org/', '') : d).join(', ')}: ${spec.opens || ''}–${spec.closes || ''}`;
            if (!metadata.hours.includes(hoursStr)) {
              metadata.hours.push(hoursStr);
            }
          }
        }
      }
    }
  }

  return { title, description, sections, content, faqs, metadata };
}

function extractStructuredText($) {
  $(UNWANTED_SELECTORS).remove();

  // Find main content area
  let $root = null;
  for (const sel of MAIN_CONTENT_SELECTORS) {
    const $el = $(sel).first();
    if ($el.length > 0) {
      $root = $el;
      break;
    }
  }
  if (!$root) $root = $('body');

  const sections = [];
  let currentSection = { heading: '', level: 0, content: [] };
  const lines = [];

  function walkNode(el) {
    if (!el || !el.children) return;
    for (const child of el.children) {
      if (child.type === 'text') {
        const text = child.data.replace(/\s+/g, ' ').trim();
        if (text) {
          currentSection.content.push(text);
          lines.push(text);
        }
        continue;
      }
      if (child.type !== 'tag') continue;

      const tag = child.tagName.toLowerCase();

      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
        // Save previous section
        if (currentSection.heading || currentSection.content.length > 0) {
          sections.push({ ...currentSection, content: currentSection.content.join('\n') });
        }
        const level = parseInt(tag[1], 10);
        const prefix = '#'.repeat(level);
        const headingText = $(child).text().replace(/\s+/g, ' ').trim();
        currentSection = { heading: headingText, level, content: [] };
        lines.push(`${prefix} ${headingText}`);
      } else if (tag === 'p') {
        // Recurse into children so <br>-converted newlines produce separate lines
        const before = lines.length;
        walkNode(child);
        // If nothing was added by recursion, fall back to text extraction
        if (lines.length === before) {
          const text = $(child).text().replace(/\s+/g, ' ').trim();
          if (text) {
            currentSection.content.push(text);
            lines.push(text);
          }
        }
      } else if (tag === 'li') {
        const text = $(child).text().replace(/\s+/g, ' ').trim();
        if (text) {
          currentSection.content.push(`- ${text}`);
          lines.push(`- ${text}`);
        }
      } else if (tag === 'table') {
        const rows = [];
        $(child).find('tr').each((_, tr) => {
          const cells = [];
          $(tr).find('th, td').each((__, cell) => {
            cells.push($(cell).text().replace(/\s+/g, ' ').trim());
          });
          if (cells.length > 0) rows.push(cells.join(' | '));
        });
        if (rows.length > 0) {
          const tableText = rows.join('\n');
          currentSection.content.push(tableText);
          lines.push(tableText);
        }
      } else {
        walkNode(child);
      }
    }
  }

  // Pre-process: convert <br> tags to newline text nodes
  $root.find('br').replaceWith('\n');

  walkNode($root[0]);

  // Save last section
  if (currentSection.heading || currentSection.content.length > 0) {
    sections.push({ ...currentSection, content: currentSection.content.join('\n') });
  }

  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { sections, text };
}

function extractFAQs($) {
  const faqs = [];
  const seen = new Set();

  function addFaq(q, a) {
    const key = q.toLowerCase().trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    faqs.push({ question: q.trim(), answer: a.trim() });
  }

  // 1. Schema.org FAQPage JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const items = data['@type'] === 'FAQPage' ? data.mainEntity : null;
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item['@type'] === 'Question') {
            addFaq(item.name, item.acceptedAnswer?.text || '');
          }
        }
      }
    } catch (_e) { /* ignore parse errors */ }
  });

  // 2. <details>/<summary> elements
  $('details').each((_, el) => {
    const q = $(el).find('summary').first().text().trim();
    const a = $(el).clone().find('summary').remove().end().text().trim();
    if (q && a) addFaq(q, a);
  });

  // 3. FAQ-related class/id accordion elements
  $('[class*="faq"], [id*="faq"], [class*="accordion"], [class*="question"]').each((_, el) => {
    const $el = $(el);
    // Look for question/answer pairs within
    const q = $el.find('[class*="question"], [class*="title"], .accordion-header, .accordion-button, dt').first().text().trim();
    const a = $el.find('[class*="answer"], [class*="content"], [class*="body"], .accordion-body, .accordion-content, dd').first().text().trim();
    if (q && a) addFaq(q, a);
  });

  // 4. <dl>/<dt>/<dd> patterns
  $('dl').each((_, dl) => {
    $(dl).find('dt').each((__, dt) => {
      const q = $(dt).text().trim();
      const dd = $(dt).next('dd');
      const a = dd.length ? dd.text().trim() : '';
      if (q && a) addFaq(q, a);
    });
  });

  // 5. Headings ending with ? followed by content
  $('h2, h3, h4, h5, h6').each((_, el) => {
    const text = $(el).text().trim();
    if (!text.endsWith('?')) return;
    // Collect following sibling text until next heading
    let answer = '';
    let next = $(el).next();
    while (next.length && !next.is('h1, h2, h3, h4, h5, h6')) {
      answer += next.text().trim() + ' ';
      next = next.next();
    }
    answer = answer.trim();
    if (answer) addFaq(text, answer);
  });

  return faqs;
}

function extractMetadata($) {
  const phones = new Set();
  const emails = new Set();
  const addresses = [];
  const hours = [];

  // itemprop attributes
  $('[itemprop="telephone"]').each((_, el) => {
    const val = $(el).attr('content') || $(el).text().trim();
    if (val) phones.add(val);
  });
  $('[itemprop="email"]').each((_, el) => {
    const val = $(el).attr('content') || $(el).text().trim();
    if (val) emails.add(val);
  });

  // mailto links
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href');
    const email = href.replace('mailto:', '').split('?')[0].trim();
    if (email) emails.add(email);
  });

  // tel links
  $('a[href^="tel:"]').each((_, el) => {
    const href = $(el).attr('href');
    const phone = href.replace('tel:', '').trim();
    if (phone) phones.add(phone);
  });

  // Regex scan of body text
  const bodyText = $('body').text();
  const phoneMatches = bodyText.match(PHONE_RE) || [];
  for (const p of phoneMatches) {
    const cleaned = p.trim();
    const digitCount = cleaned.replace(/\D/g, '').length;
    if (digitCount >= 7 && digitCount <= 15) {
      phones.add(cleaned);
    }
  }
  const emailMatches = bodyText.match(EMAIL_RE) || [];
  for (const e of emailMatches) {
    const ext = '.' + e.split('.').pop().toLowerCase();
    if (!EMAIL_FALSE_POSITIVE_EXTENSIONS.has(ext)) {
      emails.add(e);
    }
  }

  // Text-based hours extraction (fallback when no JSON-LD openingHoursSpecification)
  extractHoursFromText(bodyText, hours);

  // Schema.org PostalAddress
  $('[itemprop="address"]').each((_, el) => {
    const parts = [];
    $(el).find('[itemprop="streetAddress"]').each((__, s) => parts.push($(s).text().trim()));
    $(el).find('[itemprop="addressLocality"]').each((__, s) => parts.push($(s).text().trim()));
    $(el).find('[itemprop="addressRegion"]').each((__, s) => parts.push($(s).text().trim()));
    $(el).find('[itemprop="postalCode"]').each((__, s) => parts.push($(s).text().trim()));
    const addr = parts.filter(Boolean).join(', ');
    if (addr) addresses.push(addr);
  });

  return {
    phones: [...phones],
    emails: [...emails],
    addresses,
    hours,
  };
}

function extractJsonLd($) {
  const results = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      if (Array.isArray(data)) {
        results.push(...data);
      } else if (data && typeof data === 'object') {
        results.push(data);
      }
    } catch (_e) { /* ignore parse errors */ }
  });
  return results;
}

function truncateAtBoundary(text, maxLength) {
  if (!text || text.length <= maxLength) return text;

  // Try to cut at a paragraph boundary
  const truncated = text.slice(0, maxLength);
  const lastDoubleNewline = truncated.lastIndexOf('\n\n');
  if (lastDoubleNewline > maxLength * 0.5) {
    return truncated.slice(0, lastDoubleNewline).trim();
  }

  // Fall back to sentence boundary
  const lastPeriod = truncated.lastIndexOf('. ');
  if (lastPeriod > maxLength * 0.5) {
    return truncated.slice(0, lastPeriod + 1).trim();
  }

  // Fall back to word boundary
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.8) {
    return truncated.slice(0, lastSpace).trim();
  }

  return truncated.trim();
}

function extractHoursFromText(bodyText, hours) {
  const timeRange = '\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM|am|pm)?\\s*[-–—]\\s*\\d{1,2}(?::\\d{2})?\\s*(?:AM|PM|am|pm)?';
  const apo = "'\u05F3\u2019"; // straight apostrophe, Hebrew geresh, right single quote
  const patterns = [
    // Hebrew abbreviated days: א'-ה' 09:30-18:00, ו' + ערב חג 09:00-15:00
    new RegExp(`[אבגדהו][${apo}](?:\\s*[-–]\\s*[אבגדהו][${apo}])?[^\\d]{0,30}?${timeRange}`, 'g'),
    // Hebrew full day names: ראשון-חמישי 09:30-18:00
    new RegExp(`(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)(?:\\s*[-–]\\s*(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת))?[^\\d]{0,30}?${timeRange}`, 'g'),
    // English day names: Sunday-Thursday 09:30-18:00
    new RegExp(`(?:Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?)(?:\\s*[-–]\\s*(?:Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?))?[^\\d]{0,30}?${timeRange}`, 'gi'),
    // Hebrew abbreviated days: Closed/סגור
    new RegExp(`[אבגדהו][${apo}](?:\\s*[-–]\\s*[אבגדהו][${apo}])?\\s*[:：-]?\\s*(?:סגור|Closed)`, 'gi'),
    // Hebrew full day names: Closed/סגור
    new RegExp(`(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)(?:\\s*[-–]\\s*(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת))?\\s*[:：-]?\\s*(?:סגור|Closed)`, 'gi'),
    // English day names: Closed/סגור
    new RegExp(`(?:Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?)(?:\\s*[-–]\\s*(?:Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?))?\\s*[:：-]?\\s*(?:סגור|Closed)`, 'gi'),
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(bodyText)) !== null) {
      const entry = match[0].replace(/\s+/g, ' ').trim();
      if (entry && !hours.includes(entry)) {
        hours.push(entry);
      }
    }
  }
}

module.exports = { extractPageContent, extractStructuredText, extractFAQs, extractMetadata, extractJsonLd, extractHoursFromText, truncateAtBoundary };
