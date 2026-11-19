const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

// Mock axios before requiring whatsapp module
const axios = require('axios');
let getCalls = [];
mock.method(axios, 'get', async (url, opts) => {
  getCalls.push({ url, opts });
  // First call: return media metadata with download URL
  if (!opts?.responseType) {
    return { data: { url: 'https://cdn.example.com/media/temp-file' } };
  }
  // Second call: return binary data
  return {
    data: Buffer.from('fake-image-data'),
    headers: { 'content-type': 'image/jpeg' },
  };
});
// Mock post to prevent any WhatsApp API calls
mock.method(axios, 'post', async () => ({ data: {} }));

const whatsapp = require('../../src/services/whatsapp');

describe('downloadMedia', () => {
  beforeEach(() => {
    getCalls = [];
  });

  it('downloads media and returns base64 + mimeType', async () => {
    const result = await whatsapp.downloadMedia('media-123', 'test-token');

    assert.ok(result);
    assert.equal(result.mimeType, 'image/jpeg');
    assert.equal(result.base64, Buffer.from('fake-image-data').toString('base64'));

    // Should have made 2 GET calls
    assert.equal(getCalls.length, 2);

    // First call: get media URL
    assert.ok(getCalls[0].url.includes('media-123'));
    assert.equal(getCalls[0].opts.headers.Authorization, 'Bearer test-token');

    // Second call: download binary
    assert.equal(getCalls[1].url, 'https://cdn.example.com/media/temp-file');
    assert.equal(getCalls[1].opts.responseType, 'arraybuffer');
    assert.equal(getCalls[1].opts.headers.Authorization, 'Bearer test-token');
  });

  it('strips codec params from mime type', async () => {
    mock.method(axios, 'get', async (url, opts) => {
      getCalls.push({ url, opts });
      if (!opts?.responseType) {
        return { data: { url: 'https://cdn.example.com/media/voice' } };
      }
      return {
        data: Buffer.from('fake-audio-data'),
        headers: { 'content-type': 'audio/ogg; codecs=opus' },
      };
    });

    const result = await whatsapp.downloadMedia('audio-456', 'test-token');

    assert.ok(result);
    assert.equal(result.mimeType, 'audio/ogg');
  });

  it('rejects oversized media via maxContentLength', async () => {
    mock.method(axios, 'get', async (url, opts) => {
      getCalls.push({ url, opts });
      if (!opts?.responseType) {
        return { data: { url: 'https://cdn.example.com/media/large' } };
      }
      // axios throws when maxContentLength is exceeded
      const err = new Error('maxContentLength size of 10485760 exceeded');
      err.code = 'ERR_BAD_RESPONSE';
      throw err;
    });

    await assert.rejects(
      () => whatsapp.downloadMedia('big-media', 'test-token'),
      { message: /maxContentLength/ },
    );
  });

  it('passes timeout and maxContentLength to download request', async () => {
    // Restore default mock (previous test overrides with throwing mock)
    mock.method(axios, 'get', async (url, opts) => {
      getCalls.push({ url, opts });
      if (!opts?.responseType) {
        return { data: { url: 'https://cdn.example.com/media/temp-file' } };
      }
      return {
        data: Buffer.from('fake-image-data'),
        headers: { 'content-type': 'image/jpeg' },
      };
    });

    await whatsapp.downloadMedia('media-opts', 'test-token');

    const downloadCall = getCalls.find((c) => c.opts?.responseType === 'arraybuffer');
    assert.ok(downloadCall);
    assert.equal(downloadCall.opts.maxContentLength, 10 * 1024 * 1024);
    assert.equal(downloadCall.opts.timeout, 10000);
  });
});
