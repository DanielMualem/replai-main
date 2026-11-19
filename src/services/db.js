const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const tokenCrypto = require('./crypto');

const dir = path.dirname(config.dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(config.dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone_number_id TEXT UNIQUE,
    whatsapp_access_token TEXT,
    system_prompt TEXT NOT NULL DEFAULT 'You are a helpful and professional business assistant. Answer customer questions based on the business context provided. Be warm, concise, and helpful.',
    website_url TEXT,
    scraped_data TEXT,
    gemini_model TEXT NOT NULL DEFAULT 'gemini-3-flash-preview',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    messages TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    UNIQUE(business_id, customer_phone)
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_business ON conversations(business_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);

  CREATE TABLE IF NOT EXISTS scraped_pages (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    page_type TEXT NOT NULL DEFAULT 'general',
    content TEXT,
    metadata TEXT,
    content_hash TEXT,
    http_last_modified TEXT,
    http_etag TEXT,
    scraped_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    UNIQUE(business_id, url)
  );

  CREATE INDEX IF NOT EXISTS idx_scraped_pages_business ON scraped_pages(business_id);
  CREATE INDEX IF NOT EXISTS idx_scraped_pages_type ON scraped_pages(business_id, page_type);

  CREATE TABLE IF NOT EXISTS scrape_jobs (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    total_pages INTEGER NOT NULL DEFAULT 0,
    scraped_pages INTEGER NOT NULL DEFAULT 0,
    failed_pages INTEGER NOT NULL DEFAULT 0,
    pages_discovered INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_scrape_jobs_business ON scrape_jobs(business_id);

  CREATE TABLE IF NOT EXISTS customer_memory (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    facts TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    UNIQUE(business_id, customer_phone)
  );

  CREATE INDEX IF NOT EXISTS idx_customer_memory_business ON customer_memory(business_id);
`);

// Migrate existing tables: add new columns if missing
try {
  db.exec(`ALTER TABLE businesses ADD COLUMN phone_number_id TEXT UNIQUE`);
} catch (_) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE businesses ADD COLUMN whatsapp_access_token TEXT`);
} catch (_) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE businesses ADD COLUMN boss_phone TEXT`);
} catch (_) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE businesses ADD COLUMN scheduling_config TEXT`);
} catch (_) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE businesses ADD COLUMN boss_language TEXT DEFAULT 'he'`);
} catch (_) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN conversation_summary TEXT`);
} catch (_) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE businesses ADD COLUMN waba_id TEXT`);
} catch (_) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE businesses ADD COLUMN boss_telegram_chat_id TEXT`);
} catch (_) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE businesses ADD COLUMN subscription_plan TEXT NOT NULL DEFAULT 'trial'`);
} catch (_) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE businesses ADD COLUMN trial_ends_at TEXT`);
} catch (_) { /* column already exists */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    last_message_id TEXT,
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_escalations_active
    ON escalations(business_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_escalations_unique_active
    ON escalations(business_id, customer_phone) WHERE status = 'active';
`);
try {
  db.exec(`ALTER TABLE escalations ADD COLUMN last_message_id TEXT`);
} catch (_) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE escalations ADD COLUMN last_boss_response_at TEXT`);
} catch (_) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE escalations ADD COLUMN summary TEXT`);
} catch (_) { /* column already exists */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    service_id TEXT NOT NULL,
    service_name TEXT NOT NULL,
    service_duration INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id)
  );
  CREATE INDEX IF NOT EXISTS idx_appointments_business_date ON appointments(business_id, start_time);
  CREATE INDEX IF NOT EXISTS idx_appointments_customer ON appointments(business_id, customer_phone, status);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS signup_invites (
    token TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_signup_invites_business ON signup_invites(business_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS data_deletion_requests (
    confirmation_code TEXT PRIMARY KEY,
    facebook_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_gaps (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    question TEXT NOT NULL,
    ai_response TEXT,
    gap_type TEXT NOT NULL DEFAULT 'uncertain',
    status TEXT NOT NULL DEFAULT 'pending',
    answer TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_gaps_business ON knowledge_gaps(business_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_gaps_status ON knowledge_gaps(business_id, status);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_links (
    token TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS google_calendar_invites (
    token TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_google_calendar_invites_business ON google_calendar_invites(business_id);
`);

// Migrate scraped_data blobs into scraped_pages rows
{
  const businesses = db.prepare(
    `SELECT id, scraped_data FROM businesses WHERE scraped_data IS NOT NULL`
  ).all();
  const hasPages = db.prepare(
    `SELECT COUNT(*) as cnt FROM scraped_pages WHERE business_id = ?`
  );
  const insertPage = db.prepare(`
    INSERT OR IGNORE INTO scraped_pages (id, business_id, url, title, page_type, content, scraped_at)
    VALUES (@id, @business_id, @url, @title, 'general', @content, datetime('now'))
  `);
  const clearBlob = db.prepare(`UPDATE businesses SET scraped_data = NULL WHERE id = ?`);

  const migrateAll = db.transaction(() => {
    for (const biz of businesses) {
      const { cnt } = hasPages.get(biz.id);
      if (cnt > 0) continue;

      // Parse old format: ## Title\nURL: url\ntext separated by ---
      const sections = biz.scraped_data.split(/\n---\n/);
      for (const section of sections) {
        const trimmed = section.trim();
        if (!trimmed) continue;
        const titleMatch = trimmed.match(/^## (.+)/);
        const urlMatch = trimmed.match(/\nURL: (.+)/);
        const title = titleMatch ? titleMatch[1].trim() : '';
        const url = urlMatch ? urlMatch[1].trim() : `migrated://${biz.id}/${Math.random().toString(36).slice(2)}`;
        const contentStart = urlMatch ? trimmed.indexOf('\n', trimmed.indexOf('URL:')) + 1 : 0;
        const content = trimmed.slice(contentStart).trim();
        if (!content) continue;
        insertPage.run({
          id: crypto.randomUUID(),
          business_id: biz.id,
          url,
          title,
          content,
        });
      }
      clearBlob.run(biz.id);
    }
  });

  const migrated = businesses.length;
  if (migrated > 0) {
    migrateAll();
    logger.info({ count: migrated }, 'Migrated scraped_data to scraped_pages');
  }
}

// Migrate plaintext tokens to encrypted format
if (config.tokenEncryptionKey) {
  const encryptToken = db.prepare('UPDATE businesses SET whatsapp_access_token = ? WHERE id = ?');
  const allBusinesses = db.prepare('SELECT id, whatsapp_access_token FROM businesses WHERE whatsapp_access_token IS NOT NULL').all();
  const migrateTokens = db.transaction(() => {
    let count = 0;
    for (const biz of allBusinesses) {
      if (!tokenCrypto.isEncrypted(biz.whatsapp_access_token)) {
        encryptToken.run(tokenCrypto.encrypt(biz.whatsapp_access_token), biz.id);
        count++;
      }
    }
    return count;
  });
  const migrated = migrateTokens();
  if (migrated > 0) {
    logger.info({ count: migrated }, 'Encrypted plaintext WhatsApp tokens');
  }
}

logger.info('Database initialized');

// --- Business CRUD ---

const stmts = {
  insertBusiness: db.prepare(`
    INSERT INTO businesses (id, name, phone_number_id, whatsapp_access_token, system_prompt, website_url, gemini_model, boss_language, scheduling_config, waba_id, boss_telegram_chat_id, subscription_plan, trial_ends_at)
    VALUES (@id, @name, @phone_number_id, @whatsapp_access_token, @system_prompt, @website_url, @gemini_model, @boss_language, @scheduling_config, @waba_id, @boss_telegram_chat_id, @subscription_plan, @trial_ends_at)
  `),
  getBusiness: db.prepare('SELECT * FROM businesses WHERE id = ? AND active = 1'),
  getBusinessByPhoneNumberId: db.prepare('SELECT * FROM businesses WHERE phone_number_id = ? AND active = 1'),
  listBusinesses: db.prepare('SELECT * FROM businesses WHERE active = 1 ORDER BY created_at DESC'),
  updateBusiness: db.prepare(`
    UPDATE businesses
    SET name = COALESCE(@name, name),
        phone_number_id = COALESCE(@phone_number_id, phone_number_id),
        whatsapp_access_token = COALESCE(@whatsapp_access_token, whatsapp_access_token),
        system_prompt = COALESCE(@system_prompt, system_prompt),
        website_url = COALESCE(@website_url, website_url),
        gemini_model = COALESCE(@gemini_model, gemini_model),
        boss_language = COALESCE(@boss_language, boss_language),
        scheduling_config = CASE WHEN @scheduling_config_clear = 1 THEN NULL ELSE COALESCE(@scheduling_config, scheduling_config) END,
        waba_id = COALESCE(@waba_id, waba_id),
        boss_telegram_chat_id = COALESCE(@boss_telegram_chat_id, boss_telegram_chat_id),
        subscription_plan = COALESCE(@subscription_plan, subscription_plan)
    WHERE id = @id
  `),
  deactivateBusiness: db.prepare('UPDATE businesses SET active = 0 WHERE id = ?'),
  activateBusiness: db.prepare('UPDATE businesses SET active = 1 WHERE id = ?'),
  getBusinessIncludingInactive: db.prepare('SELECT * FROM businesses WHERE id = ?'),

  // --- Conversations ---
  getConversation: db.prepare('SELECT * FROM conversations WHERE business_id = ? AND customer_phone = ?'),
  upsertConversation: db.prepare(`
    INSERT INTO conversations (id, business_id, customer_phone, messages, updated_at)
    VALUES (@id, @business_id, @customer_phone, @messages, datetime('now'))
    ON CONFLICT(business_id, customer_phone)
    DO UPDATE SET messages = @messages, updated_at = datetime('now')
  `),
  listConversations: db.prepare(`
    SELECT * FROM conversations WHERE business_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?
  `),
  deleteConversation: db.prepare('DELETE FROM conversations WHERE id = ?'),
  deleteBusinessConversations: db.prepare('DELETE FROM conversations WHERE business_id = ?'),
  updateConversationSummary: db.prepare(
    'UPDATE conversations SET conversation_summary = ? WHERE business_id = ? AND customer_phone = ?'
  ),

  // --- Scraped Pages ---
  upsertScrapedPage: db.prepare(`
    INSERT INTO scraped_pages (id, business_id, url, title, page_type, content, metadata, content_hash, http_last_modified, http_etag, scraped_at)
    VALUES (@id, @business_id, @url, @title, @page_type, @content, @metadata, @content_hash, @http_last_modified, @http_etag, datetime('now'))
    ON CONFLICT(business_id, url)
    DO UPDATE SET title = @title, page_type = @page_type, content = @content, metadata = @metadata,
      content_hash = @content_hash, http_last_modified = @http_last_modified, http_etag = @http_etag, scraped_at = datetime('now')
  `),
  getScrapedPages: db.prepare('SELECT * FROM scraped_pages WHERE business_id = ? ORDER BY page_type, url'),
  getScrapedPageByUrl: db.prepare('SELECT * FROM scraped_pages WHERE business_id = ? AND url = ?'),
  getScrapedPagesByType: db.prepare('SELECT * FROM scraped_pages WHERE business_id = ? AND page_type = ?'),
  deleteBusinessScrapedPages: db.prepare('DELETE FROM scraped_pages WHERE business_id = ?'),
  countScrapedPages: db.prepare('SELECT COUNT(*) as count FROM scraped_pages WHERE business_id = ?'),

  // --- Customer Memory ---
  getCustomerMemory: db.prepare('SELECT * FROM customer_memory WHERE business_id = ? AND customer_phone = ?'),
  upsertCustomerMemory: db.prepare(`
    INSERT INTO customer_memory (id, business_id, customer_phone, facts, updated_at)
    VALUES (@id, @business_id, @customer_phone, @facts, datetime('now'))
    ON CONFLICT(business_id, customer_phone)
    DO UPDATE SET facts = @facts, updated_at = datetime('now')
  `),
  listCustomerMemories: db.prepare(`
    SELECT * FROM customer_memory WHERE business_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?
  `),
  deleteCustomerMemory: db.prepare('DELETE FROM customer_memory WHERE business_id = ? AND customer_phone = ?'),
  deleteBusinessCustomerMemories: db.prepare('DELETE FROM customer_memory WHERE business_id = ?'),

  // --- Escalations ---
  getActiveEscalation: db.prepare(
    `SELECT * FROM escalations WHERE business_id = ? AND customer_phone = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`
  ),
  getActiveEscalationsForBoss: db.prepare(
    `SELECT * FROM escalations WHERE business_id = ? AND status = 'active' ORDER BY created_at ASC`
  ),
  createEscalation: db.prepare(`
    INSERT INTO escalations (id, business_id, customer_phone, reason, status, created_at)
    VALUES (@id, @business_id, @customer_phone, @reason, 'active', datetime('now'))
  `),
  resolveEscalation: db.prepare(
    `UPDATE escalations SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?`
  ),
  resolveAllEscalations: db.prepare(
    `UPDATE escalations SET status = 'resolved', resolved_at = datetime('now') WHERE business_id = ? AND status = 'active'`
  ),
  listEscalations: db.prepare(
    `SELECT * FROM escalations WHERE business_id = ? ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC LIMIT ? OFFSET ?`
  ),
  getEscalation: db.prepare('SELECT * FROM escalations WHERE id = ?'),
  getEscalationByMessageId: db.prepare(
    `SELECT * FROM escalations WHERE business_id = ? AND last_message_id = ? AND status = 'active' LIMIT 1`
  ),
  updateEscalationMessageId: db.prepare(
    `UPDATE escalations SET last_message_id = ? WHERE id = ?`
  ),
  updateEscalationBossResponse: db.prepare(
    `UPDATE escalations SET last_boss_response_at = datetime('now') WHERE id = ?`
  ),
  updateEscalationSummary: db.prepare(
    `UPDATE escalations SET summary = ? WHERE id = ?`
  ),
  getStaleEscalations: db.prepare(
    `SELECT * FROM escalations WHERE business_id = ? AND status = 'active' AND ((last_boss_response_at IS NULL AND created_at <= datetime('now', ?)) OR (last_boss_response_at IS NOT NULL AND last_boss_response_at <= datetime('now', ?)))`
  ),

  // --- Appointments ---
  getAppointmentsByDate: db.prepare(
    `SELECT * FROM appointments WHERE business_id = ? AND date(start_time) = ? AND status = 'confirmed'`
  ),
  getAppointmentsByCustomer: db.prepare(
    `SELECT * FROM appointments WHERE business_id = ? AND customer_phone = ? AND status = ? ORDER BY start_time ASC`
  ),
  getAllAppointmentsByCustomer: db.prepare(
    `SELECT * FROM appointments WHERE business_id = ? AND customer_phone = ? ORDER BY start_time ASC`
  ),
  createAppointment: db.prepare(`
    INSERT INTO appointments (id, business_id, customer_phone, customer_name, service_id, service_name, service_duration, start_time, end_time, status)
    VALUES (@id, @business_id, @customer_phone, @customer_name, @service_id, @service_name, @service_duration, @start_time, @end_time, 'confirmed')
  `),
  getAppointment: db.prepare('SELECT * FROM appointments WHERE id = ?'),
  updateAppointmentStatus: db.prepare('UPDATE appointments SET status = ? WHERE id = ?'),
  listAppointments: db.prepare(
    `SELECT * FROM appointments WHERE business_id = ? AND status = ? ORDER BY start_time ASC LIMIT ? OFFSET ?`
  ),
  listAllAppointments: db.prepare(
    `SELECT * FROM appointments WHERE business_id = ? ORDER BY start_time DESC LIMIT ? OFFSET ?`
  ),

  // --- Sessions ---
  createSession: db.prepare(
    `INSERT INTO sessions (id, email, expires_at) VALUES (@id, @email, @expires_at)`
  ),
  getSession: db.prepare(
    `SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')`
  ),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  cleanExpiredSessions: db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`),
  deleteSessionsByEmail: db.prepare('DELETE FROM sessions WHERE email = ?'),

  // --- Signup Invites ---
  createSignupInvite: db.prepare(
    `INSERT INTO signup_invites (token, business_id, expires_at) VALUES (@token, @business_id, @expires_at)`
  ),
  getSignupInvite: db.prepare(
    `SELECT si.*, b.name as business_name, b.active as business_active FROM signup_invites si JOIN businesses b ON si.business_id = b.id WHERE si.token = ? AND si.used = 0 AND si.expires_at > datetime('now')`
  ),
  getSignupInviteRaw: db.prepare('SELECT * FROM signup_invites WHERE token = ?'),
  markSignupInviteUsed: db.prepare(
    `UPDATE signup_invites SET used = 1 WHERE token = ? AND used = 0 AND expires_at > datetime('now')`
  ),
  listSignupInvites: db.prepare(
    `SELECT * FROM signup_invites WHERE business_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ),
  cleanExpiredInvites: db.prepare(
    `DELETE FROM signup_invites WHERE (used = 1 AND created_at < datetime('now', '-7 days')) OR (expires_at < datetime('now', '-7 days'))`
  ),

  // --- Data Deletion Requests ---
  createDataDeletionRequest: db.prepare(
    `INSERT INTO data_deletion_requests (confirmation_code, facebook_user_id) VALUES (?, ?)`
  ),
  getDataDeletionRequest: db.prepare(
    `SELECT * FROM data_deletion_requests WHERE confirmation_code = ?`
  ),
  cleanOldDeletionRequests: db.prepare(
    `DELETE FROM data_deletion_requests WHERE created_at < datetime('now', '-180 days')`
  ),

  // --- Knowledge Gaps ---
  createKnowledgeGap: db.prepare(`
    INSERT INTO knowledge_gaps (id, business_id, customer_phone, question, ai_response, gap_type, status)
    VALUES (@id, @business_id, @customer_phone, @question, @ai_response, @gap_type, 'pending')
  `),
  getKnowledgeGap: db.prepare('SELECT * FROM knowledge_gaps WHERE id = ?'),
  listKnowledgeGaps: db.prepare(
    `SELECT * FROM knowledge_gaps WHERE business_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ),
  listKnowledgeGapsByStatus: db.prepare(
    `SELECT * FROM knowledge_gaps WHERE business_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ),
  updateKnowledgeGap: db.prepare(
    `UPDATE knowledge_gaps SET status = COALESCE(@status, status), answer = COALESCE(@answer, answer), updated_at = datetime('now') WHERE id = @id`
  ),
  deleteKnowledgeGap: db.prepare('DELETE FROM knowledge_gaps WHERE id = ?'),
  getAnsweredKnowledgeGaps: db.prepare(
    `SELECT * FROM knowledge_gaps WHERE business_id = ? AND status = 'answered' ORDER BY updated_at DESC LIMIT 50`
  ),
  findSimilarKnowledgeGap: db.prepare(
    `SELECT id, status FROM knowledge_gaps WHERE business_id = ? AND question = ? AND status IN ('pending', 'answered') LIMIT 1`
  ),
  countKnowledgeGapsByStatus: db.prepare(
    `SELECT status, COUNT(*) as count FROM knowledge_gaps WHERE business_id = ? GROUP BY status`
  ),
  deleteBusinessKnowledgeGaps: db.prepare('DELETE FROM knowledge_gaps WHERE business_id = ?'),

  // --- Telegram Links ---
  createTelegramLink: db.prepare(
    `INSERT INTO telegram_links (token, business_id) VALUES (@token, @business_id)`
  ),
  getTelegramLinkByToken: db.prepare('SELECT * FROM telegram_links WHERE token = ?'),
  getPendingTelegramLinkByBusinessId: db.prepare(
    `SELECT * FROM telegram_links WHERE business_id = ? ORDER BY created_at DESC LIMIT 1`
  ),
  deleteTelegramLink: db.prepare('DELETE FROM telegram_links WHERE token = ?'),
  deleteTelegramLinksByBusiness: db.prepare('DELETE FROM telegram_links WHERE business_id = ?'),
  cleanExpiredTelegramLinks: db.prepare(
    `DELETE FROM telegram_links WHERE created_at < datetime('now', '-1 hour')`
  ),
  clearTelegramChatId: db.prepare(
    `UPDATE businesses SET boss_telegram_chat_id = NULL WHERE id = ?`
  ),

  // --- Google Calendar Invites ---
  createGoogleCalendarInvite: db.prepare(
    `INSERT INTO google_calendar_invites (token, business_id, expires_at) VALUES (@token, @business_id, @expires_at)`
  ),
  getGoogleCalendarInvite: db.prepare(
    `SELECT gci.*, b.name as business_name, b.active as business_active FROM google_calendar_invites gci JOIN businesses b ON gci.business_id = b.id WHERE gci.token = ? AND gci.used = 0 AND gci.expires_at > datetime('now')`
  ),
  getGoogleCalendarInviteRaw: db.prepare('SELECT * FROM google_calendar_invites WHERE token = ?'),
  markGoogleCalendarInviteUsed: db.prepare(
    `UPDATE google_calendar_invites SET used = 1 WHERE token = ? AND used = 0 AND expires_at > datetime('now')`
  ),
  cleanExpiredGoogleCalendarInvites: db.prepare(
    `DELETE FROM google_calendar_invites WHERE (used = 1 AND created_at < datetime('now', '-7 days')) OR (expires_at < datetime('now', '-7 days'))`
  ),

  // --- Trial Expiry ---
  expireTrials: db.prepare(
    `UPDATE businesses SET subscription_plan = 'expired' WHERE subscription_plan = 'trial' AND trial_ends_at < datetime('now') AND active = 1 RETURNING id, name`
  ),

  // --- Scrape Jobs ---
  insertScrapeJob: db.prepare(`
    INSERT INTO scrape_jobs (id, business_id, status, created_at)
    VALUES (@id, @business_id, 'pending', datetime('now'))
  `),
  getScrapeJob: db.prepare('SELECT * FROM scrape_jobs WHERE id = ?'),
  getLatestScrapeJob: db.prepare('SELECT * FROM scrape_jobs WHERE business_id = ? ORDER BY created_at DESC LIMIT 1'),
  getInProgressScrapeJob: db.prepare(`SELECT * FROM scrape_jobs WHERE business_id = ? AND status = 'in_progress' LIMIT 1`),
  updateScrapeJob: db.prepare(`
    UPDATE scrape_jobs
    SET status = COALESCE(@status, status),
        total_pages = COALESCE(@total_pages, total_pages),
        scraped_pages = COALESCE(@scraped_pages, scraped_pages),
        failed_pages = COALESCE(@failed_pages, failed_pages),
        pages_discovered = COALESCE(@pages_discovered, pages_discovered),
        error = COALESCE(@error, error),
        started_at = COALESCE(@started_at, started_at),
        completed_at = COALESCE(@completed_at, completed_at)
    WHERE id = @id
  `),

};

function decryptBusinessToken(row) {
  if (row && row.whatsapp_access_token) {
    row.whatsapp_access_token = tokenCrypto.decrypt(row.whatsapp_access_token);
  }
  return row;
}

function createBusiness({ id, name, phone_number_id, whatsapp_access_token, system_prompt, website_url, gemini_model, boss_language, scheduling_config, waba_id, boss_telegram_chat_id }) {
  const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  stmts.insertBusiness.run({
    id,
    name,
    phone_number_id: phone_number_id || null,
    whatsapp_access_token: tokenCrypto.encrypt(whatsapp_access_token || null),
    system_prompt: system_prompt || 'You are a helpful and professional business assistant. Answer customer questions based on the business context provided. Be warm, concise, and helpful.',
    website_url: website_url || null,
    gemini_model: gemini_model || config.defaultGeminiModel,
    boss_language: boss_language || 'he',
    scheduling_config: scheduling_config || null,
    waba_id: waba_id || null,
    boss_telegram_chat_id: boss_telegram_chat_id || null,
    subscription_plan: 'trial',
    trial_ends_at: trialEndsAt,
  });
  return decryptBusinessToken(stmts.getBusiness.get(id));
}

function getBusiness(id) {
  return decryptBusinessToken(stmts.getBusiness.get(id));
}

function getBusinessByPhoneNumberId(phoneNumberId) {
  return decryptBusinessToken(stmts.getBusinessByPhoneNumberId.get(phoneNumberId));
}

function listBusinesses() {
  return stmts.listBusinesses.all().map(decryptBusinessToken);
}

function updateBusiness(id, updates) {
  // Allow explicitly clearing scheduling_config by passing null when the key is present
  const clearScheduling = ('scheduling_config' in updates && updates.scheduling_config === null) ? 1 : 0;
  const encryptedUpdates = { ...updates };
  if (encryptedUpdates.whatsapp_access_token) {
    encryptedUpdates.whatsapp_access_token = tokenCrypto.encrypt(encryptedUpdates.whatsapp_access_token);
  }
  stmts.updateBusiness.run({ id, name: null, phone_number_id: null, whatsapp_access_token: null, system_prompt: null, website_url: null, gemini_model: null, boss_language: null, scheduling_config: null, waba_id: null, boss_telegram_chat_id: null, subscription_plan: null, ...encryptedUpdates, scheduling_config_clear: clearScheduling });
  return decryptBusinessToken(stmts.getBusiness.get(id));
}

function deactivateBusiness(id) {
  stmts.deactivateBusiness.run(id);
}

function activateBusiness(id) {
  stmts.activateBusiness.run(id);
}

function getBusinessIncludingInactive(id) {
  return decryptBusinessToken(stmts.getBusinessIncludingInactive.get(id));
}

function getConversation(businessId, customerPhone) {
  const row = stmts.getConversation.get(businessId, customerPhone);
  if (row) row.messages = JSON.parse(row.messages);
  return row;
}

function saveConversation(businessId, customerPhone, messages) {
  const id = `${businessId}:${customerPhone}`;
  stmts.upsertConversation.run({
    id,
    business_id: businessId,
    customer_phone: customerPhone,
    messages: JSON.stringify(messages),
  });
}

function listConversations(businessId, limit = 20, offset = 0) {
  const rows = stmts.listConversations.all(businessId, limit, offset);
  return rows.map((r) => ({ ...r, messages: JSON.parse(r.messages) }));
}

function deleteConversation(id) {
  stmts.deleteConversation.run(id);
}

function deleteOldConversations(ttlDays) {
  const result = db.prepare(
    `DELETE FROM conversations WHERE updated_at < datetime('now', ?)`
  ).run(`-${ttlDays} days`);
  if (result.changes > 0) {
    logger.info({ deleted: result.changes, ttlDays }, 'Cleaned up old conversations');
  }
  return result.changes;
}

function updateConversationSummary(businessId, customerPhone, summary) {
  stmts.updateConversationSummary.run(summary, businessId, customerPhone);
}

/**
 * Atomically update conversation summary and trim messages.
 * Uses a transaction so both operations succeed or neither does.
 * Returns false if the conversation was modified since expectedMessageCount
 * (race condition guard — another request added messages while we were summarizing).
 */
function summarizeAndTrimConversation(businessId, customerPhone, summary, recentMessages, expectedMessageCount) {
  const txn = db.transaction(() => {
    const row = stmts.getConversation.get(businessId, customerPhone);
    if (!row) return false;

    const currentMessages = JSON.parse(row.messages);
    if (currentMessages.length !== expectedMessageCount) {
      // Conversation changed while we were summarizing — save summary but don't trim
      stmts.updateConversationSummary.run(summary, businessId, customerPhone);
      return false;
    }

    stmts.updateConversationSummary.run(summary, businessId, customerPhone);
    const id = `${businessId}:${customerPhone}`;
    stmts.upsertConversation.run({
      id,
      business_id: businessId,
      customer_phone: customerPhone,
      messages: JSON.stringify(recentMessages),
    });
    return true;
  });
  return txn();
}

// --- Scraped Pages ---

function upsertScrapedPage({ business_id, url, title, page_type, content, metadata, content_hash, http_last_modified, http_etag }) {
  const existing = stmts.getScrapedPageByUrl.get(business_id, url);
  const id = existing ? existing.id : crypto.randomUUID();
  stmts.upsertScrapedPage.run({
    id,
    business_id,
    url,
    title: title || null,
    page_type: page_type || 'general',
    content: content || null,
    metadata: metadata ? JSON.stringify(metadata) : null,
    content_hash: content_hash || null,
    http_last_modified: http_last_modified || null,
    http_etag: http_etag || null,
  });
  return stmts.getScrapedPageByUrl.get(business_id, url);
}

function getScrapedPages(businessId) {
  return stmts.getScrapedPages.all(businessId).map((p) => ({
    ...p,
    metadata: p.metadata ? JSON.parse(p.metadata) : null,
  }));
}

function getScrapedPageByUrl(businessId, url) {
  const p = stmts.getScrapedPageByUrl.get(businessId, url);
  if (p && p.metadata) p.metadata = JSON.parse(p.metadata);
  return p;
}

function getScrapedPagesByType(businessId, pageType) {
  return stmts.getScrapedPagesByType.all(businessId, pageType).map((p) => ({
    ...p,
    metadata: p.metadata ? JSON.parse(p.metadata) : null,
  }));
}

function deleteBusinessScrapedPages(businessId) {
  stmts.deleteBusinessScrapedPages.run(businessId);
}

function countScrapedPages(businessId) {
  return stmts.countScrapedPages.get(businessId).count;
}

// --- Customer Memory ---

function getCustomerMemory(businessId, customerPhone) {
  const row = stmts.getCustomerMemory.get(businessId, customerPhone);
  if (row) row.facts = JSON.parse(row.facts);
  return row;
}

function saveCustomerMemory(businessId, customerPhone, facts) {
  const id = `${businessId}:${customerPhone}`;
  stmts.upsertCustomerMemory.run({
    id,
    business_id: businessId,
    customer_phone: customerPhone,
    facts: JSON.stringify(facts),
  });
}

function listCustomerMemories(businessId, limit = 20, offset = 0) {
  return stmts.listCustomerMemories.all(businessId, limit, offset).map((r) => ({
    ...r,
    facts: JSON.parse(r.facts),
  }));
}

function deleteCustomerMemory(businessId, customerPhone) {
  stmts.deleteCustomerMemory.run(businessId, customerPhone);
}

function deleteBusinessCustomerMemories(businessId) {
  stmts.deleteBusinessCustomerMemories.run(businessId);
}

// --- Knowledge Gaps ---

function createKnowledgeGap({ business_id, customer_phone, question, ai_response, gap_type }) {
  const id = crypto.randomUUID();
  stmts.createKnowledgeGap.run({
    id,
    business_id,
    customer_phone,
    question,
    ai_response: ai_response || null,
    gap_type: gap_type || 'uncertain',
  });
  return stmts.getKnowledgeGap.get(id);
}

function getKnowledgeGap(id) {
  return stmts.getKnowledgeGap.get(id);
}

function listKnowledgeGaps(businessId, { status, limit = 20, offset = 0 } = {}) {
  if (status) {
    return stmts.listKnowledgeGapsByStatus.all(businessId, status, limit, offset);
  }
  return stmts.listKnowledgeGaps.all(businessId, limit, offset);
}

function updateKnowledgeGap(id, updates) {
  stmts.updateKnowledgeGap.run({
    id,
    status: updates.status || null,
    answer: updates.answer || null,
  });
  return stmts.getKnowledgeGap.get(id);
}

function deleteKnowledgeGap(id) {
  stmts.deleteKnowledgeGap.run(id);
}

function getAnsweredKnowledgeGaps(businessId) {
  return stmts.getAnsweredKnowledgeGaps.all(businessId);
}

function findSimilarKnowledgeGap(businessId, question) {
  return stmts.findSimilarKnowledgeGap.get(businessId, question);
}

function countKnowledgeGaps(businessId) {
  const rows = stmts.countKnowledgeGapsByStatus.all(businessId);
  const counts = { pending: 0, answered: 0, dismissed: 0 };
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  return counts;
}

function deleteBusinessKnowledgeGaps(businessId) {
  stmts.deleteBusinessKnowledgeGaps.run(businessId);
}

// --- Escalations ---

function getActiveEscalation(businessId, customerPhone) {
  return stmts.getActiveEscalation.get(businessId, customerPhone);
}

function getActiveEscalationsForBoss(businessId) {
  return stmts.getActiveEscalationsForBoss.all(businessId);
}

function createEscalation(businessId, customerPhone, reason, id) {
  id = id || crypto.randomUUID();
  try {
    stmts.createEscalation.run({
      id,
      business_id: businessId,
      customer_phone: customerPhone,
      reason: reason || null,
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT' || err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      logger.warn({ businessId, customerPhone }, 'Duplicate active escalation prevented by unique index');
      return null;
    }
    throw err;
  }
  return stmts.getEscalation.get(id);
}

function resolveEscalation(id) {
  stmts.resolveEscalation.run(id);
  return stmts.getEscalation.get(id);
}

function resolveAllEscalations(businessId) {
  stmts.resolveAllEscalations.run(businessId);
}

function listEscalations(businessId, limit = 20, offset = 0) {
  return stmts.listEscalations.all(businessId, limit, offset);
}

function getEscalationByMessageId(businessId, messageId) {
  return stmts.getEscalationByMessageId.get(businessId, messageId);
}

function updateEscalationMessageId(escalationId, messageId) {
  stmts.updateEscalationMessageId.run(messageId, escalationId);
}

function updateEscalationBossResponse(escalationId) {
  stmts.updateEscalationBossResponse.run(escalationId);
}

function updateEscalationSummary(escalationId, summary) {
  stmts.updateEscalationSummary.run(summary, escalationId);
}

function getStaleEscalations(businessId, modifier) {
  return stmts.getStaleEscalations.all(businessId, modifier, modifier);
}

function getEscalation(id) {
  return stmts.getEscalation.get(id);
}

// --- Scrape Jobs ---

function insertScrapeJob(businessId) {
  const id = crypto.randomUUID();
  stmts.insertScrapeJob.run({ id, business_id: businessId });
  return stmts.getScrapeJob.get(id);
}

function getScrapeJob(id) {
  return stmts.getScrapeJob.get(id);
}

function getLatestScrapeJob(businessId) {
  return stmts.getLatestScrapeJob.get(businessId);
}

function getInProgressScrapeJob(businessId) {
  return stmts.getInProgressScrapeJob.get(businessId);
}

function updateScrapeJob(id, updates) {
  stmts.updateScrapeJob.run({
    id,
    status: null,
    total_pages: null,
    scraped_pages: null,
    failed_pages: null,
    pages_discovered: null,
    error: null,
    started_at: null,
    completed_at: null,
    ...updates,
  });
  return stmts.getScrapeJob.get(id);
}

// --- Appointments ---

function getAppointmentsByDate(businessId, dateStr) {
  return stmts.getAppointmentsByDate.all(businessId, dateStr);
}

function getAppointmentsByCustomer(businessId, customerPhone, status) {
  if (!status) {
    return stmts.getAllAppointmentsByCustomer.all(businessId, customerPhone);
  }
  return stmts.getAppointmentsByCustomer.all(businessId, customerPhone, status);
}

function createAppointment(data) {
  const id = data.id || crypto.randomUUID();
  stmts.createAppointment.run({
    id,
    business_id: data.business_id,
    customer_phone: data.customer_phone,
    customer_name: data.customer_name,
    service_id: data.service_id,
    service_name: data.service_name,
    service_duration: data.service_duration,
    start_time: data.start_time,
    end_time: data.end_time,
  });
  return stmts.getAppointment.get(id);
}

function updateAppointmentStatus(appointmentId, status) {
  stmts.updateAppointmentStatus.run(status, appointmentId);
  return stmts.getAppointment.get(appointmentId);
}

function getAppointment(appointmentId) {
  return stmts.getAppointment.get(appointmentId);
}

function listAppointments(businessId, { status, limit = 20, offset = 0 } = {}) {
  if (status) {
    return stmts.listAppointments.all(businessId, status, limit, offset);
  }
  return stmts.listAllAppointments.all(businessId, limit, offset);
}

// --- Sessions ---

function createSession({ id, email, expires_at }) {
  stmts.createSession.run({ id, email, expires_at });
  return stmts.getSession.get(id);
}

function getSession(id) {
  return stmts.getSession.get(id);
}

function deleteSession(id) {
  stmts.deleteSession.run(id);
}

function cleanExpiredSessions() {
  stmts.cleanExpiredSessions.run();
}

function deleteSessionsByEmail(email) {
  stmts.deleteSessionsByEmail.run(email);
}

// --- Signup Invites ---

function createSignupInvite(businessId, token, expiresAt) {
  stmts.createSignupInvite.run({ token, business_id: businessId, expires_at: expiresAt });
  return stmts.getSignupInviteRaw.get(token);
}

function getSignupInvite(token) {
  return stmts.getSignupInvite.get(token);
}

function getSignupInviteRaw(token) {
  return stmts.getSignupInviteRaw.get(token);
}

function markSignupInviteUsed(token) {
  const result = stmts.markSignupInviteUsed.run(token);
  return result.changes > 0;
}

function listSignupInvites(businessId, limit = 20, offset = 0) {
  return stmts.listSignupInvites.all(businessId, limit, offset);
}

function cleanExpiredInvites() {
  stmts.cleanExpiredInvites.run();
}

// --- Data Deletion Requests ---

function createDataDeletionRequest(confirmationCode, facebookUserId) {
  stmts.createDataDeletionRequest.run(confirmationCode, facebookUserId);
  return stmts.getDataDeletionRequest.get(confirmationCode);
}

function getDataDeletionRequest(confirmationCode) {
  return stmts.getDataDeletionRequest.get(confirmationCode);
}

function cleanOldDeletionRequests() {
  stmts.cleanOldDeletionRequests.run();
}

// --- Telegram Links ---

function createTelegramLink(token, businessId) {
  stmts.createTelegramLink.run({ token, business_id: businessId });
  return stmts.getTelegramLinkByToken.get(token);
}

function getTelegramLinkByToken(token) {
  return stmts.getTelegramLinkByToken.get(token);
}

function getPendingTelegramLinkByBusinessId(businessId) {
  return stmts.getPendingTelegramLinkByBusinessId.get(businessId);
}

function deleteTelegramLink(token) {
  stmts.deleteTelegramLink.run(token);
}

function deleteTelegramLinksByBusiness(businessId) {
  stmts.deleteTelegramLinksByBusiness.run(businessId);
}

function cleanExpiredTelegramLinks() {
  stmts.cleanExpiredTelegramLinks.run();
}

function clearTelegramChatId(businessId) {
  stmts.clearTelegramChatId.run(businessId);
}

// --- Google Calendar Invites ---

function createGoogleCalendarInvite(businessId, token, expiresAt) {
  stmts.createGoogleCalendarInvite.run({ token, business_id: businessId, expires_at: expiresAt });
  return stmts.getGoogleCalendarInviteRaw.get(token);
}

function getGoogleCalendarInvite(token) {
  return stmts.getGoogleCalendarInvite.get(token);
}

function markGoogleCalendarInviteUsed(token) {
  const result = stmts.markGoogleCalendarInviteUsed.run(token);
  return result.changes > 0;
}

function cleanExpiredGoogleCalendarInvites() {
  stmts.cleanExpiredGoogleCalendarInvites.run();
}

// --- Trial Expiry ---

function expireTrials() {
  return stmts.expireTrials.all();
}

module.exports = {
  db,
  createBusiness,
  getBusiness,
  getBusinessByPhoneNumberId,
  listBusinesses,
  updateBusiness,
  deactivateBusiness,
  activateBusiness,
  getBusinessIncludingInactive,
  getConversation,
  saveConversation,
  listConversations,
  deleteConversation,
  deleteOldConversations,
  updateConversationSummary,
  summarizeAndTrimConversation,
  upsertScrapedPage,
  getScrapedPages,
  getScrapedPageByUrl,
  getScrapedPagesByType,
  deleteBusinessScrapedPages,
  countScrapedPages,
  insertScrapeJob,
  getScrapeJob,
  getLatestScrapeJob,
  getInProgressScrapeJob,
  updateScrapeJob,
  getCustomerMemory,
  saveCustomerMemory,
  listCustomerMemories,
  deleteCustomerMemory,
  deleteBusinessCustomerMemories,
  createKnowledgeGap,
  getKnowledgeGap,
  listKnowledgeGaps,
  updateKnowledgeGap,
  deleteKnowledgeGap,
  getAnsweredKnowledgeGaps,
  findSimilarKnowledgeGap,
  countKnowledgeGaps,
  deleteBusinessKnowledgeGaps,
  getActiveEscalation,
  getActiveEscalationsForBoss,
  getEscalationByMessageId,
  updateEscalationMessageId,
  updateEscalationBossResponse,
  updateEscalationSummary,
  getStaleEscalations,
  createEscalation,
  resolveEscalation,
  resolveAllEscalations,
  listEscalations,
  getEscalation,
  getAppointmentsByDate,
  getAppointmentsByCustomer,
  createAppointment,
  updateAppointmentStatus,
  getAppointment,
  listAppointments,
  createSession,
  getSession,
  deleteSession,
  cleanExpiredSessions,
  deleteSessionsByEmail,
  createSignupInvite,
  getSignupInvite,
  getSignupInviteRaw,
  markSignupInviteUsed,
  listSignupInvites,
  cleanExpiredInvites,
  createDataDeletionRequest,
  getDataDeletionRequest,
  cleanOldDeletionRequests,
  createTelegramLink,
  getTelegramLinkByToken,
  getPendingTelegramLinkByBusinessId,
  deleteTelegramLink,
  deleteTelegramLinksByBusiness,
  cleanExpiredTelegramLinks,
  clearTelegramChatId,
  createGoogleCalendarInvite,
  getGoogleCalendarInvite,
  markGoogleCalendarInviteUsed,
  cleanExpiredGoogleCalendarInvites,
  expireTrials,
};
