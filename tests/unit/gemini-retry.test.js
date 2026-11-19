const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Must set dbPath before requiring gemini (it loads db.js which opens the database)
const config = require('../../src/config');
config.dbPath = ':memory:';

const { withRetry, isRetryable } = require('../../src/services/gemini');

// ---------------------------------------------------------------------------
// isRetryable(err)
// ---------------------------------------------------------------------------
describe('isRetryable', () => {
  it('returns true for AbortError (timeout)', () => {
    const err = new Error('timeout');
    err.name = 'AbortError';
    assert.equal(isRetryable(err), true);
  });

  it('returns true for ECONNRESET', () => {
    const err = new Error('connection reset');
    err.code = 'ECONNRESET';
    assert.equal(isRetryable(err), true);
  });

  it('returns true for ETIMEDOUT', () => {
    const err = new Error('timed out');
    err.code = 'ETIMEDOUT';
    assert.equal(isRetryable(err), true);
  });

  it('returns true for 429 status (rate limit)', () => {
    const err = new Error('rate limited');
    err.status = 429;
    assert.equal(isRetryable(err), true);
  });

  it('returns true for 503 status (service unavailable)', () => {
    const err = new Error('service unavailable');
    err.status = 503;
    assert.equal(isRetryable(err), true);
  });

  it('returns true for 429 via httpCode', () => {
    const err = new Error('rate limited');
    err.httpCode = 429;
    assert.equal(isRetryable(err), true);
  });

  it('returns true for 503 via response.status', () => {
    const err = new Error('unavailable');
    err.response = { status: 503 };
    assert.equal(isRetryable(err), true);
  });

  it('returns false for 400 (bad request)', () => {
    const err = new Error('bad request');
    err.status = 400;
    assert.equal(isRetryable(err), false);
  });

  it('returns false for 401 (unauthorized)', () => {
    const err = new Error('unauthorized');
    err.status = 401;
    assert.equal(isRetryable(err), false);
  });

  it('returns false for 404 (not found)', () => {
    const err = new Error('not found');
    err.status = 404;
    assert.equal(isRetryable(err), false);
  });

  it('returns false for 500 (internal server error)', () => {
    const err = new Error('internal error');
    err.status = 500;
    assert.equal(isRetryable(err), false);
  });

  it('returns false for generic errors without status or code', () => {
    const err = new Error('something broke');
    assert.equal(isRetryable(err), false);
  });
});

// ---------------------------------------------------------------------------
// withRetry(fn, opts)
// ---------------------------------------------------------------------------
describe('withRetry', () => {
  it('returns the result on first success', async () => {
    const result = await withRetry(() => Promise.resolve('ok'), { retries: 2 });
    assert.equal(result, 'ok');
  });

  it('retries on retryable error and succeeds on second attempt', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls === 1) {
        const err = new Error('rate limit');
        err.status = 429;
        return Promise.reject(err);
      }
      return Promise.resolve('recovered');
    };

    const result = await withRetry(fn, { retries: 2, label: 'test' });
    assert.equal(result, 'recovered');
    assert.equal(calls, 2);
  });

  it('retries up to max retries then throws', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      const err = new Error('always fail');
      err.status = 503;
      return Promise.reject(err);
    };

    await assert.rejects(
      () => withRetry(fn, { retries: 2, label: 'test' }),
      (err) => {
        assert.equal(err.message, 'always fail');
        return true;
      }
    );
    assert.equal(calls, 3); // 1 initial + 2 retries
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      const err = new Error('bad request');
      err.status = 400;
      return Promise.reject(err);
    };

    await assert.rejects(
      () => withRetry(fn, { retries: 2, label: 'test' }),
      (err) => {
        assert.equal(err.message, 'bad request');
        return true;
      }
    );
    assert.equal(calls, 1); // No retry
  });

  it('works with retries = 0 (no retries)', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      const err = new Error('fail');
      err.status = 429;
      return Promise.reject(err);
    };

    await assert.rejects(
      () => withRetry(fn, { retries: 0, label: 'test' }),
      (err) => {
        assert.equal(err.message, 'fail');
        return true;
      }
    );
    assert.equal(calls, 1);
  });

  it('succeeds on last retry attempt', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls <= 2) {
        const err = new Error('transient');
        err.code = 'ECONNRESET';
        return Promise.reject(err);
      }
      return Promise.resolve('finally');
    };

    const result = await withRetry(fn, { retries: 2, label: 'test' });
    assert.equal(result, 'finally');
    assert.equal(calls, 3);
  });

  it('propagates the original error after exhausting retries', async () => {
    const fn = () => {
      const err = new Error('specific message');
      err.status = 429;
      err.customProp = 'preserved';
      return Promise.reject(err);
    };

    await assert.rejects(
      () => withRetry(fn, { retries: 1, label: 'test' }),
      (err) => {
        assert.equal(err.message, 'specific message');
        assert.equal(err.customProp, 'preserved');
        return true;
      }
    );
  });

  it('retries timeout errors (AbortError)', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls === 1) {
        const err = new Error('timeout');
        err.name = 'AbortError';
        return Promise.reject(err);
      }
      return Promise.resolve('ok');
    };

    const result = await withRetry(fn, { retries: 1, label: 'test' });
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
  });
});
