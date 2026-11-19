const axios = require('axios');
const config = require('../config');
const logger = require('../logger');

const TELEGRAM_API = 'https://api.telegram.org/bot';

let cachedBotUsername = null;
let updatesOffset = 0;
let processing = false;

function isConfigured() {
  return !!config.telegramBotToken;
}

async function sendMessage(chatId, text) {
  if (!config.telegramBotToken) {
    logger.warn('Telegram bot token not configured — cannot send message');
    return null;
  }
  const url = `${TELEGRAM_API}${config.telegramBotToken}/sendMessage`;
  try {
    const res = await axios.post(url, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    });
    return res.data;
  } catch (err) {
    const detail = err.response?.data?.description || err.message;
    logger.error({ chatId, detail }, 'Telegram sendMessage failed');
    throw err;
  }
}

async function getBotUsername() {
  if (cachedBotUsername) return cachedBotUsername;
  if (!config.telegramBotToken) return null;
  const url = `${TELEGRAM_API}${config.telegramBotToken}/getMe`;
  const res = await axios.get(url);
  cachedBotUsername = res.data.result.username;
  return cachedBotUsername;
}

async function processStartCommands() {
  if (processing) return [];
  if (!config.telegramBotToken) return [];
  processing = true;
  try {
    const url = `${TELEGRAM_API}${config.telegramBotToken}/getUpdates`;
    const res = await axios.get(url, {
      params: { offset: updatesOffset, allowed_updates: JSON.stringify(['message']) },
    });
    const updates = res.data.result || [];
    const results = [];
    for (const update of updates) {
      if (update.update_id >= updatesOffset) {
        updatesOffset = update.update_id + 1;
      }
      const text = update.message?.text;
      const chatId = update.message?.chat?.id;
      if (text && chatId && text.startsWith('/start ')) {
        const token = text.slice(7).trim();
        if (token) {
          results.push({ token, chatId: String(chatId) });
        }
      }
    }
    return results;
  } catch (err) {
    const detail = err.response?.data?.description || err.message;
    logger.error({ detail }, 'Telegram getUpdates failed');
    return [];
  } finally {
    processing = false;
  }
}

// For testing: reset internal state
function _resetState() {
  cachedBotUsername = null;
  updatesOffset = 0;
  processing = false;
}

module.exports = { sendMessage, isConfigured, getBotUsername, processStartCommands, _resetState };
