# Production Readiness Guide

## 1. Critical (before going live)

- [x] **Revoke exposed API keys.** `.env` has real Gemini key and WhatsApp verify token. Rotate immediately. Remove `.env_old` from the repo. *(`.env_old` was never tracked in git; keys rotated.)*
- [x] **Add input validation.** Request bodies validated with `zod` via `src/validation.js`. Schemas for business create/update, chat messages, and customer memory with string length limits, phone format, URL, and scheduling_config validation. `validate()` middleware on POST/PATCH routes in `admin.js`.
- [x] **Add request body size limits.** `express.json({ limit: '100kb' })` in `src/index.js`.
- [x] **Enforce webhook signature verification.** In production (`NODE_ENV=production`), server refuses to start without `WHATSAPP_APP_SECRET`. Dev mode keeps warning-only behavior.
- [x] **Encrypt WhatsApp tokens at rest.** AES-256-GCM encryption via `src/services/crypto.js`. Set `TOKEN_ENCRYPTION_KEY` env var. Tokens encrypted on write, decrypted on read. Startup migration auto-encrypts existing plaintext tokens. Production refuses to start without the key.
- [x] **Add Gemini API timeout + retry.** 30s timeout (`GEMINI_TIMEOUT_MS`) and 2 retries (`GEMINI_RETRIES`) with exponential backoff (1s, 2s). Retries on network errors, 429, 503. `extractCustomerFacts` uses 15s timeout and 1 retry.
- [x] **Require admin auth in production.** Server refuses to start without `ADMIN_API_KEY` or Google OAuth configured. If Google OAuth is enabled but `GOOGLE_ALLOWED_EMAILS` is empty, server also refuses to start (all logins would fail silently).
- [x] **Enforce secure cookies in production.** Session cookies always set `secure: true` in production regardless of `BASE_URL` setting.
- [x] **Prevent duplicate active escalations.** Partial unique index on `escalations(business_id, customer_phone) WHERE status = 'active'` prevents race conditions from concurrent buffer flushes creating multiple active escalations.
- [x] **Cap CSRF state map.** `cleanCsrfStates()` enforces a cap of 1000 entries and runs in the hourly maintenance cycle.
- [x] **Session cleanup at startup.** Expired sessions are cleaned on server start and hourly. New OAuth logins remove prior sessions for the same email.
- [x] **Serialize customer memory updates.** Per-customer locks prevent concurrent read-extract-merge-write races in `updateCustomerMemory()`.

## 2. High Priority (before scaling to multiple businesses)

- [x] **Add health endpoint.** `GET /health` checks DB connectivity and returns uptime.
- [ ] **Add a Dockerfile.** No container config exists.
- [x] **Add conversation TTL/cleanup.** `deleteOldConversations(ttlDays)` in `db.js`, called hourly. Default: 90 days (`CONVERSATION_TTL_DAYS`).
- [x] **Add observability.** Request correlation IDs (`req.id` via `crypto.randomUUID()`), Sentry error tracking (`SENTRY_DSN`), `unhandledRejection`/`uncaughtException` process handlers, security headers via `helmet`.
- [x] **Rate-limit Gemini calls per business.** In-memory sliding window: `GEMINI_RATE_LIMIT_PER_BUSINESS` (default 60/hour). Returns friendly "busy" message when exceeded.
- [ ] **Add CORS headers** if exposing the admin API to a frontend.

## 3. Medium Priority (operational maturity)

- [x] Database backups — automated daily via `deploy/backup.sh`
- [x] Secrets management — `_FILE` suffix convention for Docker/systemd secrets (e.g. `GEMINI_API_KEY_FILE=/run/secrets/key`), `.env` permission check, pino log redaction
- [ ] Admin audit logging (who changed what business config)
- [ ] Multi-admin support with row-level access control
- [ ] Conversation analytics dashboard
- [ ] WhatsApp token rotation strategy
- [ ] CI/CD pipeline with tests

---

## Cost Estimates

### ~10 businesses, ~50 conversations/day each (~500 msgs/day total)

| Component | Service | Monthly Cost |
|---|---|---|
| Server | Hetzner CX22 (2 vCPU, 4GB RAM, 40GB SSD) | ~$4.50 |
| Database | SQLite on disk (free) | $0 |
| SSL | Let's Encrypt | $0 |
| Reverse proxy | Nginx | $0 |
| Backups | Hetzner snapshots | ~$1.50 |
| WhatsApp Cloud API | Meta | $30–75 |
| Gemini AI (2.5 Flash) | Google | $5–25 |
| Monitoring | Sentry + Betterstack free tiers | $0 |
| Domain | Cloudflare (free) + registrar | $1–2 |
| **Total** | | **~$40–105/mo** |

### ~100 businesses, ~5,000 msgs/day

| Component | Service | Monthly Cost |
|---|---|---|
| Server | Hetzner CX32 (4 vCPU, 8GB RAM) | ~$8.50 |
| WhatsApp Cloud API | Meta | $300–750 |
| Gemini AI | Google | $50–150 |
| **Total** | | **~$400–975/mo** |

### WhatsApp Cloud API pricing

- User-initiated conversations (customer texts first): ~$0.005–0.03 per 24h conversation window
- Business-initiated (templates): ~$0.03–0.08 per conversation
- First 1,000 service conversations/month free per WhatsApp Business Account
- Each business on a separate WABA gets its own 1,000 free

### Gemini 2.5 Flash pricing

- Input: $0.15 per 1M tokens
- Output: $0.60 per 1M tokens
- Free tier: 15 RPM, 1M tokens/day (testing only, not production)
- Average message: ~2,000 input tokens + ~200 output tokens

---

## Recommended Infrastructure: Hetzner VPS

### Why Hetzner over PaaS (Railway/Render)

- 4–5x more resources for the same price
- Persistent filesystem means SQLite works (no forced Postgres migration)
- CX22 at $4.50/mo handles dozens of businesses
- Full control over the stack

### One-time server setup

```bash
# 1. Create Hetzner CX22 VPS (Ubuntu 24.04)

# 2. SSH in and secure the server
ufw allow 22,80,443
ufw enable

# 3. Install Node.js
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 4. Install Nginx
sudo apt-get install -y nginx

# 5. Configure Nginx as reverse proxy
# /etc/nginx/sites-available/replai
# server {
#     server_name yourdomain.com;
#     location / {
#         proxy_pass http://127.0.0.1:3000;
#         proxy_set_header Host $host;
#         proxy_set_header X-Real-IP $remote_addr;
#         proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
#         proxy_set_header X-Forwarded-Proto $scheme;
#     }
# }

# 6. Set up SSL
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com

# 7. Clone repo and install
git clone <repo-url> /opt/replai
cd /opt/replai && npm install --production

# 8. Create systemd service (/etc/systemd/system/replai.service)
# [Unit]
# Description=ReplAI WhatsApp Chatbot
# After=network.target
#
# [Service]
# Type=simple
# User=replai
# WorkingDirectory=/opt/replai
# EnvironmentFile=/opt/replai/.env
# ExecStart=/usr/bin/node src/index.js
# Restart=on-failure
# RestartSec=5
#
# [Install]
# WantedBy=multi-user.target

sudo systemctl enable replai
sudo systemctl start replai

# 9. Set up daily SQLite backup (crontab -e)
# 0 3 * * * sqlite3 /opt/replai/data/replai.db ".backup /opt/replai/backups/replai-$(date +\%Y\%m\%d).db"
```

### When to upgrade from Hetzner VPS

- Need multi-region / auto-scaling (200+ businesses)
- Need zero-downtime deploys out of the box
- Don't want to maintain a server at all → switch to Railway ($12–22/mo) with managed Postgres

---

## Completed Migrations

### Scheduling: Markers → Gemini Function Calling (done)

Replaced text marker regex system (`[CHECK_AVAILABILITY]`, `[BOOK_SLOT]`, etc.) with Gemini native function calling. The function calling loop now runs inside `generateReply()` in `gemini.js`, so callers (`whatsapp.js`, `admin.js`) get clean text directly. Scheduling logic lives in `src/services/scheduling/tools.js`. The old `markers.js` was deleted.
