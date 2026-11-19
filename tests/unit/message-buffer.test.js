const { describe, it, before, mock } = require('node:test');
const assert = require('node:assert/strict');

// Configure buffer timings before requiring the module
const config = require('../../src/config');
config.messageBufferMs = 100;
config.messageBufferMaxMs = 500;

const { add } = require('../../src/services/message-buffer');

// ---------------------------------------------------------------------------
// message-buffer: add(key, item, onFlush)
// ---------------------------------------------------------------------------
describe('message-buffer', () => {
  before(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  it('flushes a single message after the debounce delay', () => {
    const flushed = [];
    const onFlush = (items) => {
      flushed.push(items);
      return Promise.resolve();
    };

    add('single-1', { text: 'hello', messageId: 'm1' }, onFlush);

    // Not yet flushed
    assert.equal(flushed.length, 0);

    mock.timers.tick(100);

    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].length, 1);
    assert.equal(flushed[0][0].text, 'hello');
    assert.equal(flushed[0][0].messageId, 'm1');
  });

  it('combines multiple rapid messages into a single flush', () => {
    const flushed = [];
    const onFlush = (items) => {
      flushed.push(items);
      return Promise.resolve();
    };

    add('multi-1', { text: 'a', messageId: 'm1' }, onFlush);
    add('multi-1', { text: 'b', messageId: 'm2' }, onFlush);
    add('multi-1', { text: 'c', messageId: 'm3' }, onFlush);

    mock.timers.tick(100);

    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].length, 3);
  });

  it('resets the debounce timer when a new message arrives', () => {
    const flushed = [];
    const onFlush = (items) => {
      flushed.push(items);
      return Promise.resolve();
    };

    add('debounce-1', { text: 'first', messageId: 'm1' }, onFlush);

    // Advance less than the debounce delay
    mock.timers.tick(60);
    assert.equal(flushed.length, 0);

    // Add another message -- this resets the debounce timer
    add('debounce-1', { text: 'second', messageId: 'm2' }, onFlush);

    // Advance by 60ms again -- 60ms since the second message, not enough
    mock.timers.tick(60);
    assert.equal(flushed.length, 0);

    // Advance by 40ms more (total 100ms since second message) -- now it flushes
    mock.timers.tick(40);
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].length, 2);
    assert.equal(flushed[0][0].text, 'first');
    assert.equal(flushed[0][1].text, 'second');
  });

  it('fires after messageBufferMaxMs even with continuous messages', () => {
    const flushed = [];
    const onFlush = (items) => {
      flushed.push(items);
      return Promise.resolve();
    };

    // Add the first message to start the max timer
    add('maxwait-1', { text: 'msg0', messageId: 'm0' }, onFlush);

    // Keep adding messages at 80ms intervals (less than the 100ms debounce),
    // which keeps resetting the debounce timer but NOT the max timer
    for (let i = 1; i <= 5; i++) {
      mock.timers.tick(80);
      add('maxwait-1', { text: `msg${i}`, messageId: `m${i}` }, onFlush);
    }

    // We are now at 400ms. Not flushed yet.
    assert.equal(flushed.length, 0);

    // Advance to 500ms -- max-wait timer fires
    mock.timers.tick(100);

    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].length, 6);
  });

  it('keeps different keys as independent buffers', () => {
    const flushedA = [];
    const flushedB = [];
    const onFlushA = (items) => {
      flushedA.push(items);
      return Promise.resolve();
    };
    const onFlushB = (items) => {
      flushedB.push(items);
      return Promise.resolve();
    };

    add('key-a', { text: 'alpha', messageId: 'a1' }, onFlushA);
    add('key-b', { text: 'beta', messageId: 'b1' }, onFlushB);

    mock.timers.tick(100);

    assert.equal(flushedA.length, 1);
    assert.equal(flushedA[0].length, 1);
    assert.equal(flushedA[0][0].text, 'alpha');

    assert.equal(flushedB.length, 1);
    assert.equal(flushedB[0].length, 1);
    assert.equal(flushedB[0][0].text, 'beta');
  });

  it('preserves item order in the flushed array', () => {
    const flushed = [];
    const onFlush = (items) => {
      flushed.push(items);
      return Promise.resolve();
    };

    add('order-1', { text: '1', messageId: 'm1' }, onFlush);
    add('order-1', { text: '2', messageId: 'm2' }, onFlush);
    add('order-1', { text: '3', messageId: 'm3' }, onFlush);

    mock.timers.tick(100);

    assert.equal(flushed.length, 1);
    const items = flushed[0];
    assert.equal(items[0].text, '1');
    assert.equal(items[1].text, '2');
    assert.equal(items[2].text, '3');
  });

  it('respects custom timing overrides via opts parameter', () => {
    const flushed = [];
    const onFlush = (items) => {
      flushed.push(items);
      return Promise.resolve();
    };

    // Use custom shorter timing (50ms debounce, 200ms max)
    add('custom-timing-1', { text: 'fast', messageId: 'm1' }, onFlush, { bufferMs: 50, bufferMaxMs: 200 });

    // Not flushed at 30ms
    mock.timers.tick(30);
    assert.equal(flushed.length, 0);

    // Flushed at 50ms
    mock.timers.tick(20);
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0][0].text, 'fast');
  });

  it('starts a fresh buffer after a flush', () => {
    const flushed = [];
    const onFlush = (items) => {
      flushed.push(items);
      return Promise.resolve();
    };

    // First round
    add('fresh-1', { text: 'round1', messageId: 'm1' }, onFlush);
    mock.timers.tick(100);

    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].length, 1);
    assert.equal(flushed[0][0].text, 'round1');

    // Second round -- same key, should be a new buffer
    add('fresh-1', { text: 'round2', messageId: 'm2' }, onFlush);
    mock.timers.tick(100);

    assert.equal(flushed.length, 2);
    assert.equal(flushed[1].length, 1);
    assert.equal(flushed[1][0].text, 'round2');
  });
});
