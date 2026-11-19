const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBusiness, cleanDb, db } = require('../helpers/setup');

describe('Database Service', () => {
  beforeEach(cleanDb);

  // ===================== Business CRUD =====================

  describe('Business CRUD', () => {
    it('createBusiness creates and returns business with all fields', () => {
      const biz = createTestBusiness({
        name: 'My Shop',
        phone_number_id: 'pn-123',
        whatsapp_access_token: 'tok-abc',
        system_prompt: 'You are a shop bot.',
        website_url: 'https://myshop.com',
        gemini_model: 'gemini-3-flash-preview',
      });

      assert.ok(biz.id);
      assert.equal(biz.name, 'My Shop');
      assert.equal(biz.phone_number_id, 'pn-123');
      assert.equal(biz.whatsapp_access_token, 'tok-abc');
      assert.equal(biz.system_prompt, 'You are a shop bot.');
      assert.equal(biz.website_url, 'https://myshop.com');
      assert.equal(biz.gemini_model, 'gemini-3-flash-preview');
      assert.equal(biz.active, 1);
      assert.ok(biz.created_at);
    });

    it('getBusiness returns business by id', () => {
      const biz = createTestBusiness({ name: 'Lookup Test' });
      const found = db.getBusiness(biz.id);
      assert.equal(found.id, biz.id);
      assert.equal(found.name, 'Lookup Test');
    });

    it('getBusiness returns undefined for non-existent id', () => {
      const result = db.getBusiness('non-existent-id');
      assert.equal(result, undefined);
    });

    it('getBusinessByPhoneNumberId finds business by phone_number_id', () => {
      createTestBusiness({ phone_number_id: 'pn-456' });
      const found = db.getBusinessByPhoneNumberId('pn-456');
      assert.ok(found);
      assert.equal(found.phone_number_id, 'pn-456');
    });

    it('listBusinesses returns all active businesses', () => {
      createTestBusiness({ name: 'Biz A' });
      createTestBusiness({ name: 'Biz B' });
      createTestBusiness({ name: 'Biz C' });

      const list = db.listBusinesses();
      assert.equal(list.length, 3);
      const names = list.map((b) => b.name);
      assert.ok(names.includes('Biz A'));
      assert.ok(names.includes('Biz B'));
      assert.ok(names.includes('Biz C'));
    });

    it('updateBusiness updates partial fields (only name), keeps others', () => {
      const biz = createTestBusiness({
        name: 'Original',
        system_prompt: 'Keep this prompt.',
      });

      const updated = db.updateBusiness(biz.id, { name: 'Renamed' });
      assert.equal(updated.name, 'Renamed');
      assert.equal(updated.system_prompt, 'Keep this prompt.');
    });

    it('deactivateBusiness makes getBusiness return undefined', () => {
      const biz = createTestBusiness();
      db.deactivateBusiness(biz.id);
      const result = db.getBusiness(biz.id);
      assert.equal(result, undefined);
    });

    it('activateBusiness makes getBusiness return the business again', () => {
      const biz = createTestBusiness();
      db.deactivateBusiness(biz.id);
      assert.equal(db.getBusiness(biz.id), undefined);

      db.activateBusiness(biz.id);
      const reactivated = db.getBusiness(biz.id);
      assert.ok(reactivated);
      assert.equal(reactivated.id, biz.id);
    });

    it('getBusinessIncludingInactive returns deactivated business', () => {
      const biz = createTestBusiness();
      db.deactivateBusiness(biz.id);

      const found = db.getBusinessIncludingInactive(biz.id);
      assert.ok(found);
      assert.equal(found.id, biz.id);
      assert.equal(found.active, 0);
    });
  });

  // ===================== Conversations =====================

  describe('Conversations', () => {
    it('saveConversation creates a new conversation', () => {
      const biz = createTestBusiness();
      const messages = [{ role: 'user', content: 'Hello' }];
      db.saveConversation(biz.id, '972501111111', messages);

      const conv = db.getConversation(biz.id, '972501111111');
      assert.ok(conv);
      assert.equal(conv.business_id, biz.id);
      assert.equal(conv.customer_phone, '972501111111');
      assert.deepEqual(conv.messages, messages);
    });

    it('saveConversation upserts (updates existing)', () => {
      const biz = createTestBusiness();
      db.saveConversation(biz.id, '972501111111', [{ role: 'user', content: 'First' }]);
      db.saveConversation(biz.id, '972501111111', [
        { role: 'user', content: 'First' },
        { role: 'model', content: 'Reply' },
      ]);

      const conv = db.getConversation(biz.id, '972501111111');
      assert.equal(conv.messages.length, 2);
      assert.equal(conv.messages[1].content, 'Reply');
    });

    it('getConversation returns parsed JSON messages array', () => {
      const biz = createTestBusiness();
      const messages = [
        { role: 'user', content: 'Hi' },
        { role: 'model', content: 'Hello!' },
      ];
      db.saveConversation(biz.id, '972502222222', messages);

      const conv = db.getConversation(biz.id, '972502222222');
      assert.ok(Array.isArray(conv.messages));
      assert.deepEqual(conv.messages, messages);
    });

    it('getConversation returns undefined for non-existent', () => {
      const biz = createTestBusiness();
      const result = db.getConversation(biz.id, '000000000');
      assert.equal(result, undefined);
    });

    it('listConversations returns paginated results (test limit/offset)', () => {
      const biz = createTestBusiness();
      db.saveConversation(biz.id, '111', [{ role: 'user', content: 'a' }]);
      db.saveConversation(biz.id, '222', [{ role: 'user', content: 'b' }]);
      db.saveConversation(biz.id, '333', [{ role: 'user', content: 'c' }]);

      const page1 = db.listConversations(biz.id, 2, 0);
      assert.equal(page1.length, 2);

      const page2 = db.listConversations(biz.id, 2, 2);
      assert.equal(page2.length, 1);

      // Messages should be parsed
      assert.ok(Array.isArray(page1[0].messages));
    });

    it('deleteConversation removes the conversation', () => {
      const biz = createTestBusiness();
      db.saveConversation(biz.id, '972504444444', [{ role: 'user', content: 'Bye' }]);
      const conv = db.getConversation(biz.id, '972504444444');

      db.deleteConversation(conv.id);
      const deleted = db.getConversation(biz.id, '972504444444');
      assert.equal(deleted, undefined);
    });

    it('updateConversationSummary stores and retrieves summary', () => {
      const biz = createTestBusiness();
      db.saveConversation(biz.id, '972505555555', [{ role: 'user', content: 'Hello' }]);

      db.updateConversationSummary(biz.id, '972505555555', 'Customer asked about pricing.');
      const conv = db.getConversation(biz.id, '972505555555');
      assert.equal(conv.conversation_summary, 'Customer asked about pricing.');
    });

    it('updateConversationSummary overwrites existing summary', () => {
      const biz = createTestBusiness();
      db.saveConversation(biz.id, '972505555555', [{ role: 'user', content: 'Hello' }]);

      db.updateConversationSummary(biz.id, '972505555555', 'First summary');
      db.updateConversationSummary(biz.id, '972505555555', 'Updated summary');
      const conv = db.getConversation(biz.id, '972505555555');
      assert.equal(conv.conversation_summary, 'Updated summary');
    });

    it('conversation_summary defaults to null', () => {
      const biz = createTestBusiness();
      db.saveConversation(biz.id, '972506666666', [{ role: 'user', content: 'Hi' }]);
      const conv = db.getConversation(biz.id, '972506666666');
      assert.equal(conv.conversation_summary, null);
    });

    it('summarizeAndTrimConversation trims when message count matches', () => {
      const biz = createTestBusiness();
      const messages = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
      db.saveConversation(biz.id, '972507777777', messages);

      const recentMessages = messages.slice(-10);
      const trimmed = db.summarizeAndTrimConversation(biz.id, '972507777777', 'A summary', recentMessages, 20);
      assert.equal(trimmed, true);

      const conv = db.getConversation(biz.id, '972507777777');
      assert.equal(conv.conversation_summary, 'A summary');
      assert.equal(conv.messages.length, 10);
      assert.equal(conv.messages[0].content, 'msg 10');
    });

    it('summarizeAndTrimConversation saves summary but skips trim when count changed', () => {
      const biz = createTestBusiness();
      const messages = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
      db.saveConversation(biz.id, '972508888888', messages);

      // Simulate a new message arriving (expected 20 but now 21)
      const recentMessages = messages.slice(-10);
      const trimmed = db.summarizeAndTrimConversation(biz.id, '972508888888', 'A summary', recentMessages, 19);
      assert.equal(trimmed, false);

      const conv = db.getConversation(biz.id, '972508888888');
      assert.equal(conv.conversation_summary, 'A summary');
      // Messages should NOT be trimmed — all 20 still there
      assert.equal(conv.messages.length, 20);
    });

    it('summarizeAndTrimConversation returns false for non-existent conversation', () => {
      const biz = createTestBusiness();
      const trimmed = db.summarizeAndTrimConversation(biz.id, '972500000000', 'A summary', [], 5);
      assert.equal(trimmed, false);
    });
  });

  // ===================== Scraped Pages =====================

  describe('Scraped Pages', () => {
    it('upsertScrapedPage creates a page and returns it', () => {
      const biz = createTestBusiness();
      const page = db.upsertScrapedPage({
        business_id: biz.id,
        url: 'https://example.com/about',
        title: 'About Us',
        page_type: 'about',
        content: 'We are a great company.',
        metadata: null,
        content_hash: null,
        http_last_modified: null,
        http_etag: null,
      });

      assert.ok(page.id);
      assert.equal(page.business_id, biz.id);
      assert.equal(page.url, 'https://example.com/about');
      assert.equal(page.title, 'About Us');
      assert.equal(page.page_type, 'about');
      assert.equal(page.content, 'We are a great company.');
      assert.ok(page.scraped_at);
    });

    it('upsertScrapedPage updates existing page (same business_id + url)', () => {
      const biz = createTestBusiness();
      const first = db.upsertScrapedPage({
        business_id: biz.id,
        url: 'https://example.com/pricing',
        title: 'Pricing v1',
        page_type: 'pricing',
        content: 'Old pricing.',
        metadata: null,
        content_hash: 'hash1',
        http_last_modified: null,
        http_etag: null,
      });

      const updated = db.upsertScrapedPage({
        business_id: biz.id,
        url: 'https://example.com/pricing',
        title: 'Pricing v2',
        page_type: 'pricing',
        content: 'New pricing.',
        metadata: null,
        content_hash: 'hash2',
        http_last_modified: null,
        http_etag: null,
      });

      assert.equal(updated.id, first.id);
      assert.equal(updated.title, 'Pricing v2');
      assert.equal(updated.content, 'New pricing.');
      assert.equal(updated.content_hash, 'hash2');
    });

    it('getScrapedPages returns all pages for a business', () => {
      const biz = createTestBusiness();
      db.upsertScrapedPage({
        business_id: biz.id,
        url: 'https://example.com/a',
        title: 'A',
        page_type: 'general',
        content: 'Page A',
        metadata: null,
        content_hash: null,
        http_last_modified: null,
        http_etag: null,
      });
      db.upsertScrapedPage({
        business_id: biz.id,
        url: 'https://example.com/b',
        title: 'B',
        page_type: 'general',
        content: 'Page B',
        metadata: null,
        content_hash: null,
        http_last_modified: null,
        http_etag: null,
      });

      const pages = db.getScrapedPages(biz.id);
      assert.equal(pages.length, 2);
    });

    it('getScrapedPageByUrl returns specific page', () => {
      const biz = createTestBusiness();
      db.upsertScrapedPage({
        business_id: biz.id,
        url: 'https://example.com/contact',
        title: 'Contact',
        page_type: 'contact',
        content: 'Call us.',
        metadata: null,
        content_hash: null,
        http_last_modified: null,
        http_etag: null,
      });

      const page = db.getScrapedPageByUrl(biz.id, 'https://example.com/contact');
      assert.ok(page);
      assert.equal(page.title, 'Contact');
      assert.equal(page.page_type, 'contact');
    });

    it('getScrapedPagesByType filters by page_type', () => {
      const biz = createTestBusiness();
      db.upsertScrapedPage({
        business_id: biz.id,
        url: 'https://example.com/faq1',
        title: 'FAQ 1',
        page_type: 'faq',
        content: 'Q1',
        metadata: null,
        content_hash: null,
        http_last_modified: null,
        http_etag: null,
      });
      db.upsertScrapedPage({
        business_id: biz.id,
        url: 'https://example.com/about',
        title: 'About',
        page_type: 'about',
        content: 'About us',
        metadata: null,
        content_hash: null,
        http_last_modified: null,
        http_etag: null,
      });
      db.upsertScrapedPage({
        business_id: biz.id,
        url: 'https://example.com/faq2',
        title: 'FAQ 2',
        page_type: 'faq',
        content: 'Q2',
        metadata: null,
        content_hash: null,
        http_last_modified: null,
        http_etag: null,
      });

      const faqs = db.getScrapedPagesByType(biz.id, 'faq');
      assert.equal(faqs.length, 2);
      assert.ok(faqs.every((p) => p.page_type === 'faq'));
    });

    it('countScrapedPages returns correct count', () => {
      const biz = createTestBusiness();
      assert.equal(db.countScrapedPages(biz.id), 0);

      db.upsertScrapedPage({
        business_id: biz.id,
        url: 'https://example.com/1',
        title: 'P1',
        page_type: 'general',
        content: 'Content',
        metadata: null,
        content_hash: null,
        http_last_modified: null,
        http_etag: null,
      });
      db.upsertScrapedPage({
        business_id: biz.id,
        url: 'https://example.com/2',
        title: 'P2',
        page_type: 'general',
        content: 'Content',
        metadata: null,
        content_hash: null,
        http_last_modified: null,
        http_etag: null,
      });

      assert.equal(db.countScrapedPages(biz.id), 2);
    });

    it('deleteBusinessScrapedPages removes all pages for a business', () => {
      const biz = createTestBusiness();
      db.upsertScrapedPage({
        business_id: biz.id,
        url: 'https://example.com/x',
        title: 'X',
        page_type: 'general',
        content: 'X content',
        metadata: null,
        content_hash: null,
        http_last_modified: null,
        http_etag: null,
      });
      db.upsertScrapedPage({
        business_id: biz.id,
        url: 'https://example.com/y',
        title: 'Y',
        page_type: 'general',
        content: 'Y content',
        metadata: null,
        content_hash: null,
        http_last_modified: null,
        http_etag: null,
      });

      db.deleteBusinessScrapedPages(biz.id);
      assert.equal(db.countScrapedPages(biz.id), 0);
      assert.deepEqual(db.getScrapedPages(biz.id), []);
    });
  });

  // ===================== Customer Memory =====================

  describe('Customer Memory', () => {
    it('saveCustomerMemory + getCustomerMemory round-trip with JSON facts', () => {
      const biz = createTestBusiness();
      const facts = { name: 'Daniel', language: 'Hebrew', notes: 'Prefers email' };
      db.saveCustomerMemory(biz.id, '972509999999', facts);

      const mem = db.getCustomerMemory(biz.id, '972509999999');
      assert.ok(mem);
      assert.equal(mem.business_id, biz.id);
      assert.equal(mem.customer_phone, '972509999999');
      assert.deepEqual(mem.facts, facts);
    });

    it('listCustomerMemories returns paginated results', () => {
      const biz = createTestBusiness();
      db.saveCustomerMemory(biz.id, '111', { name: 'Alice' });
      db.saveCustomerMemory(biz.id, '222', { name: 'Bob' });
      db.saveCustomerMemory(biz.id, '333', { name: 'Charlie' });

      const page1 = db.listCustomerMemories(biz.id, 2, 0);
      assert.equal(page1.length, 2);
      assert.ok(page1[0].facts.name); // facts are parsed

      const page2 = db.listCustomerMemories(biz.id, 2, 2);
      assert.equal(page2.length, 1);
    });

    it('deleteCustomerMemory removes specific customer memory', () => {
      const biz = createTestBusiness();
      db.saveCustomerMemory(biz.id, '111', { name: 'Alice' });
      db.saveCustomerMemory(biz.id, '222', { name: 'Bob' });

      db.deleteCustomerMemory(biz.id, '111');
      assert.equal(db.getCustomerMemory(biz.id, '111'), undefined);
      assert.ok(db.getCustomerMemory(biz.id, '222'));
    });

    it('deleteBusinessCustomerMemories removes all for business', () => {
      const biz = createTestBusiness();
      db.saveCustomerMemory(biz.id, '111', { name: 'Alice' });
      db.saveCustomerMemory(biz.id, '222', { name: 'Bob' });

      db.deleteBusinessCustomerMemories(biz.id);
      assert.equal(db.getCustomerMemory(biz.id, '111'), undefined);
      assert.equal(db.getCustomerMemory(biz.id, '222'), undefined);
      assert.deepEqual(db.listCustomerMemories(biz.id), []);
    });
  });

  // ===================== Escalations =====================

  describe('Escalations', () => {
    it('createEscalation creates and returns escalation', () => {
      const biz = createTestBusiness();
      const esc = db.createEscalation(biz.id, '972501111111', 'Customer wants refund');

      assert.ok(esc.id);
      assert.equal(esc.business_id, biz.id);
      assert.equal(esc.customer_phone, '972501111111');
      assert.equal(esc.reason, 'Customer wants refund');
      assert.equal(esc.status, 'active');
      assert.ok(esc.created_at);
      assert.equal(esc.resolved_at, null);
    });

    it('getActiveEscalation returns active escalation for customer', () => {
      const biz = createTestBusiness();
      db.createEscalation(biz.id, '972501111111', 'Need help');

      const active = db.getActiveEscalation(biz.id, '972501111111');
      assert.ok(active);
      assert.equal(active.status, 'active');
      assert.equal(active.customer_phone, '972501111111');
    });

    it('getActiveEscalationsForBoss returns all active for business', () => {
      const biz = createTestBusiness();
      db.createEscalation(biz.id, '111', 'Reason A');
      db.createEscalation(biz.id, '222', 'Reason B');

      const active = db.getActiveEscalationsForBoss(biz.id);
      assert.equal(active.length, 2);
      assert.ok(active.every((e) => e.status === 'active'));
    });

    it('resolveEscalation sets status to resolved', () => {
      const biz = createTestBusiness();
      const esc = db.createEscalation(biz.id, '972501111111', 'Issue');

      const resolved = db.resolveEscalation(esc.id);
      assert.equal(resolved.status, 'resolved');
      assert.ok(resolved.resolved_at);
    });

    it('resolveAllEscalations resolves all active for business', () => {
      const biz = createTestBusiness();
      db.createEscalation(biz.id, '111', 'A');
      db.createEscalation(biz.id, '222', 'B');

      db.resolveAllEscalations(biz.id);

      const active = db.getActiveEscalationsForBoss(biz.id);
      assert.equal(active.length, 0);

      // Verify they are resolved, not deleted
      const all = db.listEscalations(biz.id);
      assert.equal(all.length, 2);
      assert.ok(all.every((e) => e.status === 'resolved'));
    });

    it('updateEscalationMessageId stores and getEscalationByMessageId retrieves by message ID', () => {
      const biz = createTestBusiness();
      const esc1 = db.createEscalation(biz.id, '111', 'Reason A');
      const esc2 = db.createEscalation(biz.id, '222', 'Reason B');

      db.updateEscalationMessageId(esc1.id, 'wamid.abc123');
      db.updateEscalationMessageId(esc2.id, 'wamid.def456');

      const found1 = db.getEscalationByMessageId(biz.id, 'wamid.abc123');
      assert.ok(found1);
      assert.equal(found1.id, esc1.id);
      assert.equal(found1.customer_phone, '111');

      const found2 = db.getEscalationByMessageId(biz.id, 'wamid.def456');
      assert.ok(found2);
      assert.equal(found2.id, esc2.id);
      assert.equal(found2.customer_phone, '222');
    });

    it('getEscalationByMessageId returns null for unknown message ID', () => {
      const biz = createTestBusiness();
      db.createEscalation(biz.id, '111', 'Reason');

      const result = db.getEscalationByMessageId(biz.id, 'wamid.nonexistent');
      assert.equal(result, undefined);
    });

    it('getEscalationByMessageId only matches active escalations', () => {
      const biz = createTestBusiness();
      const esc = db.createEscalation(biz.id, '111', 'Reason');
      db.updateEscalationMessageId(esc.id, 'wamid.abc123');
      db.resolveEscalation(esc.id);

      const result = db.getEscalationByMessageId(biz.id, 'wamid.abc123');
      assert.equal(result, undefined);
    });

    it('updateEscalationMessageId overwrites previous message ID', () => {
      const biz = createTestBusiness();
      const esc = db.createEscalation(biz.id, '111', 'Reason');

      db.updateEscalationMessageId(esc.id, 'wamid.first');
      db.updateEscalationMessageId(esc.id, 'wamid.second');

      // Old message ID no longer matches
      const oldResult = db.getEscalationByMessageId(biz.id, 'wamid.first');
      assert.equal(oldResult, undefined);

      // New message ID works
      const newResult = db.getEscalationByMessageId(biz.id, 'wamid.second');
      assert.ok(newResult);
      assert.equal(newResult.id, esc.id);
    });

    it('getActiveEscalationsForBoss returns in FIFO order (oldest first)', () => {
      const biz = createTestBusiness();
      db.createEscalation(biz.id, '111', 'First');
      db.createEscalation(biz.id, '222', 'Second');
      db.createEscalation(biz.id, '333', 'Third');

      const escalations = db.getActiveEscalationsForBoss(biz.id);
      assert.equal(escalations.length, 3);
      assert.equal(escalations[0].customer_phone, '111');
      assert.equal(escalations[1].customer_phone, '222');
      assert.equal(escalations[2].customer_phone, '333');
    });

    it('updateEscalationBossResponse sets last_boss_response_at', () => {
      const biz = createTestBusiness();
      const esc = db.createEscalation(biz.id, '972501111111', 'Help');

      // Initially null
      assert.equal(db.getEscalation(esc.id).last_boss_response_at, null);

      db.updateEscalationBossResponse(esc.id);
      const updated = db.getEscalation(esc.id);
      assert.ok(updated.last_boss_response_at);
    });

    it('updateEscalationSummary stores summary on escalation', () => {
      const biz = createTestBusiness();
      const esc = db.createEscalation(biz.id, '972501111111', 'Help');

      assert.equal(db.getEscalation(esc.id).summary, null);

      db.updateEscalationSummary(esc.id, 'Customer asked about pricing');
      const updated = db.getEscalation(esc.id);
      assert.equal(updated.summary, 'Customer asked about pricing');
    });

    it('getStaleEscalations returns escalations without recent boss response', () => {
      const biz = createTestBusiness();
      db.createEscalation(biz.id, '972501111111', 'Old');

      // Push created_at back to make it stale
      db.db.prepare(`UPDATE escalations SET created_at = datetime('now', '-5 hours') WHERE business_id = ?`).run(biz.id);

      const stale = db.getStaleEscalations(biz.id, '-4 hours');
      assert.equal(stale.length, 1);
      assert.equal(stale[0].customer_phone, '972501111111');
    });

    it('getStaleEscalations excludes recently responded escalations', () => {
      const biz = createTestBusiness();
      const esc = db.createEscalation(biz.id, '972501111111', 'Active');

      // Push created_at back but set recent boss response
      db.db.prepare(`UPDATE escalations SET created_at = datetime('now', '-5 hours') WHERE id = ?`).run(esc.id);
      db.updateEscalationBossResponse(esc.id);

      const stale = db.getStaleEscalations(biz.id, '-4 hours');
      assert.equal(stale.length, 0);
    });

    it('createEscalation returns null for duplicate active escalation (same business + phone)', () => {
      const biz = createTestBusiness();
      const first = db.createEscalation(biz.id, '972501111111', 'First reason');
      assert.ok(first);
      assert.equal(first.status, 'active');

      // Second call for same business+phone should return null (unique index prevents it)
      const second = db.createEscalation(biz.id, '972501111111', 'Second reason');
      assert.equal(second, null);

      // Only one active escalation should exist
      const active = db.getActiveEscalationsForBoss(biz.id);
      assert.equal(active.length, 1);
      assert.equal(active[0].reason, 'First reason');
    });

    it('createEscalation allows new escalation after resolving previous one', () => {
      const biz = createTestBusiness();
      const first = db.createEscalation(biz.id, '972501111111', 'First');
      assert.ok(first);

      db.resolveEscalation(first.id);

      // After resolving, a new escalation for the same customer should work
      const second = db.createEscalation(biz.id, '972501111111', 'Second');
      assert.ok(second);
      assert.equal(second.status, 'active');
      assert.equal(second.reason, 'Second');
    });

    it('createEscalation allows different customers to have active escalations', () => {
      const biz = createTestBusiness();
      const first = db.createEscalation(biz.id, '972501111111', 'Customer A');
      const second = db.createEscalation(biz.id, '972502222222', 'Customer B');
      assert.ok(first);
      assert.ok(second);

      const active = db.getActiveEscalationsForBoss(biz.id);
      assert.equal(active.length, 2);
    });

    it('listEscalations returns ordered results (active first)', () => {
      const biz = createTestBusiness();
      const esc1 = db.createEscalation(biz.id, '111', 'First');
      db.createEscalation(biz.id, '222', 'Second');
      db.createEscalation(biz.id, '333', 'Third');

      // Resolve the first one
      db.resolveEscalation(esc1.id);

      const list = db.listEscalations(biz.id);
      assert.equal(list.length, 3);
      // Active ones should come first
      assert.equal(list[0].status, 'active');
      assert.equal(list[1].status, 'active');
      assert.equal(list[2].status, 'resolved');
    });
  });

  // ===================== Scrape Jobs =====================

  describe('Scrape Jobs', () => {
    it('insertScrapeJob creates job with pending status', () => {
      const biz = createTestBusiness();
      const job = db.insertScrapeJob(biz.id);

      assert.ok(job.id);
      assert.equal(job.business_id, biz.id);
      assert.equal(job.status, 'pending');
      assert.equal(job.total_pages, 0);
      assert.equal(job.scraped_pages, 0);
      assert.equal(job.failed_pages, 0);
      assert.equal(job.pages_discovered, 0);
      assert.equal(job.error, null);
      assert.ok(job.created_at);
    });

    it('getScrapeJob returns job by id', () => {
      const biz = createTestBusiness();
      const job = db.insertScrapeJob(biz.id);

      const found = db.getScrapeJob(job.id);
      assert.ok(found);
      assert.equal(found.id, job.id);
      assert.equal(found.status, 'pending');
    });

    it('getLatestScrapeJob returns most recent job', () => {
      const biz = createTestBusiness();
      const older = db.insertScrapeJob(biz.id);
      // Push the first job's created_at back so ordering is deterministic
      db.db.prepare('UPDATE scrape_jobs SET created_at = datetime(\'now\', \'-1 minute\') WHERE id = ?').run(older.id);
      const latest = db.insertScrapeJob(biz.id);

      const found = db.getLatestScrapeJob(biz.id);
      assert.equal(found.id, latest.id);
    });

    it('getInProgressScrapeJob returns in-progress job (or undefined)', () => {
      const biz = createTestBusiness();

      // No jobs yet
      assert.equal(db.getInProgressScrapeJob(biz.id), undefined);

      // Pending job should not be returned
      const job = db.insertScrapeJob(biz.id);
      assert.equal(db.getInProgressScrapeJob(biz.id), undefined);

      // Mark as in_progress
      db.updateScrapeJob(job.id, { status: 'in_progress' });
      const found = db.getInProgressScrapeJob(biz.id);
      assert.ok(found);
      assert.equal(found.id, job.id);
      assert.equal(found.status, 'in_progress');
    });

    it('updateScrapeJob updates fields', () => {
      const biz = createTestBusiness();
      const job = db.insertScrapeJob(biz.id);

      const updated = db.updateScrapeJob(job.id, {
        status: 'in_progress',
        total_pages: 10,
        scraped_pages: 3,
        failed_pages: 1,
        pages_discovered: 15,
        started_at: '2026-01-01 12:00:00',
      });

      assert.equal(updated.status, 'in_progress');
      assert.equal(updated.total_pages, 10);
      assert.equal(updated.scraped_pages, 3);
      assert.equal(updated.failed_pages, 1);
      assert.equal(updated.pages_discovered, 15);
      assert.equal(updated.started_at, '2026-01-01 12:00:00');
      assert.equal(updated.error, null);
      assert.equal(updated.completed_at, null);
    });
  });
});
