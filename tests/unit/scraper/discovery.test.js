const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scoreUrl, shouldSkipUrl, classifyPageType, isUrlAllowed } = require('../../../src/services/scraper/discovery');

const ORIGIN = 'https://example.com';

describe('classifyPageType', () => {
  it('classifies root URL as home', () => {
    assert.equal(classifyPageType(`${ORIGIN}/`, ORIGIN), 'home');
  });

  it('classifies /about as about', () => {
    assert.equal(classifyPageType(`${ORIGIN}/about`, ORIGIN), 'about');
  });

  it('classifies /about-us as about (pattern matches /about/)', () => {
    assert.equal(classifyPageType(`${ORIGIN}/about-us`, ORIGIN), 'about');
  });

  it('classifies /services as services', () => {
    assert.equal(classifyPageType(`${ORIGIN}/services`, ORIGIN), 'services');
  });

  it('classifies /pricing as pricing', () => {
    assert.equal(classifyPageType(`${ORIGIN}/pricing`, ORIGIN), 'pricing');
  });

  it('classifies /faq as faq', () => {
    assert.equal(classifyPageType(`${ORIGIN}/faq`, ORIGIN), 'faq');
  });

  it('classifies /contact as contact', () => {
    assert.equal(classifyPageType(`${ORIGIN}/contact`, ORIGIN), 'contact');
  });

  it('classifies /privacy as policy', () => {
    assert.equal(classifyPageType(`${ORIGIN}/privacy`, ORIGIN), 'policy');
  });

  it('classifies /terms as policy', () => {
    assert.equal(classifyPageType(`${ORIGIN}/terms`, ORIGIN), 'policy');
  });

  it('classifies /random-page as general', () => {
    assert.equal(classifyPageType(`${ORIGIN}/random-page`, ORIGIN), 'general');
  });

  // Item 8: menu and gallery page types
  it('classifies /menu as menu', () => {
    assert.equal(classifyPageType(`${ORIGIN}/menu`, ORIGIN), 'menu');
  });

  it('classifies /food-menu as menu', () => {
    assert.equal(classifyPageType(`${ORIGIN}/food-menu`, ORIGIN), 'menu');
  });

  it('classifies /our-menu as menu', () => {
    assert.equal(classifyPageType(`${ORIGIN}/our-menu`, ORIGIN), 'menu');
  });

  it('classifies /dishes as menu', () => {
    assert.equal(classifyPageType(`${ORIGIN}/dishes`, ORIGIN), 'menu');
  });

  it('classifies /gallery as gallery', () => {
    assert.equal(classifyPageType(`${ORIGIN}/gallery`, ORIGIN), 'gallery');
  });

  it('classifies /portfolio as gallery', () => {
    assert.equal(classifyPageType(`${ORIGIN}/portfolio`, ORIGIN), 'gallery');
  });

  it('classifies /our-work as gallery', () => {
    assert.equal(classifyPageType(`${ORIGIN}/our-work`, ORIGIN), 'gallery');
  });

  it('classifies /showcase as gallery', () => {
    assert.equal(classifyPageType(`${ORIGIN}/showcase`, ORIGIN), 'gallery');
  });

  // Item 9: best-match classification (highest score wins, not first match)
  it('classifies /about/pricing as pricing (same score, later pattern wins)', () => {
    // Multi-segment path matches both about and pricing patterns (both score 40)
    // pricing appears later in patterns, so it wins the tie
    assert.equal(classifyPageType(`${ORIGIN}/about/pricing`, ORIGIN), 'pricing');
  });

  it('classifies /services/faq as faq (same score, later pattern wins)', () => {
    // Multi-segment path matches both services and faq patterns (both score 40)
    assert.equal(classifyPageType(`${ORIGIN}/services/faq`, ORIGIN), 'faq');
  });

  it('classifies /about/menu as about (higher score wins over later match)', () => {
    // about scores 40, menu scores 35 — about wins despite being first
    assert.equal(classifyPageType(`${ORIGIN}/about/menu`, ORIGIN), 'about');
  });
});

describe('scoreUrl', () => {
  it('gives home page a high score', () => {
    // home base (50) + depth bonus for 0 segments (15) + sitemap default (0.5 * 10 = 5) = 70
    const score = scoreUrl(`${ORIGIN}/`, ORIGIN, 0.5);
    assert.ok(score >= 50, `Expected home score >= 50, got ${score}`);
  });

  it('gives about page ~40 base score', () => {
    // about base (40) + depth bonus for 1 segment (15) + sitemap (5) = 60
    const score = scoreUrl(`${ORIGIN}/about`, ORIGIN, 0.5);
    assert.ok(score >= 40, `Expected about score >= 40, got ${score}`);
  });

  it('penalizes blog pages below about pages', () => {
    const blogScore = scoreUrl(`${ORIGIN}/blog`, ORIGIN, 0.5);
    const aboutScore = scoreUrl(`${ORIGIN}/about`, ORIGIN, 0.5);
    assert.ok(blogScore < aboutScore, `Expected blog (${blogScore}) < about (${aboutScore})`);
  });

  it('gives shallow URLs (1 segment) a depth bonus of +15', () => {
    // general base (10) + depth bonus (15) + sitemap (5) = 30
    const shallowScore = scoreUrl(`${ORIGIN}/page`, ORIGIN, 0.5);
    // general base (10) + depth bonus for 4 segments (0) + sitemap (5) = 15
    const deepScore = scoreUrl(`${ORIGIN}/a/b/c/d`, ORIGIN, 0.5);
    assert.ok(shallowScore > deepScore, `Expected shallow (${shallowScore}) > deep (${deepScore})`);
  });

  it('gives less depth bonus to deeper URLs', () => {
    const oneSegment = scoreUrl(`${ORIGIN}/page`, ORIGIN, 0.5);
    const twoSegments = scoreUrl(`${ORIGIN}/page/sub`, ORIGIN, 0.5);
    const threeSegments = scoreUrl(`${ORIGIN}/page/sub/detail`, ORIGIN, 0.5);
    assert.ok(oneSegment > twoSegments, `1 seg (${oneSegment}) should beat 2 seg (${twoSegments})`);
    assert.ok(twoSegments > threeSegments, `2 seg (${twoSegments}) should beat 3 seg (${threeSegments})`);
  });

  it('increases score with higher sitemap priority', () => {
    const lowPriority = scoreUrl(`${ORIGIN}/page`, ORIGIN, 0.1);
    const highPriority = scoreUrl(`${ORIGIN}/page`, ORIGIN, 1.0);
    assert.ok(highPriority > lowPriority, `High priority (${highPriority}) should beat low (${lowPriority})`);
  });

  it('gives menu pages a high score (type bonus + pattern bonus)', () => {
    const menuScore = scoreUrl(`${ORIGIN}/menu`, ORIGIN, 0.5);
    const plainScore = scoreUrl(`${ORIGIN}/other`, ORIGIN, 0.5);
    // menu type (35) + menu pattern bonus (35) vs general (10) = difference of 60
    assert.equal(menuScore - plainScore, 60, 'Menu should score 60 above a similar general page (type 35 + pattern 35 vs general 10)');
  });
});

describe('shouldSkipUrl', () => {
  it('skips external URLs (different origin)', () => {
    assert.equal(shouldSkipUrl('https://other-site.com/page', ORIGIN), true);
  });

  it('skips .pdf file extension', () => {
    assert.equal(shouldSkipUrl(`${ORIGIN}/docs/file.pdf`, ORIGIN), true);
  });

  it('skips .jpg file extension', () => {
    assert.equal(shouldSkipUrl(`${ORIGIN}/images/photo.jpg`, ORIGIN), true);
  });

  it('skips admin paths', () => {
    assert.equal(shouldSkipUrl(`${ORIGIN}/admin/settings`, ORIGIN), true);
  });

  it('skips login paths', () => {
    assert.equal(shouldSkipUrl(`${ORIGIN}/login`, ORIGIN), true);
  });

  it('skips deep pagination (/page/5)', () => {
    assert.equal(shouldSkipUrl(`${ORIGIN}/blog/page/5`, ORIGIN), true);
  });

  it('does not skip normal pages', () => {
    assert.equal(shouldSkipUrl(`${ORIGIN}/about`, ORIGIN), false);
  });

  it('does not skip the home page', () => {
    assert.equal(shouldSkipUrl(`${ORIGIN}/`, ORIGIN), false);
  });
});

describe('isUrlAllowed', () => {
  it('allows URL when there are no disallow patterns', () => {
    assert.equal(isUrlAllowed(`${ORIGIN}/anything`, []), true);
  });

  it('blocks all URLs when pattern is /', () => {
    assert.equal(isUrlAllowed(`${ORIGIN}/anything`, ['/']), false);
  });

  it('blocks URL matching a prefix pattern', () => {
    assert.equal(isUrlAllowed(`${ORIGIN}/admin/dashboard`, ['/admin']), false);
  });

  it('allows URL not matching a prefix pattern', () => {
    assert.equal(isUrlAllowed(`${ORIGIN}/about`, ['/admin']), true);
  });

  it('blocks URL matching a wildcard pattern', () => {
    assert.equal(isUrlAllowed(`${ORIGIN}/doc.pdf`, ['/*.pdf']), false);
  });

  it('allows URL not matching a wildcard pattern', () => {
    assert.equal(isUrlAllowed(`${ORIGIN}/about`, ['/*.pdf']), true);
  });
});
