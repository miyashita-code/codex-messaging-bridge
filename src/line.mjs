import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isIP } from 'node:net';

const API = 'https://api.line.me/v2/bot';
const CONTENT_API = 'https://api-data.line.me/v2/bot/message';
const RESPONSE_LIMIT = 16 * 1024;
const HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_MEDIA_LIMIT = 10 * 1024 * 1024;

/** Verify exactly the bytes LINE signed; callers must not re-serialize JSON. */
export function verifySignature(raw, signature, secret) {
  if (!secret || typeof secret !== 'string' || typeof signature !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  try {
    const actual = Buffer.from(signature, 'base64');
    const expected = createHmac('sha256', secret).update(raw).digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

/** LINE counts text in UTF-16 units. Never cut a surrogate pair in half. */
export function splitText(text, limit = 5000) {
  if (typeof text !== 'string') throw new TypeError('Text must be a string.');
  if (!Number.isSafeInteger(limit) || limit < 2) throw new RangeError('Text limit must be at least 2.');
  const parts = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) &&
        /[\uDC00-\uDFFF]/.test(text[end])) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/** Errors deliberately omit request bodies, authorization headers and raw causes. */
export class LINEError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = 'LINEError';
    this.status = fields.status ?? 0;
    this.retryable = fields.retryable ?? false;
    this.uncertain = fields.uncertain ?? false;
    this.accepted = fields.accepted ?? false;
    this.acceptedRequestId = fields.acceptedRequestId;
    this.requestId = fields.requestId;
    this.invalidReplyToken = fields.invalidReplyToken ?? false;
    this.code = fields.code ?? 'LINE_ERROR';
  }
}

function invalid(message) {
  throw new LINEError(message, { code: 'INVALID_MESSAGE' });
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object.`);
}

function string(value, label, max, { optional = false, allowEmpty = false } = {}) {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max) {
    invalid(`${label} must be a non-empty string of at most ${max} UTF-16 units.`);
  }
}

function mediaURL(value, label, max = 2000) {
  string(value, label, max);
  let url;
  try { url = new URL(value); } catch { invalid(`${label} must be an HTTPS URL.`); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    invalid(`${label} must be an HTTPS URL without credentials.`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // Literal private addresses are never usable public LINE media endpoints.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      (isIP(host) === 4 && /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) ||
      (isIP(host) === 6 && (host === '::' || host === '::1' || /^(?:f[cd]|fe[89ab])/.test(host) || host.startsWith('::ffff:')))) {
    invalid(`${label} must reference a public host.`);
  }
}

function action(value, labelLimit = 20) {
  record(value, 'Action');
  string(value.label, 'Action label', labelLimit, { optional: true });
  switch (value.type) {
    case 'message': string(value.text, 'Action text', 300); break;
    case 'postback':
      string(value.data, 'Postback data', 300);
      string(value.displayText, 'Postback display text', 300, { optional: true });
      break;
    case 'uri': {
      string(value.uri, 'Action URI', 1000);
      let url;
      try { url = new URL(value.uri); } catch { invalid('Action URI must be a valid URL.'); }
      if (!['https:', 'http:', 'tel:'].includes(url.protocol)) invalid('Unsupported action URI protocol.');
      break;
    }
    case 'datetimepicker':
      string(value.data, 'Date picker data', 300);
      if (!['date', 'time', 'datetime'].includes(value.mode)) invalid('Invalid date picker mode.');
      break;
    case 'clipboard': string(value.clipboardText, 'Clipboard text', 1000); break;
    case 'richmenuswitch':
      string(value.richMenuAliasId, 'Rich menu alias', 32);
      string(value.data, 'Rich menu data', 300);
      break;
    case 'camera': case 'cameraRoll': case 'location': break;
    default: invalid('Unsupported LINE action type.');
  }
}

function quickReply(value) {
  if (value === undefined) return;
  record(value, 'Quick reply');
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 13) {
    invalid('Quick replies must contain 1 to 13 items.');
  }
  for (const item of value.items) {
    record(item, 'Quick reply item');
    if (item.type !== 'action') invalid('Quick reply items must be actions.');
    if (item.imageUrl !== undefined) mediaURL(item.imageUrl, 'Quick reply image URL');
    action(item.action);
  }
}

function template(value) {
  record(value, 'Template');
  const checkActions = (actions, min, max) => {
    if (!Array.isArray(actions) || actions.length < min || actions.length > max) {
      invalid(`Template must contain ${min} to ${max} actions.`);
    }
    for (const item of actions) action(item);
  };
  switch (value.type) {
    case 'confirm':
      string(value.text, 'Confirm text', 240);
      checkActions(value.actions, 2, 2);
      break;
    case 'buttons':
      string(value.title, 'Template title', 40, { optional: true });
      string(value.text, 'Buttons text', value.title || value.thumbnailImageUrl ? 60 : 160);
      if (value.thumbnailImageUrl !== undefined) mediaURL(value.thumbnailImageUrl, 'Template image URL');
      checkActions(value.actions, 1, 4);
      if (value.defaultAction !== undefined) action(value.defaultAction);
      break;
    case 'carousel': {
      if (!Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > 10) {
        invalid('Carousel must contain 1 to 10 columns.');
      }
      const first = value.columns[0];
      for (const column of value.columns) {
        record(column, 'Carousel column');
        string(column.title, 'Carousel title', 40, { optional: true });
        string(column.text, 'Carousel text', column.title || column.thumbnailImageUrl ? 60 : 120);
        if (column.thumbnailImageUrl !== undefined) mediaURL(column.thumbnailImageUrl, 'Carousel image URL');
        checkActions(column.actions, 1, 3);
        if (column.defaultAction !== undefined) action(column.defaultAction);
        if (column.actions.length !== first.actions.length ||
            Boolean(column.title) !== Boolean(first.title) ||
            Boolean(column.thumbnailImageUrl) !== Boolean(first.thumbnailImageUrl)) {
          invalid('Carousel columns must use consistent title, image and action layouts.');
        }
      }
      break;
    }
    case 'image_carousel':
      if (!Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > 10) {
        invalid('Image carousel must contain 1 to 10 columns.');
      }
      for (const column of value.columns) {
        record(column, 'Image carousel column');
        mediaURL(column.imageUrl, 'Carousel image URL');
        action(column.action, 12);
      }
      break;
    default: invalid('Unsupported LINE template type.');
  }
}

function flex(value) {
  record(value, 'Flex contents');
  let serialized;
  try { serialized = JSON.stringify(value); } catch { invalid('Flex contents must be serializable JSON.'); }
  if (value.type === 'bubble') {
    if (Buffer.byteLength(serialized) > 30_000) invalid('Flex bubble exceeds 30000 bytes.');
  } else if (value.type === 'carousel') {
    if (!Array.isArray(value.contents) || value.contents.length < 1 || value.contents.length > 12) {
      invalid('Flex carousel must contain 1 to 12 bubbles.');
    }
    if (Buffer.byteLength(serialized) > 50_000) invalid('Flex carousel exceeds 50000 bytes.');
    for (const bubble of value.contents) {
      if (bubble?.type !== 'bubble') invalid('Flex carousel contents must be bubbles.');
      flex(bubble);
    }
  } else invalid('Flex contents must be a bubble or carousel.');
  // Enforce limits on nested provider actions and media as well as the envelope.
  const walk = (node, depth = 0) => {
    if (depth > 30) invalid('Flex nesting exceeds the supported limit.');
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) walk(child, depth + 1); return; }
    if (node.action !== undefined) action(node.action, 40);
    if (node.type === 'image' || node.type === 'icon') mediaURL(node.url, 'Flex image URL');
    if (node.type === 'video') {
      mediaURL(node.url, 'Flex video URL');
      mediaURL(node.previewUrl, 'Flex video preview URL');
      if (!node.altContent) invalid('Flex video requires alternative contents.');
    }
    if (node.type === 'text') string(node.text, 'Flex text', 10_000, { optional: Boolean(node.contents) });
    for (const [key, child] of Object.entries(node)) if (key !== 'action') walk(child, depth + 1);
  };
  walk(value);
}

/** Reject oversized/unsupported payloads before consuming a reply token. */
export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 5) {
    invalid('A LINE request must contain 1 to 5 messages.');
  }
  for (const message of messages) {
    record(message, 'Message');
    switch (message.type) {
      case 'text': string(message.text, 'Text', 5000); break;
      case 'image':
        mediaURL(message.originalContentUrl, 'Image URL');
        mediaURL(message.previewImageUrl, 'Image preview URL');
        break;
      case 'video':
        mediaURL(message.originalContentUrl, 'Video URL');
        mediaURL(message.previewImageUrl, 'Video preview URL');
        string(message.trackingId, 'Video tracking ID', 100, { optional: true });
        if (message.trackingId !== undefined && !/^[a-zA-Z0-9\-.=,+*()%$&;:@{}!?<>\[\]]+$/.test(message.trackingId)) {
          invalid('Video tracking ID contains unsupported characters.');
        }
        break;
      case 'audio':
        mediaURL(message.originalContentUrl, 'Audio URL');
        if (!Number.isSafeInteger(message.duration) || message.duration <= 0) invalid('Audio duration must be a positive integer.');
        break;
      case 'sticker':
        if (!/^\d+$/.test(message.packageId ?? '') || !/^\d+$/.test(message.stickerId ?? '')) {
          invalid('Sticker package and sticker IDs must be decimal strings.');
        }
        break;
      case 'location':
        string(message.title, 'Location title', 100);
        string(message.address, 'Location address', 100);
        if (!Number.isFinite(message.latitude) || Math.abs(message.latitude) > 90 ||
            !Number.isFinite(message.longitude) || Math.abs(message.longitude) > 180) {
          invalid('Location coordinates are invalid.');
        }
        break;
      case 'template':
        string(message.altText, 'Template alternative text', 1500);
        template(message.template);
        break;
      case 'flex':
        string(message.altText, 'Flex alternative text', 1500);
        flex(message.contents);
        break;
      default: invalid('Unsupported LINE message type.');
    }
    if (message.quoteToken !== undefined) {
      if (!['text', 'sticker'].includes(message.type)) invalid('This message type cannot carry a quote token.');
      string(message.quoteToken, 'Quote token', 1000);
    }
    quickReply(message.quickReply);
  }
  // Also fence circular objects and unexpectedly enormous auxiliary fields.
  let payload;
  try { payload = JSON.stringify(messages); } catch { invalid('Messages must be serializable JSON.'); }
  if (Buffer.byteLength(payload) > 1024 * 1024) invalid('LINE request exceeds the payload limit.');
  return messages;
}

function target(value, userOnly = false) {
  if (typeof value !== 'string') invalid('LINE recipient must be a string.');
  const id = value.trim().replace(/^line:(?:(?:user|group|room):)?/i, '');
  if (!(userOnly ? /^U[a-f0-9]{32}$/ : /^[UCR][a-f0-9]{32}$/).test(id)) {
    invalid('LINE IDs are case-sensitive and must use U, C or R followed by 32 lowercase hexadecimal digits.');
  }
  return id;
}

async function limitedBody(response, maxBytes = RESPONSE_LIMIT) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Response exceeds limit.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class LineClient {
  #token;
  #secret;
  #fetch;

  constructor(account, { fetchImpl = fetch } = {}) {
    if (!account || typeof account.channelAccessToken !== 'string' || !account.channelAccessToken.trim()) {
      throw new LINEError('LINE channel access token is not configured.', { code: 'MISSING_CREDENTIAL' });
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
    this.#token = account.channelAccessToken.trim();
    this.#secret = account.channelSecret ?? '';
    this.#fetch = fetchImpl;
    this.accountId = account.accountId ?? 'default';
  }

  #redact(value) {
    let text = String(value ?? '');
    for (const secret of [this.#token, this.#secret]) {
      if (secret) text = text.split(secret).join('[redacted]');
    }
    return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
  }

  async #request(path, { method = 'GET', body, retryKey, send = false } = {}) {
    let response;
    try {
      response = await this.#fetch(`${API}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(retryKey ? { 'X-Line-Retry-Key': retryKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      throw new LINEError('LINE request failed before a response was received.', {
        code: 'NETWORK_ERROR', retryable: !send || Boolean(retryKey), uncertain: send,
      });
    }
    const requestId = response.headers.get('x-line-request-id') || undefined;
    const acceptedRequestId = response.headers.get('x-line-accepted-request-id') || undefined;
    const duplicate = response.status === 409 && Boolean(retryKey && acceptedRequestId);
    let text = '';
    try { text = await limitedBody(response); } catch {
      if (duplicate) return { accepted: true, duplicate: true, requestId, acceptedRequestId, sentMessages: [], messageIds: [], receiptComplete: false };
      throw new LINEError('LINE response could not be read.', {
        status: response.status, code: 'RESPONSE_UNREADABLE',
        accepted: send && response.ok, uncertain: send && (response.ok || response.status >= 500 || response.status === 408),
        retryable: response.ok ? !send : (!send || Boolean(retryKey)) && (response.status >= 500 || response.status === 429 || response.status === 408),
        requestId: this.#redact(requestId), acceptedRequestId: this.#redact(acceptedRequestId),
      });
    }
    let result;
    try { result = text ? JSON.parse(text) : {}; } catch { result = null; }
    if (!response.ok && !duplicate) {
      const invalidReplyToken = path === 'message/reply' && response.status === 400 &&
        result?.message === 'Invalid reply token';
      throw new LINEError(`LINE API refused the request (HTTP ${response.status})${result?.message ? `: ${this.#redact(result.message)}` : '.'}`, {
        status: response.status,
        code: invalidReplyToken ? 'INVALID_REPLY_TOKEN' : 'HTTP_ERROR',
        invalidReplyToken,
        retryable: !send ? (response.status >= 500 || response.status === 429 || response.status === 408) :
          Boolean(retryKey) && (response.status >= 500 || response.status === 429 || response.status === 408),
        uncertain: send && (response.status >= 500 || response.status === 408 || response.status === 409),
        requestId: this.#redact(requestId), acceptedRequestId: this.#redact(acceptedRequestId),
      });
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      if (!duplicate) throw new LINEError('LINE accepted the request but returned an invalid response.', {
        status: response.status, code: 'INVALID_RESPONSE', accepted: send, uncertain: send, retryable: !send,
        requestId: this.#redact(requestId),
      });
      result = {};
    }
    if (!send) return result;
    const sentMessages = Array.isArray(result.sentMessages) ? result.sentMessages
      .filter((item) => item && (typeof item.id === 'string' || typeof item.id === 'number') && String(item.id).trim())
      .slice(0, 5).map((item) => ({ id: String(item.id), ...(typeof item.quoteToken === 'string' ? { quoteToken: item.quoteToken } : {}) })) : [];
    return {
      accepted: true, duplicate, requestId, acceptedRequestId, sentMessages,
      messageIds: sentMessages.map((item) => item.id),
      receiptComplete: sentMessages.length === body.messages.length,
    };
  }

  async reply(replyToken, messages) {
    string(replyToken, 'Reply token', 1000);
    validateMessages(messages);
    return this.#request('message/reply', { method: 'POST', body: { replyToken, messages }, send: true });
  }

  async push(to, messages, retryKey = randomUUID()) {
    const recipient = target(to);
    validateMessages(messages);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(retryKey)) {
      invalid('LINE push retry key must be a UUID.');
    }
    if (!recipient.startsWith('U') && messages.some((message) => message.type === 'video' && message.trackingId !== undefined)) {
      invalid('Video tracking IDs are available only in direct chats.');
    }
    // The caller persists this key with an outbox batch and reuses it for all retries.
    return this.#request('message/push', { method: 'POST', body: { to: recipient, messages }, retryKey, send: true });
  }

  async loading(userId) {
    return this.#request('chat/loading/start', { method: 'POST', body: { chatId: target(userId, true), loadingSeconds: 20 } });
  }

  async profile(userId, { groupId, roomId } = {}) {
    const user = target(userId, true);
    if (groupId && roomId) invalid('A profile lookup can use only one conversation scope.');
    if (groupId && !target(groupId).startsWith('C')) invalid('Group profile scope must use a group ID.');
    if (roomId && !target(roomId).startsWith('R')) invalid('Room profile scope must use a room ID.');
    const path = groupId ? `group/${target(groupId)}/member/${user}` :
      roomId ? `room/${target(roomId)}/member/${user}` : `profile/${user}`;
    return this.#request(path);
  }

  async botInfo() { return this.#request('info'); }
  async groupSummary(groupId) {
    const group = target(groupId);
    if (!group.startsWith('C')) invalid('Group summary requires a group ID.');
    return this.#request(`group/${group}/summary`);
  }
  async webhookInfo() { return this.#request('channel/webhook/endpoint'); }
  async quota() {
    const quota = await this.#request('message/quota');
    if (quota.type === 'none') return { kind: 'unlimited' };
    if (quota.type !== 'limited' || !Number.isSafeInteger(quota.value) || quota.value < 0) {
      throw new LINEError('LINE quota response is invalid.', { code: 'INVALID_RESPONSE' });
    }
    const consumption = await this.#request('message/quota/consumption');
    if (!Number.isSafeInteger(consumption.totalUsage) || consumption.totalUsage < 0) {
      throw new LINEError('LINE quota consumption response is invalid.', { code: 'INVALID_RESPONSE' });
    }
    return { kind: 'limited', limit: quota.value, used: consumption.totalUsage };
  }

  async download(messageId, targetPath, maxBytes = DEFAULT_MEDIA_LIMIT) {
    string(messageId, 'Message ID', 200);
    if (typeof targetPath !== 'string' || !targetPath) invalid('Media target path is required.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) invalid('Media byte limit must be a positive integer.');
    const path = resolve(targetPath);
    const tempPath = resolve(dirname(path), `.${basename(path)}.part-${randomUUID()}`);
    const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
    let response;
    let handle;
    let reader;
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          response = await this.#fetch(`${CONTENT_API}/${encodeURIComponent(messageId)}/content`, {
            headers: { Authorization: `Bearer ${this.#token}` }, redirect: 'error', signal,
          });
        } catch {
          throw new LINEError('LINE media request failed before a response was received.', { code: 'MEDIA_NETWORK_ERROR', retryable: true });
        }
        if (response.status === 200) break;
        await response.body?.cancel().catch(() => {});
        if (response.status !== 202 || attempt === 5) {
          throw new LINEError(`LINE media is unavailable (HTTP ${response.status}).`, {
            status: response.status, code: 'MEDIA_HTTP_ERROR',
            retryable: [202, 408, 429].includes(response.status) || response.status >= 500,
          });
        }
        await delay(Math.min(500 * 2 ** attempt, 4000), undefined, { signal });
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null && (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength)))) {
        throw new LINEError('LINE media content length is invalid.', { code: 'INVALID_CONTENT_LENGTH' });
      }
      if (contentLength !== null && Number(contentLength) > maxBytes) {
        throw new LINEError('LINE media exceeds the configured byte limit.', { code: 'MEDIA_TOO_LARGE' });
      }
      const contentType = (response.headers.get('content-type') || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
      if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) {
        throw new LINEError('LINE media content type is invalid.', { code: 'INVALID_CONTENT_TYPE' });
      }
      if (!response.body) throw new LINEError('LINE media response has no content.', { code: 'EMPTY_CONTENT', retryable: true });
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try {
        const existing = await lstat(path);
        if (!existing.isFile() || existing.isSymbolicLink()) throw new LINEError('Media target must be a regular file.', { code: 'INVALID_MEDIA_TARGET' });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      reader = response.body.getReader();
      let size = 0;
      for (;;) {
        let part;
        try { part = await reader.read(); } catch {
          throw new LINEError('LINE media stream did not complete.', { code: 'MEDIA_NETWORK_ERROR', retryable: true });
        }
        const { done, value } = part;
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new LINEError('LINE media exceeds the configured byte limit.', { code: 'MEDIA_TOO_LARGE' });
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
          if (bytesWritten === 0) throw new Error('Media file write made no progress.');
          offset += bytesWritten;
        }
      }
      if (contentLength !== null && Number(contentLength) !== size) {
        throw new LINEError('LINE media ended before its declared length was read.', { code: 'CONTENT_LENGTH_MISMATCH', retryable: true });
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tempPath, path);
      return { path, contentType, size };
    } catch (error) {
      if (error instanceof LINEError) throw error;
      throw new LINEError('LINE media could not be downloaded or saved.', {
        code: 'MEDIA_DOWNLOAD_ERROR', retryable: signal.aborted || error?.name === 'TypeError',
      });
    } finally {
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else await response?.body?.cancel().catch(() => {});
      await handle?.close().catch(() => {});
      await unlink(tempPath).catch(() => {});
    }
  }
}
