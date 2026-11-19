#!/usr/bin/env node

/**
 * Telegram Bot Setup & Test Script
 *
 * Usage:
 *   node scripts/telegram-setup.js              # discover chats + send test
 *   node scripts/telegram-setup.js --set <bizId> # also set chat_id on a business
 */

require('dotenv').config();
const axios = require('axios');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function main() {
  // 1. Check token
  if (!TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set in .env');
    process.exit(1);
  }

  console.log('🔍 Verifying bot token...');
  let bot;
  try {
    const res = await axios.get(`${API}/getMe`);
    bot = res.data.result;
    console.log(`✅ Bot: @${bot.username} (${bot.first_name})`);
  } catch (err) {
    console.error('❌ Invalid bot token:', err.response?.data?.description || err.message);
    process.exit(1);
  }

  // 2. Discover chats
  console.log('\n🔍 Looking for chats (from recent messages)...');
  console.log('   If empty, add the bot to a Telegram group and send a message, then re-run.\n');

  let chats;
  try {
    const res = await axios.get(`${API}/getUpdates`, { params: { limit: 100 } });
    const updates = res.data.result || [];

    // Deduplicate by chat id
    const chatMap = new Map();
    for (const u of updates) {
      const chat = u.message?.chat || u.my_chat_member?.chat;
      if (chat) chatMap.set(chat.id, chat);
    }
    chats = [...chatMap.values()];
  } catch (err) {
    console.error('❌ Failed to get updates:', err.response?.data?.description || err.message);
    process.exit(1);
  }

  if (chats.length === 0) {
    console.log('   No chats found. Steps:');
    console.log('   1. Create a Telegram group');
    console.log(`   2. Add @${bot.username} to the group`);
    console.log('   3. Send any message in the group');
    console.log('   4. Re-run this script');
    process.exit(0);
  }

  console.log('   Found chats:');
  chats.forEach((c, i) => {
    const name = c.title || c.first_name || c.username || 'Unknown';
    const type = c.type;
    console.log(`   ${i + 1}. ${name} (${type}, id: ${c.id})`);
  });

  // 3. Pick a chat (use first group, or first chat)
  const groupChat = chats.find(c => c.type === 'group' || c.type === 'supergroup') || chats[0];
  const chatId = groupChat.id;
  const chatName = groupChat.title || groupChat.first_name || chatId;

  console.log(`\n📤 Sending test message to "${chatName}" (${chatId})...`);
  try {
    await axios.post(`${API}/sendMessage`, {
      chat_id: chatId,
      text: `✅ Aiyelet bot connected!\n\nThis chat (ID: <code>${chatId}</code>) will receive boss notifications for escalations and bookings.`,
      parse_mode: 'HTML',
    });
    console.log('✅ Test message sent! Check your Telegram.');
  } catch (err) {
    console.error('❌ Failed to send:', err.response?.data?.description || err.message);
    process.exit(1);
  }

  // 4. Optionally set on a business
  const bizId = process.argv.includes('--set') && process.argv[process.argv.indexOf('--set') + 1];
  if (bizId) {
    if (!ADMIN_KEY) {
      console.error('\n❌ ADMIN_API_KEY not set — cannot update business via API');
      process.exit(1);
    }
    console.log(`\n🔧 Setting boss_telegram_chat_id on business ${bizId}...`);
    try {
      const res = await axios.patch(`${BASE}/api/businesses/${bizId}`, {
        boss_telegram_chat_id: String(chatId),
      }, {
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      console.log(`✅ Updated business "${res.data.name}" — Telegram chat ID: ${chatId}`);
    } catch (err) {
      const detail = err.response?.data?.error || err.message;
      console.error('❌ Failed to update business:', detail);
      process.exit(1);
    }
  } else {
    console.log(`\n💡 To set this chat on a business, run:`);
    console.log(`   node scripts/telegram-setup.js --set <business-id>`);
    console.log(`\n   Or manually via API:`);
    console.log(`   curl -X PATCH ${BASE}/api/businesses/<ID> \\`);
    console.log(`     -H "Authorization: Bearer $ADMIN_API_KEY" \\`);
    console.log(`     -H "Content-Type: application/json" \\`);
    console.log(`     -d '{"boss_telegram_chat_id": "${chatId}"}'`);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
