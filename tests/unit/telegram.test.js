const { describe, it, beforeEach, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('../helpers/setup');

const axios = require('axios');
let postCalls = [];
let getCalls = [];
mock.method(axios, 'post', async (url, body, opts) => {
  postCalls.push({ url, body, opts });
  return { data: { ok: true, result: { message_id: 123 } } };
});
mock.method(axios, 'get', async (url, opts) => {
  getCalls.push({ url, opts });
  return { data: { ok: true, result: [] } };
});

const telegram = require('../../src/services/telegram');

describe('telegram.isConfigured', () => {
  const savedToken = config.telegramBotToken;

  afterEach(() => {
    config.telegramBotToken = savedToken;
  });

  it('returns true when token is set', () => {
    config.telegramBotToken = 'bot123:abc';
    assert.equal(telegram.isConfigured(), true);
  });

  it('returns false when token is not set', () => {
    config.telegramBotToken = null;
    assert.equal(telegram.isConfigured(), false);
  });

  it('returns false when token is empty string', () => {
    config.telegramBotToken = '';
    assert.equal(telegram.isConfigured(), false);
  });
});

describe('telegram.sendMessage', () => {
  const savedToken = config.telegramBotToken;

  beforeEach(() => {
    postCalls = [];
    config.telegramBotToken = 'bot123:abc';
  });

  afterEach(() => {
    config.telegramBotToken = savedToken;
  });

  it('sends message to correct Telegram API endpoint', async () => {
    await telegram.sendMessage('-100123', 'Hello boss');

    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].url, 'https://api.telegram.org/botbot123:abc/sendMessage');
    assert.deepEqual(postCalls[0].body, {
      chat_id: '-100123',
      text: 'Hello boss',
      parse_mode: 'HTML',
    });
  });

  it('returns API response data', async () => {
    const result = await telegram.sendMessage('-100123', 'test');
    assert.ok(result.ok);
    assert.equal(result.result.message_id, 123);
  });

  it('returns null when token is not configured', async () => {
    config.telegramBotToken = null;
    const result = await telegram.sendMessage('-100123', 'test');
    assert.equal(result, null);
    assert.equal(postCalls.length, 0);
  });

  it('throws on API error', async () => {
    axios.post.mock.mockImplementation(async () => {
      const err = new Error('Bad Request');
      err.response = { data: { description: 'chat not found' } };
      throw err;
    });

    await assert.rejects(
      () => telegram.sendMessage('-100123', 'test'),
      { message: 'Bad Request' }
    );

    // Restore mock
    axios.post.mock.mockImplementation(async (url, body, opts) => {
      postCalls.push({ url, body, opts });
      return { data: { ok: true, result: { message_id: 123 } } };
    });
  });
});

describe('telegram.getBotUsername', () => {
  const savedToken = config.telegramBotToken;

  beforeEach(() => {
    getCalls = [];
    config.telegramBotToken = 'bot123:abc';
    telegram._resetState();
  });

  afterEach(() => {
    config.telegramBotToken = savedToken;
    telegram._resetState();
  });

  it('calls getMe and returns username', async () => {
    axios.get.mock.mockImplementation(async (url, opts) => {
      getCalls.push({ url, opts });
      return { data: { ok: true, result: { username: 'test_bot' } } };
    });

    const username = await telegram.getBotUsername();
    assert.equal(username, 'test_bot');
    assert.equal(getCalls.length, 1);
    assert.ok(getCalls[0].url.includes('/getMe'));
  });

  it('caches username on subsequent calls', async () => {
    axios.get.mock.mockImplementation(async (url, opts) => {
      getCalls.push({ url, opts });
      return { data: { ok: true, result: { username: 'cached_bot' } } };
    });

    await telegram.getBotUsername();
    await telegram.getBotUsername();
    assert.equal(getCalls.length, 1); // only one API call
  });

  it('returns null when token is not configured', async () => {
    config.telegramBotToken = null;
    const result = await telegram.getBotUsername();
    assert.equal(result, null);
    assert.equal(getCalls.length, 0);
  });
});

describe('telegram.processStartCommands', () => {
  const savedToken = config.telegramBotToken;

  beforeEach(() => {
    getCalls = [];
    config.telegramBotToken = 'bot123:abc';
    telegram._resetState();
  });

  afterEach(() => {
    config.telegramBotToken = savedToken;
    telegram._resetState();
  });

  it('extracts /start tokens from updates', async () => {
    axios.get.mock.mockImplementation(async (url, opts) => {
      getCalls.push({ url, opts });
      return {
        data: {
          ok: true,
          result: [
            { update_id: 100, message: { chat: { id: 555 }, text: '/start abc-123' } },
            { update_id: 101, message: { chat: { id: 777 }, text: 'hello' } },
            { update_id: 102, message: { chat: { id: 888 }, text: '/start def-456' } },
          ],
        },
      };
    });

    const results = await telegram.processStartCommands();
    assert.equal(results.length, 2);
    assert.deepEqual(results[0], { token: 'abc-123', chatId: '555' });
    assert.deepEqual(results[1], { token: 'def-456', chatId: '888' });
  });

  it('advances offset after processing', async () => {
    axios.get.mock.mockImplementation(async (url, opts) => {
      getCalls.push({ url, opts });
      return {
        data: {
          ok: true,
          result: [
            { update_id: 200, message: { chat: { id: 555 }, text: '/start token1' } },
          ],
        },
      };
    });

    await telegram.processStartCommands();

    // Second call should use offset 201
    axios.get.mock.mockImplementation(async (url, opts) => {
      getCalls.push({ url, opts });
      return { data: { ok: true, result: [] } };
    });

    await telegram.processStartCommands();
    assert.equal(getCalls.length, 2);
    assert.equal(getCalls[1].opts.params.offset, 201);
  });

  it('returns empty array when token not configured', async () => {
    config.telegramBotToken = null;
    const results = await telegram.processStartCommands();
    assert.deepEqual(results, []);
    assert.equal(getCalls.length, 0);
  });

  it('returns empty array on API error', async () => {
    axios.get.mock.mockImplementation(async () => {
      throw new Error('Network error');
    });

    const results = await telegram.processStartCommands();
    assert.deepEqual(results, []);
  });

  it('ignores /start without a token', async () => {
    axios.get.mock.mockImplementation(async (url, opts) => {
      getCalls.push({ url, opts });
      return {
        data: {
          ok: true,
          result: [
            { update_id: 300, message: { chat: { id: 555 }, text: '/start' } },
            { update_id: 301, message: { chat: { id: 555 }, text: '/start ' } },
          ],
        },
      };
    });

    const results = await telegram.processStartCommands();
    assert.equal(results.length, 0);
  });
});
