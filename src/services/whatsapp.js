const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const logger = require('../logger');
const db = require('./db');
const gemini = require('./gemini');
const messageBuffer = require('./message-buffer');
const calendar = require('./calendar');
const telegram = require('./telegram');
const { canAccess } = require('../middleware/plan-gate');

const ESCALATION_MESSAGES = {
  he: {
    connecting: 'אני מעבירה אותך לנציג שיוכל לעזור. אנא המתן — תקבל מענה בקרוב.',
    backToAI: 'חזרת לשוחח עם העוזרת הדיגיטלית שלנו. איך אפשר לעזור?',
    fallback: 'מצטערת, אני לא יכולה לעזור עם זה כרגע. אנא צור איתנו קשר ישירות.',
    expired: 'הפנייה שלך נסגרה כי עבר זמן רב. אנא שלח הודעה חדשה ונשמח לעזור.',
  },
  ar: {
    connecting: 'سأقوم بتوصيلك بأحد أعضاء الفريق الذي يمكنه المساعدة. يرجى الانتظار — ستتلقى ردًا قريبًا.',
    backToAI: 'عدت للتحدث مع المساعدة الرقمية. كيف يمكنني مساعدتك؟',
    fallback: 'عذرًا، لا أستطيع المساعدة في هذا الآن. يرجى التواصل معنا مباشرة.',
    expired: 'تم إغلاق طلبك بسبب مرور وقت طويل. يرجى إرسال رسالة جديدة وسنسعد بمساعدتك.',
  },
  en: {
    connecting: "I'm connecting you with a team member who can help. Please hold on — you'll hear back shortly.",
    backToAI: "You're back with our AI assistant. How can I help you?",
    fallback: "I'm sorry, I can't help with this right now. Please contact us directly.",
    expired: "Your support request has been closed due to inactivity. Please send a new message and we'll be happy to help.",
  },
};

const BOSS_NOTIFY_TEMPLATES = {
  he: {
    needsHelp: (label) => `🚨 לקוח ${label} צריך עזרה`,
    reason: (reason) => `סיבה:\n${reason}`,
    summary: '📝 סיכום:',
  },
  ar: {
    needsHelp: (label) => `🚨 العميل ${label} يحتاج مساعدة:`,
    reason: (reason) => `السبب: ${reason}`,
    summary: '📝 ملخص:',
  },
  en: {
    needsHelp: (label) => `🚨 Customer ${label} needs help:`,
    reason: (reason) => `Reason: ${reason}`,
    summary: '📝 Summary:',
  },
};

const BOSS_BOOKING_TEMPLATES = {
  he: (label, service, date, time) => `📅 תור חדש!\n\nלקוח: ${label}\nשירות: ${service}\nתאריך: ${date}\nשעה: ${time}`,
  ar: (label, service, date, time) => `📅 موعد جديد!\nالعميل: ${label}\nالخدمة: ${service}\nالتاريخ: ${date}\nالوقت: ${time}`,
  en: (label, service, date, time) => `📅 New appointment!\nCustomer: ${label}\nService: ${service}\nDate: ${date}\nTime: ${time}`,
};

const BOSS_CALENDAR_LINK_LABEL = {
  he: 'הכנס ליומן',
  ar: 'أضف إلى التقويم',
  en: 'Add to calendar',
};

const CUSTOMER_CALENDAR_LINK_LABEL = {
  he: 'הוספה ליומן',
  ar: 'إضافة إلى التقويم',
  en: 'Add to calendar',
};

const COEXISTENCE_INSTRUCTIONS = {
  he: 'פתח את WhatsApp Business כדי לענות.',
  ar: 'افتح WhatsApp Business للرد.',
  en: 'Open WhatsApp Business to respond.',
};

const LINK_LABELS = {
  resume: { he: 'חזרה לבוט', ar: 'العودة للبوت', en: 'Resume Bot' },
};

function detectLanguage(text) {
  if (/[\u0590-\u05FF]/.test(text)) return 'he';
  if (/[\u0600-\u06FF]/.test(text)) return 'ar';
  return 'en';
}

function getEscalationMessage(key, customerMessage) {
  const lang = detectLanguage(customerMessage || '');
  return ESCALATION_MESSAGES[lang]?.[key] || ESCALATION_MESSAGES.en[key];
}

function isEscalationExpired(escalation) {
  const reference = escalation.last_boss_response_at || escalation.created_at;
  const refTime = new Date(reference + 'Z').getTime();
  const now = Date.now();
  return (now - refTime) / (1000 * 60 * 60) > config.escalationTimeoutHours;
}

const GRAPH_API_BASE = `https://graph.facebook.com/${config.whatsappApiVersion}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function markdownToWhatsApp(text) {
  // Convert Markdown bold **text** to WhatsApp bold *text*
  return text.replace(/\*\*(.+?)\*\*/g, '*$1*');
}

async function sendMessage(phoneNumberId, accessToken, to, text) {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;
  try {
    const res = await axios.post(url, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: markdownToWhatsApp(text) },
    }, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.data;
  } catch (err) {
    const detail = err.response?.data?.error || err.response?.data || err.message;
    logger.error({ phoneNumberId, to, detail }, 'WhatsApp sendMessage failed');
    throw err;
  }
}

async function markAsRead(phoneNumberId, accessToken, messageId) {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;
  await axios.post(url, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  }, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function showTypingIndicator(phoneNumberId, accessToken, messageId) {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;
  try {
    await axios.post(url, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    }, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    const detail = err.response?.data?.error || err.response?.data || err.message;
    logger.error({ phoneNumberId, messageId, detail }, 'WhatsApp showTypingIndicator failed');
    throw err;
  }
}

const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // 10 MB

async function downloadMedia(mediaId, accessToken) {
  // Step 1: get temporary download URL
  const metaRes = await axios.get(`${GRAPH_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const downloadUrl = metaRes.data.url;

  // Step 2: download the binary
  const dataRes = await axios.get(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    responseType: 'arraybuffer',
    maxContentLength: MAX_MEDIA_BYTES,
    timeout: 10000,
  });

  const buf = Buffer.from(dataRes.data);

  // Strip codec params (e.g. "audio/ogg; codecs=opus" → "audio/ogg")
  const rawMime = dataRes.headers['content-type'] || 'application/octet-stream';
  const mimeType = rawMime.split(';')[0].trim();

  return { base64: buf.toString('base64'), mimeType };
}

function formatPhone(phone) {
  return phone && !phone.startsWith('+') ? `+${phone}` : phone;
}

function getCustomerLabel(businessId, customerPhone) {
  const memory = db.getCustomerMemory(businessId, customerPhone);
  return memory?.facts?.name || formatPhone(customerPhone);
}

function getLastUserMessage(conversation) {
  return conversation?.messages?.filter(m => m.role === 'user').pop()?.content || '';
}

function saveAndTrimHistory(businessId, customerPhone, history, ...newMessages) {
  const updated = [...history, ...newMessages];
  const trimmed = updated.slice(-config.maxConversationMessages * 2);
  db.saveConversation(businessId, customerPhone, trimmed);
  return trimmed;
}

async function notifyBossBooking(business, phoneNumberId, customerPhone, bookingResult, customerMessage) {
  if (!business.boss_telegram_chat_id || !telegram.isConfigured() || !bookingResult || !bookingResult.success) return;
  if (!canAccess(business, 'booking_notifications')) return;

  try {
    const label = getCustomerLabel(business.id, customerPhone);
    const lang = business.boss_language || 'he';
    const tz = business.scheduling_config
      ? (typeof business.scheduling_config === 'string' ? JSON.parse(business.scheduling_config) : business.scheduling_config).timezone || 'Asia/Jerusalem'
      : 'Asia/Jerusalem';

    const startDate = new Date(bookingResult.start_time);
    const date = startDate.toLocaleDateString('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = bookingResult.formatted_start_time || startDate.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const service = bookingResult.service_name || 'N/A';

    const tpl = BOSS_BOOKING_TEMPLATES[lang] || BOSS_BOOKING_TEMPLATES.he;
    let text = tpl(label, service, date, time);

    let calLink = null;
    if (config.baseUrl) {
      const calId = calendar.storeBooking(bookingResult, label, business.name, 'boss');
      const calLabel = BOSS_CALENDAR_LINK_LABEL[lang] || BOSS_CALENDAR_LINK_LABEL.he;
      calLink = `${config.baseUrl}/cal/${calId}`;
      text += `\n\n🔗 ${calLabel}: ${calLink}`;
    }

    await telegram.sendMessage(business.boss_telegram_chat_id, text);
    logger.info({ businessId: business.id, customerPhone }, 'Boss notified of customer booking');
  } catch (err) {
    logger.warn({ businessId: business.id, customerPhone, error: err.message }, 'Failed to notify boss of booking');
  }
}

async function handleEscalationTrigger(business, phoneNumberId, customerPhone, history, combined, escalationReason, reply) {
  const summaryHistory = [...history, { role: 'user', content: combined }];
  const summary = await gemini.summarizeConversation(business, summaryHistory);

  const escalationId = crypto.randomUUID();

  // Build boss notification
  const label = getCustomerLabel(business.id, customerPhone);
  const labelFull = label !== formatPhone(customerPhone) ? `${label} (${formatPhone(customerPhone)})` : formatPhone(customerPhone);
  const lang = business.boss_language || 'he';
  const tpl = BOSS_NOTIFY_TEMPLATES[lang] || BOSS_NOTIFY_TEMPLATES.en;
  let notifyText = `${tpl.needsHelp(labelFull)}\n\n${tpl.reason(escalationReason)}`;
  if (summary) {
    notifyText += `\n\n${tpl.summary}\n${summary}`;
  }
  notifyText += `\n\n${COEXISTENCE_INSTRUCTIONS[lang] || COEXISTENCE_INSTRUCTIONS.en}\n`;

  if (config.baseUrl) {
    notifyText += `\n🤖 ${LINK_LABELS.resume[lang] || LINK_LABELS.resume.en}: ${config.baseUrl}/resume/${escalationId}`;
  }

  if (business.boss_telegram_chat_id && telegram.isConfigured()) {
    await telegram.sendMessage(business.boss_telegram_chat_id, notifyText);
  }

  // Create escalation and tell customer
  const connectingMsg = getEscalationMessage('connecting', combined);
  await sendMessage(phoneNumberId, business.whatsapp_access_token, customerPhone, connectingMsg);

  const escalation = db.createEscalation(business.id, customerPhone, escalationReason, escalationId);
  if (!escalation) {
    logger.info({ businessId: business.id, customerPhone }, 'Duplicate escalation prevented (concurrent request)');
    saveAndTrimHistory(business.id, customerPhone, history,
      { role: 'user', content: combined },
      { role: 'assistant', content: connectingMsg });
    return;
  }
  if (summary) {
    db.updateEscalationSummary(escalation.id, summary);
  }

  saveAndTrimHistory(business.id, customerPhone, history,
    { role: 'user', content: combined },
    { role: 'assistant', content: connectingMsg });

  logger.info({ businessId: business.id, customerPhone, reason: escalationReason }, 'Escalation triggered');

  gemini.updateCustomerMemory(business, customerPhone, combined, reply).catch(() => {});
}

async function handleIncomingMessage(value) {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) {
    logger.warn('Webhook payload missing phone_number_id');
    return;
  }

  const business = db.getBusinessByPhoneNumberId(phoneNumberId);
  if (!business) {
    logger.warn({ phoneNumberId }, 'No business found for phone_number_id');
    return;
  }

  // Expired plan: send paused message without processing further
  if (business.subscription_plan === 'expired') {
    const msg0 = value.messages?.[0];
    if (msg0?.type === 'text' && msg0.from) {
      await sendMessage(phoneNumberId, business.whatsapp_access_token, msg0.from,
        'שירות זה מושהה כרגע. אנא פנו לבעל העסק לפרטים נוספים.\n\nThis service is currently paused. Please contact the business owner for more information.');
    }
    return;
  }

  const messages = value.messages;
  if (!messages || messages.length === 0) return;

  for (const msg of messages) {
    let text = null, mediaData = null;
    if (msg.type === 'text' && msg.text?.body) {
      text = msg.text.body;
    } else if (msg.type === 'image' && msg.image?.id) {
      text = msg.image.caption || '[Image]';
      try {
        mediaData = await downloadMedia(msg.image.id, business.whatsapp_access_token);
      } catch (err) {
        logger.warn({ businessId: business.id, error: err.message }, 'Failed to download image');
      }
    } else if (msg.type === 'audio' && msg.audio?.id) {
      const langHints = { he: 'Hebrew (עברית)', ar: 'Arabic (العربية)', en: 'English' };
      const hint = langHints[business.boss_language] || langHints.he;
      text = `[Voice message — the customer may be speaking ${hint}]`;
      try {
        mediaData = await downloadMedia(msg.audio.id, business.whatsapp_access_token);
      } catch (err) {
        logger.warn({ businessId: business.id, error: err.message }, 'Failed to download audio');
      }
    } else {
      continue;
    }

    const customerPhone = msg.from;

    logger.info({ businessId: business.id, customerPhone, type: msg.type }, 'Incoming message');

    const bufferKey = `${business.id}:${customerPhone}`;

    messageBuffer.add(bufferKey, { text, messageId: msg.id, media: mediaData }, async (items) => {
      const combined = items.map((i) => i.text).join('\n');
      const media = items.filter((i) => i.media).map((i) => i.media);
      const lastMessageId = items[items.length - 1].messageId;
      logger.info(
        { businessId: business.id, customerPhone, messageCount: items.length },
        'Processing buffered messages',
      );

      try {
        // Mark as read (blue checkmarks)
        try {
          await markAsRead(phoneNumberId, business.whatsapp_access_token, lastMessageId);
        } catch (err) {
          logger.warn({ businessId: business.id, error: err.message }, 'Failed to mark as read');
        }

        await sleep(500);

        // Check 2: Is there an active escalation for this customer?
        const activeEscalation = db.getActiveEscalation(business.id, customerPhone);
        if (activeEscalation) {
          if (isEscalationExpired(activeEscalation)) {
            db.resolveEscalation(activeEscalation.id);
            logger.info({ businessId: business.id, escalationId: activeEscalation.id }, 'Escalation auto-expired');
            // Notify customer that escalation expired
            const conv = db.getConversation(business.id, customerPhone);
            const expiredMsg = getEscalationMessage('expired', getLastUserMessage(conv));
            await sendMessage(phoneNumberId, business.whatsapp_access_token, customerPhone, expiredMsg);
            // Fall through to normal AI flow
          } else {
            // Coexistence: save to history, don't forward (boss sees messages in WhatsApp Business app)
            const conversation = db.getConversation(business.id, customerPhone);
            const history = conversation ? conversation.messages : [];
            saveAndTrimHistory(business.id, customerPhone, history, { role: 'user', content: combined });

            logger.info({ businessId: business.id, customerPhone }, 'Escalated message saved (boss sees in app)');
            return;
          }
        }

        // Show typing indicator
        try {
          await showTypingIndicator(phoneNumberId, business.whatsapp_access_token, lastMessageId);
        } catch (err) {
          logger.warn({ businessId: business.id, error: err.message }, 'Failed to show typing indicator');
        }

        const conversation = db.getConversation(business.id, customerPhone);
        const history = conversation ? conversation.messages : [];

        const { reply, bookingResult } = await gemini.generateReply(business, history, combined, customerPhone, media);

        // Check for escalation trigger
        const escalationReason = gemini.detectEscalation(reply);
        if (escalationReason) {
          await handleEscalationTrigger(business, phoneNumberId, customerPhone, history, combined, escalationReason, reply);
          return;
        }

        const trimmed = saveAndTrimHistory(business.id, customerPhone, history,
          { role: 'user', content: combined },
          { role: 'assistant', content: reply });

        // Append customer calendar link after successful booking
        if (bookingResult?.success && config.baseUrl) {
          const customerLang = detectLanguage(combined);
          const calId = calendar.storeBooking(bookingResult, getCustomerLabel(business.id, customerPhone), business.name, 'customer');
          const calLabel = CUSTOMER_CALENDAR_LINK_LABEL[customerLang] || CUSTOMER_CALENDAR_LINK_LABEL.en;
          const calLink = `${config.baseUrl}/cal/${calId}`;
          reply += `\n\n🔗 ${calLabel}: ${calLink}`;
        }

        await sendMessage(phoneNumberId, business.whatsapp_access_token, customerPhone, reply);
        logger.info({ businessId: business.id, customerPhone }, 'Reply sent');

        // Async: notify boss of booking (fire-and-forget)
        notifyBossBooking(business, phoneNumberId, customerPhone, bookingResult, combined).catch(() => {});
        // Async: extract and store customer facts (fire-and-forget)
        gemini.updateCustomerMemory(business, customerPhone, combined, reply).catch(() => {});
        // Async: detect knowledge gaps (fire-and-forget)
        gemini.detectKnowledgeGaps(business, combined, reply, customerPhone).catch(() => {});
        // Async: summarize conversation if threshold reached (fire-and-forget)
        gemini.maybeSummarizeConversation(business, customerPhone, trimmed).catch(() => {});
      } catch (err) {
        logger.error({ businessId: business.id, customerPhone, error: err.message }, 'Failed to process message');
        try {
          await sendMessage(phoneNumberId, business.whatsapp_access_token, customerPhone, 'Sorry, I encountered an error. Please try again later.');
        } catch (sendErr) {
          logger.error({ businessId: business.id, error: sendErr.message }, 'Failed to send error message');
        }
      }
    });
  }
}

async function checkExpiredEscalations() {
  const businesses = db.listBusinesses();
  for (const business of businesses) {
    if (!business.phone_number_id) continue;
    const escalations = db.getActiveEscalationsForBoss(business.id);
    for (const esc of escalations) {
      if (isEscalationExpired(esc)) {
        db.resolveEscalation(esc.id);
        try {
          const conv = db.getConversation(business.id, esc.customer_phone);
          const expiredMsg = getEscalationMessage('expired', getLastUserMessage(conv));
          await sendMessage(business.phone_number_id, business.whatsapp_access_token, esc.customer_phone, expiredMsg);
        } catch (err) {
          logger.warn({ businessId: business.id, escalationId: esc.id, error: err.message }, 'Failed to send expiry notification');
        }
        logger.info({ businessId: business.id, escalationId: esc.id, customerPhone: esc.customer_phone }, 'Escalation proactively expired');
      }
    }
  }
}

async function checkStaleEscalations() {
  const modifier = `-${config.escalationReminderHours} hours`;
  const businesses = db.listBusinesses();
  for (const business of businesses) {
    if (!business.boss_telegram_chat_id || !telegram.isConfigured()) continue;
    const stale = db.getStaleEscalations(business.id, modifier);
    if (stale.length === 0) continue;
    const lines = stale.map((esc) => {
      const label = getCustomerLabel(business.id, esc.customer_phone);
      return `• ${label}`;
    });
    const reminderText = `⏰ Reminder: ${stale.length} escalation(s) waiting for your response:\n\n${lines.join('\n')}`;
    try {
      await telegram.sendMessage(business.boss_telegram_chat_id, reminderText);
    } catch (err) {
      logger.warn({ businessId: business.id, error: err.message }, 'Failed to send stale escalation reminder');
    }
  }
}

module.exports = {
  sendMessage,
  markAsRead,
  showTypingIndicator,
  handleIncomingMessage,
  checkExpiredEscalations,
  checkStaleEscalations,
  // Exported for testing
  downloadMedia,
  isEscalationExpired,
  getEscalationMessage,
  detectLanguage,
  notifyBossBooking,
  ESCALATION_MESSAGES,
};
