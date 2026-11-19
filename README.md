# AiYelet (איילת)

**Your business works 24/7 with AiYelet on WhatsApp.**

AiYelet is an AI WhatsApp assistant for businesses: automated customer service, smart appointment scheduling, and seamless human escalation, all through WhatsApp.

🌐 [aiyelet.co](https://aiyelet.co/)

## Features

- **AI chat with a custom personality** in Hebrew, Arabic, and English
- **Understands images and voice messages**
- **Self-learning knowledge base**: scrapes the business website and flags questions it couldn't answer
- **Appointment scheduling** with Google Calendar, Calendly, Cal.com, Acuity, Square, or a built-in calendar
- **Human escalation** with instant Telegram alerts to the business owner
- **Customer memory** and automatic summarization of long chats
- **One-click WhatsApp setup** via Meta Embedded Signup

Built for salons, clinics, restaurants, gyms, and any business that talks to customers on WhatsApp.

## How it works

1. **Connect** your WhatsApp number
2. **Configure** AiYelet: set the personality, scrape your website, connect your calendar
3. **Done**: AiYelet answers customers, books appointments, and escalates when needed, around the clock

## Tech stack

Node.js · Express · SQLite (better-sqlite3) · Google Gemini · Meta WhatsApp Cloud API · Telegram Bot API

## Getting started

```bash
npm install
cp .env.example .env   # add your GEMINI_API_KEY and other settings
npm run dev            # start with auto-reload
```

The admin dashboard is served at `/admin`. Run the test suite with `npm test`.

See [`PRODUCTION.md`](PRODUCTION.md) for deployment notes.

## License

[MIT](LICENSE) © 2025-2026 LUCON LABS
