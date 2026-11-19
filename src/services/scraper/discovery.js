const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const config = require('../../config');
const logger = require('../../logger');

const SKIP_EXTENSIONS = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv',
  '.css', '.js', '.json', '.xml', '.rss', '.atom',
  '.woff', '.woff2', '.ttf', '.eot',
]);

const SKIP_PATHS = new Set([
  'login', 'signin', 'signup', 'register', 'logout',
  'admin', 'wp-admin', 'wp-login', 'dashboard',
  'cart', 'checkout', 'account', 'my-account',
  'search', 'feed', 'rss', 'api',
]);

const PAGE_TYPE_PATTERNS = {
  home: /^\/$/,
  about: /\/(about|who-we-are|our-story|our-team|team|staff|company)/i,
  services: /\/(services|what-we-do|offerings|solutions|capabilities)/i,
  pricing: /\/(pricing|prices|plans|rates|cost|packages)/i,
  faq: /\/(faq|faqs|frequently-asked|questions|help|support)/i,
  contact: /\/(contact|get-in-touch|reach-us|locations?|find-us|directions)/i,
  menu: /\/(menu|food-menu|our-menu|dishes|carte)/i,
  gallery: /\/(gallery|portfolio|our-work|projects|showcase|photos)/i,
  policy: /\/(privacy|terms|conditions|legal|disclaimer|policy|cookie|gdpr|tos|refund|return)/i,
};

const SCORE_MAP = {
  home: 50,
  about: 40,
  services: 40,
  pricing: 40,
  faq: 40,
  contact: 40,
  menu: 35,
  gallery: 25,
  reviews: 25,
  policy: 20,
  general: 10,
};

async function discoverPages(websiteUrl, maxPages) {
  const origin = new URL(websiteUrl).origin;
  const disallowPatterns = [];
  let crawlDelay = 0;
  const sitemapUrls = new Set();
  const allUrls = new Map(); // url -> { priority, source }

  // 1. Parse robots.txt
  try {
    const robotsData = await parseRobotsTxt(origin);
    disallowPatterns.push(...robotsData.disallow);
    crawlDelay = robotsData.crawlDelay;
    for (const sm of robotsData.sitemaps) sitemapUrls.add(sm);
  } catch (err) {
    logger.debug({ error: err.message }, 'Could not fetch robots.txt');
  }

  // 2. Parse sitemaps
  if (sitemapUrls.size === 0) {
    sitemapUrls.add(`${origin}/sitemap.xml`);
  }
  for (const smUrl of sitemapUrls) {
    try {
      const urls = await parseSitemap(smUrl, origin);
      for (const { url, priority } of urls) {
        const normalized = normalizeUrl(url);
        if (normalized.startsWith(origin) && isUrlAllowed(normalized, disallowPatterns)) {
          allUrls.set(normalized, { priority: priority || 0.5, source: 'sitemap' });
        }
      }
    } catch (err) {
      logger.debug({ url: smUrl, error: err.message }, 'Could not parse sitemap');
    }
  }

  // 3. BFS from homepage
  const visited = new Set();
  const queue = [websiteUrl];
  const bfsLimit = maxPages * 3; // Discover more than we need, then filter
  const htmlCache = new Map(); // url -> html string (avoid re-fetching during scrape)

  while (queue.length > 0 && visited.size < bfsLimit) {
    const url = queue.shift();
    const normalized = normalizeUrl(url);
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    if (!normalized.startsWith(origin)) continue;
    if (!isUrlAllowed(normalized, disallowPatterns)) continue;
    if (shouldSkipUrl(normalized, origin)) continue;

    if (!allUrls.has(normalized)) {
      allUrls.set(normalized, { priority: 0.5, source: 'bfs' });
    }

    try {
      const response = await axios.get(normalized, {
        timeout: config.scraper.timeoutMs,
        headers: { 'User-Agent': config.scraper.userAgent },
        maxRedirects: 3,
      });
      const contentType = response.headers['content-type'] || '';
      if (!contentType.includes('text/html')) continue;

      const html = response.data;
      htmlCache.set(normalized, { html, headers: response.headers });

      const $ = cheerio.load(html);
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        try {
          const resolved = new URL(href, normalized).href.split('#')[0].split('?')[0];
          if (resolved.startsWith(origin) && !visited.has(resolved) && !shouldSkipUrl(resolved, origin)) {
            queue.push(resolved);
          }
        } catch (_e) { /* ignore bad URLs */ }
      });

      if (crawlDelay > 0) {
        await new Promise((r) => setTimeout(r, crawlDelay * 1000));
      }
    } catch (err) {
      logger.debug({ url: normalized, error: err.message }, 'BFS fetch failed');
    }
  }

  // 4. Score and sort
  const scored = [];
  for (const [url, data] of allUrls) {
    const score = scoreUrl(url, origin, data.priority);
    const pageType = classifyPageType(url, origin);
    scored.push({ url, score, pageType, sitemapPriority: data.priority });
  }

  scored.sort((a, b) => b.score - a.score);

  // Always include homepage
  const homepage = scored.find((s) => s.pageType === 'home');
  if (homepage) {
    // Move to front
    scored.splice(scored.indexOf(homepage), 1);
    scored.unshift(homepage);
  }

  const result = scored.slice(0, maxPages);
  logger.info({ discovered: allUrls.size, selected: result.length, cached: htmlCache.size }, 'URL discovery complete');
  return { urls: result, crawlDelay, disallowPatterns, htmlCache };
}

function scoreUrl(url, origin, sitemapPriority) {
  let score = 0;
  const pathname = new URL(url).pathname;

  const pageType = classifyPageType(url, origin);
  score += SCORE_MAP[pageType] || SCORE_MAP.general;

  // Menu / hours / schedule patterns
  if (/\/(menu|hours|schedule)/i.test(pathname)) score += 35;
  // Team / staff patterns (if not already caught by about)
  if (/\/(team|staff|people)/i.test(pathname) && pageType !== 'about') score += 30;
  // Reviews / testimonials
  if (/\/(reviews?|testimonials?)/i.test(pathname)) score += 25;

  // Shallow depth bonus
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length <= 1) score += 15;
  else if (segments.length <= 2) score += 10;
  else if (segments.length <= 3) score += 5;

  // Blog/news/article penalty
  if (/\/(blog|news|articles?|archive|category|tag|author|press)/i.test(pathname)) score -= 20;

  // Incorporate sitemap priority
  score += (sitemapPriority || 0.5) * 10;

  return score;
}

function shouldSkipUrl(url, origin) {
  try {
    const parsed = new URL(url);

    // External
    if (parsed.origin !== origin) return true;

    const pathname = parsed.pathname.toLowerCase();

    // File extensions
    const ext = pathname.match(/\.\w+$/)?.[0];
    if (ext && SKIP_EXTENSIONS.has(ext)) return true;

    // Skip paths
    const segments = pathname.split('/').filter(Boolean);
    for (const seg of segments) {
      if (SKIP_PATHS.has(seg.toLowerCase())) return true;
    }

    // Pagination beyond page 2
    if (/\/page\/([3-9]|\d{2,})\/?$/i.test(pathname)) return true;
    if (/[?&]page=([3-9]|\d{2,})/i.test(url)) return true;

    return false;
  } catch {
    return true;
  }
}

function classifyPageType(url, origin) {
  const pathname = new URL(url).pathname;

  let bestType = null;
  let bestScore = -1;

  for (const [type, pattern] of Object.entries(PAGE_TYPE_PATTERNS)) {
    if (pattern.test(pathname)) {
      const score = SCORE_MAP[type] || SCORE_MAP.general;
      if (score >= bestScore) {
        bestScore = score;
        bestType = type;
      }
    }
  }

  return bestType || 'general';
}

async function parseRobotsTxt(origin) {
  const response = await axios.get(`${origin}/robots.txt`, {
    timeout: config.scraper.timeoutMs,
    headers: { 'User-Agent': config.scraper.userAgent },
    validateStatus: (s) => s < 400,
  });

  const text = response.data;
  const sitemaps = [];
  const disallow = [];
  let crawlDelay = 0;
  let inRelevantBlock = false;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const [directive, ...rest] = trimmed.split(':');
    const value = rest.join(':').trim();
    const lower = directive.toLowerCase();

    if (lower === 'user-agent') {
      inRelevantBlock = value === '*' || value.toLowerCase().includes('replai');
    } else if (lower === 'sitemap') {
      sitemaps.push(value);
    } else if (inRelevantBlock && lower === 'disallow' && value) {
      disallow.push(value);
    } else if (inRelevantBlock && lower === 'crawl-delay') {
      crawlDelay = parseFloat(value) || 0;
    }
  }

  return { sitemaps, disallow, crawlDelay };
}

async function parseSitemap(sitemapUrl, origin, depth = 0) {
  if (depth > 2) return []; // prevent deep recursion on nested sitemap indexes

  // Validate sitemap URL belongs to same origin (prevent SSRF)
  try {
    const parsed = new URL(sitemapUrl);
    if (parsed.origin !== origin) return [];
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return [];
  } catch { return []; }

  const response = await axios.get(sitemapUrl, {
    timeout: config.scraper.timeoutMs,
    headers: { 'User-Agent': config.scraper.userAgent },
    validateStatus: (s) => s < 400,
  });

  const $ = cheerio.load(response.data, { xmlMode: true });
  const urls = [];

  // Handle sitemap index
  const sitemapLocs = $('sitemapindex sitemap loc');
  if (sitemapLocs.length > 0) {
    const subSitemaps = [];
    sitemapLocs.each((_, el) => subSitemaps.push($(el).text().trim()));
    for (const sub of subSitemaps.slice(0, 15)) {
      try {
        const subUrls = await parseSitemap(sub, origin, depth + 1);
        urls.push(...subUrls);
      } catch (_e) { /* skip broken sub-sitemaps */ }
    }
    return urls;
  }

  // Regular sitemap
  $('urlset url').each((_, el) => {
    const loc = $(el).find('loc').text().trim();
    const priority = parseFloat($(el).find('priority').text()) || 0.5;
    if (loc) urls.push({ url: loc, priority });
  });

  return urls;
}

function isUrlAllowed(url, disallowPatterns) {
  if (disallowPatterns.length === 0) return true;
  const pathname = new URL(url).pathname;
  for (const pattern of disallowPatterns) {
    if (pattern === '/') return false; // Disallow all
    if (!pattern.includes('*')) {
      // Simple prefix match (standard robots.txt behavior)
      if (pathname.startsWith(pattern)) return false;
    } else {
      // Wildcard match: split on '*' and check segments appear in order
      const parts = pattern.split('*');
      let pos = 0;
      let matched = true;
      for (const part of parts) {
        if (!part) continue; // empty segment from leading/trailing/consecutive *
        const idx = pathname.indexOf(part, pos);
        if (idx === -1) { matched = false; break; }
        pos = idx + part.length;
      }
      // First segment must match from start if pattern doesn't start with *
      if (matched && parts[0] && !pathname.startsWith(parts[0])) matched = false;
      if (matched) return false;
    }
  }
  return true;
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    // Remove trailing slash (except root), fragment, common tracking params
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    return `${parsed.origin}${pathname}`;
  } catch {
    return url;
  }
}

module.exports = { discoverPages, scoreUrl, shouldSkipUrl, classifyPageType, parseRobotsTxt, parseSitemap, isUrlAllowed };
