const db = require('../db');
const config = require('../../config');
const logger = require('../../logger');
const { truncateAtBoundary } = require('./extractor');

// Page type display order and section titles
const SECTION_ORDER = [
  { type: 'home', title: 'ABOUT THE BUSINESS' },
  { type: 'about', title: 'ABOUT' },
  { type: 'services', title: 'SERVICES' },
  { type: 'pricing', title: 'PRICING' },
  { type: 'faq', title: 'FREQUENTLY ASKED QUESTIONS' },
  { type: 'contact', title: 'CONTACT INFORMATION' },
  { type: 'menu', title: 'MENU' },
  { type: 'gallery', title: 'PORTFOLIO / GALLERY' },
  { type: 'policy', title: 'POLICIES' },
  { type: 'general', title: 'ADDITIONAL INFORMATION' },
];

const KEY_TYPES = new Set(['home', 'about', 'services', 'pricing', 'faq', 'contact', 'menu']);

function assembleContext(businessId) {
  const pages = db.getScrapedPages(businessId);
  if (pages.length === 0) return null;

  const totalBudget = config.scraper.contextMaxChars;
  const parts = [];

  // 1. Aggregate metadata across all pages (placed at top — highest value per token)
  const meta = aggregateMetadata(pages);
  const metaSection = formatMetadata(meta);
  if (metaSection) {
    parts.push(`=== BUSINESS INFORMATION ===\n${metaSection}`);
  }

  // 2. Aggregate FAQs from all pages
  const allFaqs = [];
  const seenQuestions = new Set();
  for (const page of pages) {
    if (!page.metadata || !page.metadata.faqs) continue;
    for (const faq of page.metadata.faqs) {
      const key = faq.question.toLowerCase().trim();
      if (!seenQuestions.has(key)) {
        seenQuestions.add(key);
        allFaqs.push(faq);
      }
    }
  }

  // 3. Allocate budgets
  const metaUsed = metaSection ? metaSection.length + 30 : 0;
  const faqBudget = allFaqs.length > 0 ? Math.min(allFaqs.length * 300, 4000) : 0;
  const remainingBudget = totalBudget - metaUsed - faqBudget;
  const budgets = allocateCharBudget(pages, remainingBudget);

  // 4. Build sections by type
  const pagesByType = new Map();
  for (const page of pages) {
    const type = page.page_type || 'general';
    if (!pagesByType.has(type)) pagesByType.set(type, []);
    pagesByType.get(type).push(page);
  }

  for (const { type, title } of SECTION_ORDER) {
    if (type === 'faq') {
      // Insert aggregated FAQs
      if (allFaqs.length > 0) {
        let faqText = '';
        for (const faq of allFaqs) {
          const entry = `Q: ${faq.question}\nA: ${faq.answer}\n`;
          if (faqText.length + entry.length > faqBudget) break;
          faqText += entry + '\n';
        }
        if (faqText.trim()) {
          parts.push(`=== ${title} ===\n${faqText.trim()}`);
        }
      }
      continue;
    }

    const typePages = pagesByType.get(type);
    if (!typePages || typePages.length === 0) continue;

    const sectionParts = [];
    for (const page of typePages) {
      const budget = budgets.get(page.url) || 1000;
      let content = page.content || '';
      if (content.length > budget) {
        content = truncateAtBoundary(content, budget);
      }
      if (content.trim()) {
        if (typePages.length > 1 && page.title) {
          sectionParts.push(`### ${page.title}\n${content}`);
        } else {
          sectionParts.push(content);
        }
      }
    }

    if (sectionParts.length > 0) {
      parts.push(`=== ${title} ===\n${sectionParts.join('\n\n')}`);
    }
  }

  const result = parts.join('\n\n');
  logger.debug({ businessId, contextLength: result.length, pages: pages.length }, 'Context assembled');
  return result || null;
}

function aggregateMetadata(pages) {
  const phones = new Set();
  const emails = new Set();
  const addresses = new Set();
  const hours = [];

  for (const page of pages) {
    if (!page.metadata) continue;
    const m = page.metadata;
    if (m.phones) for (const p of m.phones) phones.add(p);
    if (m.emails) for (const e of m.emails) emails.add(e);
    if (m.addresses) for (const a of m.addresses) addresses.add(a);
    if (m.hours) for (const h of m.hours) {
      if (!hours.includes(h)) hours.push(h);
    }
  }

  return {
    phones: [...phones],
    emails: [...emails],
    addresses: [...addresses],
    hours,
  };
}

function formatMetadata(meta) {
  const parts = [];
  if (meta.phones.length > 0) parts.push(`Phone: ${meta.phones.join(', ')}`);
  if (meta.emails.length > 0) parts.push(`Email: ${meta.emails.join(', ')}`);
  if (meta.addresses.length > 0) parts.push(`Address: ${meta.addresses.join(' | ')}`);
  if (meta.hours.length > 0) parts.push(`Hours: ${meta.hours.join('; ')}`);
  return parts.join('\n');
}

function allocateCharBudget(pages, totalBudget) {
  const budgets = new Map();
  const keyPages = pages.filter((p) => KEY_TYPES.has(p.page_type));
  const policyPages = pages.filter((p) => p.page_type === 'policy');
  const generalPages = pages.filter((p) => !KEY_TYPES.has(p.page_type) && p.page_type !== 'policy');

  const keyBudgetEach = Math.min(5000, Math.floor(totalBudget * 0.6 / Math.max(keyPages.length, 1)));
  const policyBudgetEach = Math.min(2000, Math.floor(totalBudget * 0.15 / Math.max(policyPages.length, 1)));

  let used = 0;
  for (const page of keyPages) {
    const actual = Math.min(keyBudgetEach, (page.content || '').length);
    budgets.set(page.url, keyBudgetEach);
    used += actual;
  }
  for (const page of policyPages) {
    const actual = Math.min(policyBudgetEach, (page.content || '').length);
    budgets.set(page.url, policyBudgetEach);
    used += actual;
  }

  const remaining = Math.max(0, totalBudget - used);
  const generalBudgetEach = generalPages.length > 0 ? Math.floor(remaining / generalPages.length) : 0;
  for (const page of generalPages) {
    budgets.set(page.url, Math.max(generalBudgetEach, 0));
  }

  return budgets;
}

module.exports = { assembleContext, aggregateMetadata, allocateCharBudget };
