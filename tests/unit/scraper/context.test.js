const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { aggregateMetadata, allocateCharBudget } = require('../../../src/services/scraper/context');

describe('aggregateMetadata', () => {
  it('deduplicates phones across pages', () => {
    const pages = [
      { url: 'https://example.com/about', page_type: 'about', content: 'about us', metadata: { phones: ['123-456'], emails: [], addresses: [], hours: [] } },
      { url: 'https://example.com/contact', page_type: 'contact', content: 'contact us', metadata: { phones: ['123-456'], emails: [], addresses: [], hours: [] } },
    ];
    const result = aggregateMetadata(pages);
    assert.deepStrictEqual(result.phones, ['123-456']);
  });

  it('deduplicates emails across pages', () => {
    const pages = [
      { url: 'https://example.com/about', page_type: 'about', content: 'about', metadata: { phones: [], emails: ['info@example.com'], addresses: [], hours: [] } },
      { url: 'https://example.com/contact', page_type: 'contact', content: 'contact', metadata: { phones: [], emails: ['info@example.com'], addresses: [], hours: [] } },
    ];
    const result = aggregateMetadata(pages);
    assert.deepStrictEqual(result.emails, ['info@example.com']);
  });

  it('deduplicates addresses across pages', () => {
    const pages = [
      { url: 'https://example.com/about', page_type: 'about', content: 'about', metadata: { phones: [], emails: [], addresses: ['123 Main St'], hours: [] } },
      { url: 'https://example.com/contact', page_type: 'contact', content: 'contact', metadata: { phones: [], emails: [], addresses: ['123 Main St'], hours: [] } },
    ];
    const result = aggregateMetadata(pages);
    assert.deepStrictEqual(result.addresses, ['123 Main St']);
  });

  it('handles pages with missing metadata (null)', () => {
    const pages = [
      { url: 'https://example.com/about', page_type: 'about', content: 'about', metadata: null },
      { url: 'https://example.com/contact', page_type: 'contact', content: 'contact', metadata: { phones: ['999'], emails: [], addresses: [], hours: [] } },
    ];
    const result = aggregateMetadata(pages);
    assert.deepStrictEqual(result.phones, ['999']);
    assert.deepStrictEqual(result.emails, []);
    assert.deepStrictEqual(result.addresses, []);
    assert.deepStrictEqual(result.hours, []);
  });

  it('handles empty pages array', () => {
    const result = aggregateMetadata([]);
    assert.deepStrictEqual(result.phones, []);
    assert.deepStrictEqual(result.emails, []);
    assert.deepStrictEqual(result.addresses, []);
    assert.deepStrictEqual(result.hours, []);
  });

  it('combines metadata from multiple pages', () => {
    const pages = [
      { url: 'https://example.com/about', page_type: 'about', content: 'about', metadata: { phones: ['111'], emails: ['a@example.com'], addresses: ['Addr 1'], hours: ['Mon-Fri 9-5'] } },
      { url: 'https://example.com/contact', page_type: 'contact', content: 'contact', metadata: { phones: ['222'], emails: ['b@example.com'], addresses: ['Addr 2'], hours: ['Sat 10-2'] } },
    ];
    const result = aggregateMetadata(pages);
    assert.deepStrictEqual(result.phones, ['111', '222']);
    assert.deepStrictEqual(result.emails, ['a@example.com', 'b@example.com']);
    assert.deepStrictEqual(result.addresses, ['Addr 1', 'Addr 2']);
    assert.deepStrictEqual(result.hours, ['Mon-Fri 9-5', 'Sat 10-2']);
  });
});

describe('allocateCharBudget', () => {
  it('gives key pages more budget than general pages', () => {
    const pages = [
      { url: 'https://example.com/', page_type: 'home', content: 'x'.repeat(6000) },
      { url: 'https://example.com/about', page_type: 'about', content: 'x'.repeat(6000) },
      { url: 'https://example.com/blog/a', page_type: 'general', content: 'x'.repeat(6000) },
      { url: 'https://example.com/blog/b', page_type: 'general', content: 'x'.repeat(6000) },
      { url: 'https://example.com/blog/c', page_type: 'general', content: 'x'.repeat(6000) },
    ];
    const budgets = allocateCharBudget(pages, 20000);
    const homeBudget = budgets.get('https://example.com/');
    const aboutBudget = budgets.get('https://example.com/about');
    const generalBudget = budgets.get('https://example.com/blog/a');
    assert.ok(homeBudget > generalBudget, `key page budget (${homeBudget}) should exceed general page budget (${generalBudget})`);
    assert.ok(aboutBudget > generalBudget, `about page budget (${aboutBudget}) should exceed general page budget (${generalBudget})`);
  });

  it('caps policy pages at 2000 per page', () => {
    const pages = [
      { url: 'https://example.com/privacy', page_type: 'policy', content: 'x'.repeat(5000) },
    ];
    const budgets = allocateCharBudget(pages, 30000);
    const policyBudget = budgets.get('https://example.com/privacy');
    assert.ok(policyBudget <= 2000, `policy budget (${policyBudget}) should be at most 2000`);
  });

  it('splits remainder among general pages', () => {
    const pages = [
      { url: 'https://example.com/blog/a', page_type: 'general', content: 'x'.repeat(3000) },
      { url: 'https://example.com/blog/b', page_type: 'general', content: 'x'.repeat(3000) },
    ];
    const totalBudget = 10000;
    const budgets = allocateCharBudget(pages, totalBudget);
    const budgetA = budgets.get('https://example.com/blog/a');
    const budgetB = budgets.get('https://example.com/blog/b');
    // With no key or policy pages consuming budget, general pages split it all
    assert.equal(budgetA, budgetB);
    assert.ok(budgetA > 0, 'general pages should receive positive budget');
  });

  it('handles zero key pages (all budget goes to general/policy)', () => {
    const pages = [
      { url: 'https://example.com/terms', page_type: 'policy', content: 'x'.repeat(3000) },
      { url: 'https://example.com/blog/a', page_type: 'general', content: 'x'.repeat(3000) },
    ];
    const budgets = allocateCharBudget(pages, 20000);
    assert.ok(budgets.has('https://example.com/terms'));
    assert.ok(budgets.has('https://example.com/blog/a'));
    const generalBudget = budgets.get('https://example.com/blog/a');
    assert.ok(generalBudget > 0, 'general page should get some budget when no key pages exist');
  });

  it('handles single page (gets the budget)', () => {
    const pages = [
      { url: 'https://example.com/', page_type: 'home', content: 'x'.repeat(10000) },
    ];
    const budgets = allocateCharBudget(pages, 15000);
    const budget = budgets.get('https://example.com/');
    assert.ok(budget > 0, 'single page should receive budget');
    // Key budget is min(5000, floor(15000 * 0.6 / 1)) = 5000
    assert.equal(budget, 5000);
  });

  // Item 8: menu pages get key-type budget
  it('gives menu pages key-type budget (up to 5000)', () => {
    const pages = [
      { url: 'https://example.com/menu', page_type: 'menu', content: 'x'.repeat(6000) },
      { url: 'https://example.com/blog/a', page_type: 'general', content: 'x'.repeat(6000) },
      { url: 'https://example.com/blog/b', page_type: 'general', content: 'x'.repeat(6000) },
      { url: 'https://example.com/blog/c', page_type: 'general', content: 'x'.repeat(6000) },
      { url: 'https://example.com/blog/d', page_type: 'general', content: 'x'.repeat(6000) },
    ];
    const budgets = allocateCharBudget(pages, 20000);
    const menuBudget = budgets.get('https://example.com/menu');
    const generalBudget = budgets.get('https://example.com/blog/a');
    // menu is a key type (5000 cap) vs general pages splitting the remainder
    assert.ok(menuBudget > generalBudget, `menu budget (${menuBudget}) should exceed general budget (${generalBudget})`);
  });

  // Item 14: budget overflow protection — general pages no longer get a 500-char floor
  it('does not inflate general page budget with artificial 500-char floor', () => {
    const pages = [
      { url: 'https://example.com/', page_type: 'home', content: 'x'.repeat(5000) },
      { url: 'https://example.com/about', page_type: 'about', content: 'x'.repeat(5000) },
      // 10 general pages to dilute the remaining 25% budget
      ...Array.from({ length: 10 }, (_, i) => ({
        url: `https://example.com/blog/${i}`, page_type: 'general', content: 'x'.repeat(5000),
      })),
    ];
    // With totalBudget=5000: key gets 60%=3000 (split 2 pages=1500 each), remaining=2000
    // generalBudgetEach = floor(2000/10) = 200
    // OLD code: Math.max(200, 500) = 500 per general page (total 5000, exceeds budget)
    // NEW code: Math.max(200, 0) = 200 per general page (total 2000, fits budget)
    const budgets = allocateCharBudget(pages, 5000);
    const generalBudget = budgets.get('https://example.com/blog/0');
    assert.ok(generalBudget < 500, `general budget (${generalBudget}) should be below old 500-char floor`);
    assert.equal(generalBudget, 200, `general budget should be 200, got ${generalBudget}`);
  });

  it('returns a Map keyed by page URL with numeric budget values', () => {
    const pages = [
      { url: 'https://example.com/', page_type: 'home', content: 'home content' },
      { url: 'https://example.com/about', page_type: 'about', content: 'about content' },
      { url: 'https://example.com/privacy', page_type: 'policy', content: 'privacy content' },
      { url: 'https://example.com/blog', page_type: 'general', content: 'blog content' },
    ];
    const budgets = allocateCharBudget(pages, 20000);
    assert.ok(budgets instanceof Map, 'should return a Map');
    assert.equal(budgets.size, pages.length);
    for (const page of pages) {
      assert.ok(budgets.has(page.url), `Map should contain key for ${page.url}`);
      assert.equal(typeof budgets.get(page.url), 'number', `budget for ${page.url} should be a number`);
    }
  });
});
