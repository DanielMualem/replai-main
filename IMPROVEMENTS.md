# ReplAI — Humanization & Feature Improvements

## Current State

ReplAI has basic humanization. Messages get buffered for 5s, then marked as read (blue checkmarks) with a typing indicator shown while the AI generates a reply. No message splitting, no media — just raw text.

---

## Tier 1 — Low-Hanging Fruit (high impact, relatively easy)

### ~~1. Typing Indicators + Read Receipts~~ ✅ Done

Implemented in `whatsapp.js`. After the message buffer flushes: mark as read → 500ms pause → typing indicator → AI generation → send reply. Typing indicator auto-dismisses after 25s or when the reply is sent.

### 2. Dynamic Response Delays

Don't reply in 200ms. Calculate a delay based on the response length (simulating typing speed ~40-60 WPM):

- A short "Yes!" gets ~1s delay
- A medium answer gets ~2-3s delay
- A 3-paragraph answer gets ~4-5s delay

Research confirms dynamic delays increase perceived humanness ("Faster Is Not Always Better" — ResearchGate).

### 3. Message Splitting

Instead of one wall of text, split long responses into 2-4 shorter messages with brief pauses (300-800ms) between them. This is how humans actually chat on WhatsApp — rapid-fire short messages, not essays. Each chunk gets its own typing indicator before being sent.

### 4. Time-Aware Greetings & Pacing

We already inject Israel date/time into the system prompt. Use it more:

- "Good morning!" at 9am, "Good evening!" at 8pm
- Slower/shorter replies at late night hours (a real employee wouldn't write essays at 2am)
- Adjust formality by time of day

---

## Tier 2 — Medium Effort, High Impact

### 5. Emoji Reactions to Messages

The Cloud API supports sending emoji reactions (thumbs up, check mark, etc.) to specific messages via `sendReaction()` with a message ID and emoji parameter. React to a customer's message *before* typing a full response — this is extremely common human behavior on WhatsApp.

A quick "👍" reaction while the full answer is being typed feels very natural. Tiny effort, massive human signal.

### 6. Sentiment-Adaptive Tone

Detect frustration signals in incoming messages:

- ALL CAPS = shouting/frustration
- Excessive punctuation (!!!, ???) = urgency/frustration
- Short, terse replies = possible annoyance
- Rapid follow-up messages = impatience

When frustrated → respond calmly, acknowledge feelings first, keep it simple. When happy → mirror the energy. This can be done via prompt engineering (instruct Gemini to analyze tone) without a separate ML model.

**Caveat:** A 2025 Nielsen Norman Group study found that overly warm/empathetic language caused 10-30% higher error rates. Use sentiment adaptation sparingly — never sacrifice accuracy for warmth.

### ~~7. Customer Memory / Personalization~~ ✅ Done

Implemented via the hybrid approach: `customer_memory` table stores per-customer facts (name, language, notes) as JSON keyed by `business_id + customer_phone`. After each reply, an async `gemini-2.0-flash-lite` call extracts facts from the exchange and merges them into stored memory. On the next request, stored facts are injected into the system prompt alongside the existing conversation history. Admin API endpoints (`/api/businesses/:id/customers/*`) allow viewing, updating, and clearing customer memory.

### 8. Voice Notes

The Cloud API supports sending audio/voice notes (OGG with OPUS codec). For warm greetings, complex explanations, or emotional situations, a voice note feels incredibly human.

Use a TTS API (Google Cloud TTS, ElevenLabs) to generate them. This would be a major differentiator — almost no business bots do this.

---

## Tier 3 — Game Changers

### 9. Interactive Messages (Buttons & Lists)

No template approval needed. Supported types:

- **Quick Reply Buttons:** Up to 3 preset reply buttons for yes/no/maybe type questions
- **List Messages:** Up to 10 selectable items in sections — ideal for appointment slots, product categories, menus
- **Call-to-Action Buttons:** Up to 2 buttons — one for calling, one for visiting a URL

These dramatically improve UX and conversion while reducing ambiguity.

### 10. Proactive Outbound Messaging

Don't just respond — reach out:

- Appointment reminders
- Order updates
- Follow-ups ("Hey, it's been a week since your consultation — any questions?")
- Personalized product recommendations based on past interactions

Requires template messages (WhatsApp approval needed) but transforms the bot from reactive to proactive. This is what separates a tool from an employee.

### 11. Smart Human Escalation

Detect when the bot can't help or the customer is getting increasingly frustrated:

- Recognize when human intervention is needed
- Seamlessly hand off with full context (conversation history, detected sentiment, customer profile)
- "Let me connect you with [Name] who can help better with this"
- Notify business owner via email/Slack/WhatsApp

Studies show this reduces support escalations by up to 40% because catching frustration early prevents it from compounding.

### 12. Image & Document Handling

Accept and understand images customers send (product photos, screenshots of issues). Send images back (product catalogs, receipts, location maps).

Gemini is multimodal — we can already process images. Supported media types:

- Images (JPEG, PNG, WEBP) with optional captions
- Videos (MP4, 3GPP) with optional captions
- Documents (PDF, DOCX, XLSX, ZIP) with optional captions
- Stickers (WEBP) — static and animated

Almost no competing bots handle this well.

### 13. Multi-Language with Auto-Detection

Detect the customer's language from their first message and respond in that language automatically. Hebrew, Arabic, English, Russian — whatever the customer uses.

Store the language preference per customer. Gemini handles multilingual natively — just instruct it in the system prompt.

---

## Tier 4 — Ambitious but Differentiating

### 14. Conversation Style Mirroring

Some customers write one word at a time. Others write paragraphs. Mirror their style:

- If they're brief, be brief
- If they're detailed, be detailed
- If they use emojis, use emojis back
- Match formality level: casual language → casual response, formal → formal

This can be prompt-engineered by analyzing the customer's recent messages and instructing Gemini accordingly.

### 15. Context-Aware "I Don't Know" Behavior

When the bot doesn't have info from the scraped website, instead of hallucinating:

> "Great question — I'm not 100% sure about that. Let me check with the team and get back to you."

Then flag it for the business owner. This builds trust massively. Requires a notification/flagging system for unanswered questions.

### 16. Action Execution

Move beyond Q&A:

- Book appointments (Google Calendar integration)
- Process simple orders
- Send location pins for directions
- Share contact cards
- Schedule callbacks

The bot becomes an actual employee, not just an FAQ machine.

---

## Implementation Priority

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| ~~1~~ | ~~Typing indicators + read receipts~~ | ~~Low~~ | ~~Very High~~ ✅ |
| 2 | Message splitting | Low | High |
| 3 | Emoji reactions | Low | High |
| ~~4~~ | ~~Customer memory / personalization~~ | ~~Medium~~ | ~~Very High~~ ✅ |
| 5 | Interactive buttons / lists | Medium | High |
| 6 | Sentiment-adaptive tone | Medium | Medium |
| 7 | Multi-language auto-detection | Low | High |
| 8 | Image & document handling | Medium | High |
| 9 | Smart human escalation | High | Very High |
| 10 | Voice notes | Medium | Medium |
| 11 | Proactive outbound messaging | High | Very High |
| 12 | Action execution | Very High | Very High |

---

## WhatsApp 2026 AI Policy Note

Starting January 15, 2026, WhatsApp blocks general-purpose AI chatbots and services that share chat data for model training or simulate broad AI assistants. **What is allowed:** structured, purpose-specific chatbots providing clearly defined services (customer support, bookings, order tracking, notifications, surveys). AI functionality is permitted when it enhances rather than replaces the defined service. ReplAI is compliant since each bot serves a specific business purpose.
