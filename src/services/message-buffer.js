const logger = require('../logger');
const config = require('../config');

// In-memory buffer: Map<string, { items: {text,messageId,media?}[], timer, maxTimer, onFlush }>
const pending = new Map();

function flush(key) {
  const entry = pending.get(key);
  if (!entry) return;

  clearTimeout(entry.timer);
  clearTimeout(entry.maxTimer);
  const { items, onFlush } = entry;
  pending.delete(key);

  logger.debug({ key, count: items.length }, 'Flushing message buffer');
  onFlush(items).catch((err) => {
    logger.error({ key, error: err.message }, 'Error in message buffer flush');
  });
}

/**
 * Buffer an incoming message. When no new messages arrive within the
 * configured delay, the callback fires with all collected items.
 * A max-wait cap ensures the reply is never delayed indefinitely.
 *
 * @param {string} key      Unique conversation key (e.g. "businessId:phone")
 * @param {{text: string, messageId: string, media?: {base64: string, mimeType: string}}} item  The incoming message
 * @param {Function} onFlush  Called with (items: {text,messageId,media?}[]) when the buffer flushes
 * @param {{ bufferMs?: number, bufferMaxMs?: number }} [opts]  Optional custom timing overrides
 */
function add(key, item, onFlush, opts) {
  const bufferMs = opts?.bufferMs ?? config.messageBufferMs;
  const bufferMaxMs = opts?.bufferMaxMs ?? config.messageBufferMaxMs;
  let entry = pending.get(key);

  if (!entry) {
    entry = { items: [], timer: null, maxTimer: null, onFlush };
    pending.set(key, entry);

    // Max wait: flush even if messages keep arriving
    entry.maxTimer = setTimeout(() => flush(key), bufferMaxMs);
  }

  entry.items.push(item);
  entry.onFlush = onFlush;

  // Reset the debounce timer
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => flush(key), bufferMs);
}

module.exports = { add };
