const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const config = require('../../config');
const db = require('../db');
const logger = require('../../logger');
const { discoverPages, classifyPageType } = require('./discovery');
const { extractPageContent, truncateAtBoundary } = require('./extractor');
const { assembleContext } = require('./context');
const { getScraperPageLimit } = require('../../middleware/plan-gate');

async function fetchWithRetry(url, options) {
  try {
    return await axios.get(url, options);
  } catch (err) {
    const isRetryable = !err.response || (err.response && err.response.status >= 500);
    if (isRetryable) {
      await new Promise((r) => setTimeout(r, 2000));
      return await axios.get(url, options);
    }
    throw err;
  }
}

async function startScrape(businessId, options = {}) {
  const business = db.getBusiness(businessId);
  if (!business) throw new Error('Business not found');
  if (!business.website_url) throw new Error('No website_url configured');

  // Check for in-progress scrape
  const existing = db.getInProgressScrapeJob(businessId);
  if (existing) {
    const err = new Error('Scrape already in progress');
    err.status = 409;
    err.jobId = existing.id;
    throw err;
  }

  const job = db.insertScrapeJob(businessId);
  const jobId = job.id;
  const incremental = options.incremental || false;

  // Run the pipeline in the background
  runScrapeJob(jobId, business, incremental).catch((err) => {
    logger.error({ jobId, businessId, error: err.message }, 'Scrape job failed');
    db.updateScrapeJob(jobId, {
      status: 'failed',
      error: err.message,
      completed_at: new Date().toISOString(),
    });
  });

  return job;
}

async function runScrapeJob(jobId, business, incremental) {
  let origin;
  try {
    origin = new URL(business.website_url).origin;
  } catch {
    throw new Error(`Invalid website URL: ${business.website_url}`);
  }

  db.updateScrapeJob(jobId, {
    status: 'in_progress',
    started_at: new Date().toISOString(),
  });

  // 1. Discover pages (plan-based page limit)
  const maxPages = getScraperPageLimit(business, config.scraper.maxPages);
  let discovery;
  try {
    discovery = await discoverPages(business.website_url, maxPages);
  } catch (err) {
    logger.warn({ jobId, error: err.message }, 'Discovery failed, falling back to homepage only');
    discovery = {
      urls: [{ url: business.website_url, score: 50, pageType: 'home' }],
      crawlDelay: 0,
      disallowPatterns: [],
      htmlCache: new Map(),
    };
  }

  const { urls, crawlDelay, htmlCache } = discovery;
  db.updateScrapeJob(jobId, {
    pages_discovered: urls.length,
    total_pages: urls.length,
  });

  // 2. Fetch and extract each page
  let scrapedCount = 0;
  let failedCount = 0;
  const pageMaxChars = config.scraper.pageMaxChars;

  for (const { url, pageType } of urls) {
    let didFullFetch = false;
    try {
      let html;
      let responseHeaders;
      const cached = htmlCache.get(url);

      // Single DB lookup for incremental mode (reused for headers + hash check)
      const existingPage = incremental ? db.getScrapedPageByUrl(business.id, url) : null;

      if (cached && !incremental) {
        // Use HTML cached during BFS discovery (skip re-fetch)
        html = cached.html;
        responseHeaders = cached.headers;
      } else {
        const headers = { 'User-Agent': config.scraper.userAgent };
        if (existingPage) {
          if (existingPage.http_etag) headers['If-None-Match'] = existingPage.http_etag;
          if (existingPage.http_last_modified) headers['If-Modified-Since'] = existingPage.http_last_modified;
        }

        const response = await fetchWithRetry(url, {
          timeout: config.scraper.timeoutMs,
          headers,
          maxRedirects: 3,
          validateStatus: (s) => s < 400 || s === 304,
        });

        // 304 Not Modified — skip
        if (response.status === 304) {
          scrapedCount++;
          db.updateScrapeJob(jobId, { scraped_pages: scrapedCount });
          continue;
        }

        didFullFetch = true;

        const contentType = response.headers['content-type'] || '';
        if (!contentType.includes('text/html')) {
          failedCount++;
          db.updateScrapeJob(jobId, { failed_pages: failedCount });
          continue;
        }

        html = response.data;
        responseHeaders = response.headers;
      }

      const contentHash = crypto.createHash('sha256').update(html).digest('hex');

      // Check content hash for incremental mode
      if (existingPage && existingPage.content_hash === contentHash) {
        scrapedCount++;
        db.updateScrapeJob(jobId, { scraped_pages: scrapedCount });
        continue;
      }

      const $ = cheerio.load(html);
      const extracted = extractPageContent($, url);

      // Truncate content
      const content = truncateAtBoundary(extracted.content, pageMaxChars);

      // Store FAQs in metadata alongside other extracted metadata
      const metadata = {
        ...extracted.metadata,
        faqs: extracted.faqs,
        description: extracted.description,
      };

      db.upsertScrapedPage({
        business_id: business.id,
        url,
        title: extracted.title,
        page_type: pageType || classifyPageType(url, origin),
        content,
        metadata,
        content_hash: contentHash,
        http_last_modified: responseHeaders['last-modified'] || null,
        http_etag: responseHeaders['etag'] || null,
      });

      scrapedCount++;
      db.updateScrapeJob(jobId, { scraped_pages: scrapedCount });
    } catch (err) {
      logger.warn({ url, error: err.message, jobId }, 'Failed to scrape page');
      failedCount++;
      db.updateScrapeJob(jobId, { failed_pages: failedCount });
    }

    // Respect crawl delay only after full HTTP fetches
    if (didFullFetch && crawlDelay > 0) {
      await new Promise((r) => setTimeout(r, crawlDelay * 1000));
    }
  }

  htmlCache.clear(); // free cached HTML

  const status = (failedCount > 0 && failedCount / urls.length > 0.5) ? 'completed_with_errors' : 'completed';
  db.updateScrapeJob(jobId, {
    status,
    completed_at: new Date().toISOString(),
  });

  // Invalidate Gemini cache since scraped content has changed
  const geminiCache = require('../gemini-cache');
  geminiCache.markInvalid(business.id);

  logger.info({ jobId, businessId: business.id, scraped: scrapedCount, failed: failedCount }, 'Scrape job completed');
}

function getScrapeStatus(jobId) {
  return db.getScrapeJob(jobId);
}

function getLatestScrapeStatus(businessId) {
  return db.getLatestScrapeJob(businessId);
}

module.exports = { startScrape, getScrapeStatus, getLatestScrapeStatus, assembleContext };
