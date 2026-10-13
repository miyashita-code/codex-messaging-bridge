import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const API = 'https://discord.com/api/v10';
const HTTP_TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT = 1024 * 1024;
const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const NO_RESUME_CLOSE_CODES = new Set([4007, 4009]);

export class DiscordError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = 'DiscordError';
    this.status = fields.status ?? 0;
    this.code = fields.code ?? 'DISCORD_ERROR';
    this.discordCode = fields.discordCode;
    this.retryable = fields.retryable ?? false;
    this.uncertain = fields.uncertain ?? false;
    this.accepted = fields.accepted ?? false;
    this.retryAfterMs = fields.retryAfterMs;
    this.globalRateLimit = fields.globalRateLimit ?? false;
    this.sentMessages = fields.sentMessages ?? [];
    this.messageIds = fields.messageIds ?? [];
  }
}

function invalid(message) { throw new DiscordError(message, { code: 'INVALID_MESSAGE' }); }
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object.`);
}
function text(value, label, limit, optional = false) {
  if (optional && value === undefined) return 0;
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    invalid(`${label} must contain 1 to ${limit} UTF-16 units.`);
  }
  return value.length;
}
function onlyKeys(value, keys, label) {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid(`${label} contains unsupported fields.`);
}
function httpsURL(value, label, max = 2048) {
  text(value, label, max);
  let url;
  try { url = new URL(value); } catch { invalid(`${label} must be an HTTPS URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) invalid(`${label} must be an HTTPS URL without credentials.`);
  return url;
}
export function discordId(value, label = 'Discord ID') {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) invalid(`${label} must be a decimal snowflake string.`);
  return value;
}

/** One logical delivery must keep the same caller key across all retries. */
export function discordNonce(key, index = 0) {
  text(key, 'Delivery nonce', 512);
  if (!Number.isSafeInteger(index) || index < 0) invalid('Message index must be a non-negative integer.');
  const hash = createHash('sha256').update(JSON.stringify([key, index])).digest('hex').slice(0, 20);
  return BigInt(`0x${hash}`).toString();
}

function validateEmbeds(embeds) {
  if (!Array.isArray(embeds) || embeds.length > 10) invalid('Discord supports at most 10 embeds per message.');
  let units = 0;
  for (const embed of embeds) {
    record(embed, 'Embed');
    onlyKeys(embed, ['title', 'description', 'url', 'timestamp', 'color', 'footer', 'image', 'thumbnail', 'author', 'fields'], 'Embed');
    units += text(embed.title, 'Embed title', 256, true);
    units += text(embed.description, 'Embed description', 4096, true);
    if (embed.url !== undefined) httpsURL(embed.url, 'Embed URL');
    if (embed.timestamp !== undefined && (typeof embed.timestamp !== 'string' || !Number.isFinite(Date.parse(embed.timestamp)))) invalid('Embed timestamp must be a valid date string.');
    if (embed.color !== undefined && (!Number.isInteger(embed.color) || embed.color < 0 || embed.color > 0xffffff)) invalid('Embed color must be a 24-bit integer.');
    for (const key of ['image', 'thumbnail']) if (embed[key] !== undefined) {
      record(embed[key], `Embed ${key}`);
      onlyKeys(embed[key], ['url'], `Embed ${key}`);
      httpsURL(embed[key].url, `Embed ${key} URL`);
    }
    if (embed.footer !== undefined) {
      record(embed.footer, 'Embed footer');
      onlyKeys(embed.footer, ['text', 'icon_url'], 'Embed footer');
      units += text(embed.footer.text, 'Embed footer text', 2048);
      if (embed.footer.icon_url !== undefined) httpsURL(embed.footer.icon_url, 'Embed footer icon');
    }
    if (embed.author !== undefined) {
      record(embed.author, 'Embed author');
      onlyKeys(embed.author, ['name', 'url', 'icon_url'], 'Embed author');
      units += text(embed.author.name, 'Embed author name', 256);
      for (const key of ['url', 'icon_url']) if (embed.author[key] !== undefined) httpsURL(embed.author[key], `Embed author ${key}`);
    }
    if (embed.fields !== undefined) {
      if (!Array.isArray(embed.fields) || embed.fields.length > 25) invalid('Embed fields must contain at most 25 items.');
      for (const field of embed.fields) {
        record(field, 'Embed field');
        onlyKeys(field, ['name', 'value', 'inline'], 'Embed field');
        units += text(field.name, 'Embed field name', 256) + text(field.value, 'Embed field value', 1024);
        if (field.inline !== undefined && typeof field.inline !== 'boolean') invalid('Embed field inline must be boolean.');
      }
    }
  }
  if (units > 6000) invalid('The combined embed text exceeds 6000 UTF-16 units.');
}

function validateComponents(components) {
  if (!Array.isArray(components) || components.length > 5) invalid('Components must contain at most 5 action rows.');
  for (const row of components) {
    record(row, 'Action row');
    onlyKeys(row, ['type', 'components'], 'Action row');
    if (row.type !== 1 || !Array.isArray(row.components) || row.components.length < 1 || row.components.length > 5) invalid('Each action row must contain 1 to 5 buttons.');
    for (const button of row.components) {
      record(button, 'Button');
      onlyKeys(button, ['type', 'style', 'label', 'url', 'custom_id', 'disabled'], 'Button');
      if (button.type !== 2 || ![1, 2, 3, 4, 5].includes(button.style)) invalid('Only standard buttons and link buttons are supported.');
      text(button.label, 'Button label', 80);
      if (button.style === 5) {
        httpsURL(button.url, 'Button URL', 512);
        if (button.custom_id !== undefined) invalid('Link buttons cannot carry a custom ID.');
      } else {
        text(button.custom_id, 'Button custom ID', 100);
        if (button.url !== undefined) invalid('Interactive buttons cannot carry a link URL.');
      }
      if (button.disabled !== undefined && typeof button.disabled !== 'boolean') invalid('Button disabled must be boolean.');
    }
  }
  const identifiers = components.flatMap((row) => row.components.map((item) => item.custom_id)).filter((item) => item !== undefined);
  if (new Set(identifiers).size !== identifiers.length) invalid('Button custom IDs must be unique within a message.');
}

export function validateDiscordMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 100) invalid('A Discord delivery must contain 1 to 100 messages.');
  for (const message of messages) {
    record(message, 'Message');
    onlyKeys(message, ['content', 'embeds', 'components', 'replyTo'], 'Message');
    if (message.content !== undefined && (typeof message.content !== 'string' || message.content.length > 2000)) invalid('Discord content must contain at most 2000 UTF-16 units.');
    if (message.embeds !== undefined) validateEmbeds(message.embeds);
    if (message.components !== undefined) validateComponents(message.components);
    if (!message.content?.trim() && !message.embeds?.length && !message.components?.length) invalid('Discord message must contain text, an embed, or components.');
    if (message.replyTo !== undefined) discordId(message.replyTo, 'Referenced message ID');
  }
  let json;
  try { json = JSON.stringify(messages); } catch { invalid('Messages must be serializable JSON.'); }
  if (Buffer.byteLength(json) > RESPONSE_LIMIT) invalid('Discord delivery exceeds the supported payload limit.');
  return messages;
}

async function limitedBody(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) throw new Error('Response exceeds byte limit.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class DiscordClient {
  #token;
  #fetch;
  constructor(account, { fetchImpl = fetch } = {}) {
    if (typeof account?.token !== 'string' || !account.token.trim()) throw new DiscordError('Discord bot token is not configured.', { code: 'MISSING_CREDENTIAL' });
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
    this.#token = account.token.trim();
    this.#fetch = fetchImpl;
    this.accountId = account.accountId ?? 'default';
  }
  async #request(path, { method = 'GET', body, send = false, authenticated = true, arrayResult = false } = {}) {
    let response;
    try {
      response = await this.#fetch(`${API}/${path}`, {
        method, headers: { ...(authenticated ? { Authorization: `Bot ${this.#token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch { throw new DiscordError('Discord request failed before a response was received.', { code: 'NETWORK_ERROR', retryable: true, uncertain: send }); }
    let raw;
    try { raw = await limitedBody(response); } catch {
      throw new DiscordError('Discord response could not be read.', { status: response.status, code: 'RESPONSE_UNREADABLE',
        accepted: send && response.ok, uncertain: send && (response.ok || response.status >= 500 || response.status === 408),
        retryable: !response.ok && (response.status >= 500 || [408, 429].includes(response.status)) });
    }
    let result;
    try { result = raw ? JSON.parse(raw) : {}; } catch { result = null; }
    if (!response.ok) {
      const retryAfter = Number(result?.retry_after ?? response.headers.get('retry-after'));
      throw new DiscordError(`Discord API refused the request (HTTP ${response.status}).`, {
        status: response.status, code: 'HTTP_ERROR', retryable: response.status >= 500 || [408, 429].includes(response.status),
        discordCode: Number.isSafeInteger(result?.code) ? result.code : undefined,
        uncertain: send && (response.status >= 500 || response.status === 408),
        retryAfterMs: response.status === 429 && Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.ceil(retryAfter * 1000) : undefined,
        globalRateLimit: response.status === 429 && result?.global === true,
      });
    }
    if (!result || typeof result !== 'object' || (arrayResult ? !Array.isArray(result) : Array.isArray(result))) throw new DiscordError('Discord accepted the request but returned an invalid response.', {
      status: response.status, code: 'INVALID_RESPONSE', accepted: send, uncertain: send, retryable: !send,
    });
    return result;
  }
  async botInfo() { return this.#request('users/@me'); }
  async applicationInfo() { return this.#request('oauth2/applications/@me'); }
  async gatewayInfo() { return this.#request('gateway/bot'); }
  async channelInfo(channelId) { return this.#request(`channels/${discordId(channelId)}`); }
  async typing(channelId) { return this.#request(`channels/${discordId(channelId)}/typing`, { method: 'POST' }); }

  async interactionCallback(id, token, body) {
    discordId(id, 'Interaction ID'); text(token, 'Interaction token', 4096); record(body, 'Interaction callback');
    onlyKeys(body, ['type', 'data'], 'Interaction callback');
    if (![4, 5, 6, 7].includes(body.type)) invalid('Unsupported interaction callback type.');
    const data = body.data ?? {};
    record(data, 'Interaction callback data');
    onlyKeys(data, ['content', 'embeds', 'components', 'flags', 'allowed_mentions'], 'Interaction callback data');
    if (data.allowed_mentions !== undefined) {
      record(data.allowed_mentions, 'Interaction allowed mentions');
      onlyKeys(data.allowed_mentions, ['parse', 'users', 'roles', 'replied_user'], 'Interaction allowed mentions');
      for (const key of ['parse', 'users', 'roles']) if (data.allowed_mentions[key] !== undefined && (!Array.isArray(data.allowed_mentions[key]) || data.allowed_mentions[key].length)) invalid('Interaction mention permissions must be empty.');
      if (data.allowed_mentions.replied_user !== undefined && data.allowed_mentions.replied_user !== false) invalid('Interaction reply mentions must be disabled.');
    }
    if (data.flags !== undefined && (data.flags !== 64 || ![4, 5].includes(body.type))) invalid('Only the ephemeral interaction flag is supported.');
    if ([4, 7].includes(body.type)) {
      const { flags: _flags, allowed_mentions: _mentions, ...message } = data;
      validateDiscordMessages([message]);
    } else if (Object.keys(data).some((key) => key !== 'flags') || (body.type === 6 && Object.keys(data).length)) invalid('Deferred callbacks cannot contain a message body.');
    return this.#request(`interactions/${id}/${encodeURIComponent(token)}/callback`, { method: 'POST', authenticated: false, send: true,
      body: { type: body.type, ...([4, 7].includes(body.type) ? { data: { ...data, allowed_mentions: { parse: [], replied_user: false } } } : body.data ? { data } : {}) } });
  }

  async editInteractionResponse(applicationId, token, message) {
    discordId(applicationId, 'Application ID'); text(token, 'Interaction token', 4096);
    validateDiscordMessages([message]);
    if (message.replyTo !== undefined) invalid('An interaction response cannot carry a reply reference.');
    return this.#request(`webhooks/${applicationId}/${encodeURIComponent(token)}/messages/@original`, { method: 'PATCH', authenticated: false, send: true,
      body: { ...message, allowed_mentions: { parse: [], replied_user: false } } });
  }

  async registerCommands(applicationId, commands, guildId) {
    discordId(applicationId, 'Application ID');
    if (guildId !== undefined) discordId(guildId, 'Guild ID');
    if (!Array.isArray(commands) || commands.length > 100) invalid('Command registration requires at most 100 commands.');
    const names = new Set();
    for (const command of commands) {
      record(command, 'Command'); onlyKeys(command, ['type', 'name', 'description', 'dm_permission', 'default_member_permissions'], 'Command');
      if (command.type !== undefined && command.type !== 1) invalid('Only chat input commands are supported.');
      if (typeof command.name !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(command.name)) invalid('Command names must be 1 to 32 lowercase ASCII letters, digits, underscores or hyphens.');
      text(command.description, 'Command description', 100);
      if (names.has(command.name)) invalid('Command names must be unique.');
      names.add(command.name);
      if (command.dm_permission !== undefined && typeof command.dm_permission !== 'boolean') invalid('Command DM permission must be boolean.');
      if (command.default_member_permissions !== undefined && command.default_member_permissions !== null && !/^\d+$/.test(command.default_member_permissions)) invalid('Command member permissions must be a decimal string or null.');
    }
    // Discord's bulk command replacement endpoint returns an array.
    const path = `applications/${applicationId}/${guildId ? `guilds/${guildId}/` : ''}commands`;
    return this.#request(path, { method: 'PUT', body: commands, arrayResult: true });
  }

  async send(channelId, messages, nonce) {
    discordId(channelId, 'Channel ID');
    validateDiscordMessages(messages);
    discordNonce(nonce);
    const sentMessages = [];
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      try {
        const result = await this.#request(`channels/${channelId}/messages`, { method: 'POST', send: true, body: {
          ...(message.content === undefined ? {} : { content: message.content }),
          ...(message.embeds === undefined ? {} : { embeds: message.embeds }),
          ...(message.components === undefined ? {} : { components: message.components }),
          ...(message.replyTo === undefined ? {} : { message_reference: { message_id: message.replyTo, fail_if_not_exists: false } }),
          allowed_mentions: { parse: [], replied_user: false }, nonce: discordNonce(nonce, index), enforce_nonce: true,
        } });
        if (typeof result.id !== 'string' || !/^[1-9]\d{0,19}$/.test(result.id)) throw new DiscordError('Discord accepted the message without a valid message receipt.', {
          code: 'INVALID_RESPONSE', accepted: true, uncertain: true,
        });
        sentMessages.push({ id: result.id });
      } catch (error) {
        if (error instanceof DiscordError) { error.sentMessages = sentMessages; error.messageIds = sentMessages.map((item) => item.id); }
        throw error;
      }
    }
    return { accepted: true, sentMessages, messageIds: sentMessages.map((item) => item.id), receiptComplete: true };
  }

  async download(attachment, targetPath, maxBytes = 10 * 1024 * 1024) {
    record(attachment, 'Attachment');
    const url = httpsURL(attachment.url, 'Attachment URL', 4096);
    if (!CDN_HOSTS.has(url.hostname.toLowerCase()) || (url.port && url.port !== '443') || !url.pathname.startsWith('/attachments/')) invalid('Attachment URL must use the official Discord attachment CDN.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) invalid('Media byte limit must be a positive integer.');
    if (attachment.size !== undefined && (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > maxBytes)) invalid('Attachment exceeds the configured byte limit.');
    if (typeof targetPath !== 'string' || !targetPath) invalid('Media target path is required.');
    const path = resolve(targetPath);
    const temporary = resolve(dirname(path), `.${basename(path)}.part-${randomUUID()}`);
    const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
    let response, handle, reader;
    try {
      try { response = await this.#fetch(url.href, { redirect: 'error', signal }); } catch {
        throw new DiscordError('Discord media request failed.', { code: 'MEDIA_NETWORK_ERROR', retryable: true });
      }
      if (response.status !== 200) throw new DiscordError(`Discord media is unavailable (HTTP ${response.status}).`, {
        status: response.status, code: 'MEDIA_HTTP_ERROR', retryable: [408, 429].includes(response.status) || response.status >= 500,
      });
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) throw new DiscordError('Discord media content length is invalid.', { code: 'INVALID_CONTENT_LENGTH' });
      if (declared !== null && Number(declared) > maxBytes) throw new DiscordError('Discord media exceeds the configured byte limit.', { code: 'MEDIA_TOO_LARGE' });
      const contentType = (response.headers.get('content-type') || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
      if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) throw new DiscordError('Discord media content type is invalid.', { code: 'INVALID_CONTENT_TYPE' });
      if (!response.body) throw new DiscordError('Discord media response has no content.', { code: 'EMPTY_CONTENT' });
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try { const existing = await lstat(path); if (!existing.isFile() || existing.isSymbolicLink()) throw new DiscordError('Media target must be a regular file.', { code: 'INVALID_MEDIA_TARGET' }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      reader = response.body.getReader();
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new DiscordError('Discord media exceeds the configured byte limit.', { code: 'MEDIA_TOO_LARGE' });
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
          if (!bytesWritten) throw new Error('Media file write did not advance.');
          offset += bytesWritten;
        }
      }
      if (declared !== null && Number(declared) !== size) throw new DiscordError('Discord media length did not match its declaration.', { code: 'CONTENT_LENGTH_MISMATCH', retryable: true });
      await handle.sync(); await handle.close(); handle = undefined;
      await rename(temporary, path);
      return { path, contentType, size };
    } catch (error) {
      if (error instanceof DiscordError) throw error;
      throw new DiscordError('Discord media could not be downloaded or saved.', { code: 'MEDIA_DOWNLOAD_ERROR', retryable: signal.aborted || error?.name === 'TypeError' });
    } finally {
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else await response?.body?.cancel().catch(() => {});
      await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {});
    }
  }
}

function gatewayURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new DiscordError('Discord gateway URL is invalid.', { code: 'INVALID_GATEWAY' }); }
  if (url.protocol !== 'wss:' || url.username || url.password || (url.port && url.port !== '443') ||
      !/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(url.hostname)) {
    throw new DiscordError('Discord gateway must use the official secure gateway host.', { code: 'INVALID_GATEWAY' });
  }
  url.search = '?v=10&encoding=json';
  url.hash = '';
  return url.href;
}

/** Gateway ingress acknowledges a dispatch only after onMessage durably accepts it. */
export class DiscordGateway {
  #account; #token; #client; #WebSocket; #onMessage; #onInteraction; #onInteractionReceived; #logger; #socket; #presence;
  #stopped = true; #fatal; #ready = false; #session; #resumeURL; #gatewayURL;
  #receivedSeq = null; #committedSeq = null; #userId; #channels = new Map(); #guilds = new Map();
  #heartbeatTimer; #reconnectTimer; #helloTimer; #awaitingAck = false; #heartbeatInterval = 0;
  #attempt = 0; #dispatchTail = Promise.resolve(); #paused = false; #pending = 0; #generation = 0;
  #timers; #random;
  constructor(account, { onMessage, onInteraction, onInteractionReceived, logger = console, WebSocketImpl = globalThis.WebSocket, fetchImpl = fetch,
    timers = { setTimeout, clearTimeout }, random = Math.random } = {}) {
    this.#client = new DiscordClient(account, { fetchImpl });
    if (typeof WebSocketImpl !== 'function') throw new DiscordError('This Node runtime does not provide WebSocket.', { code: 'WEBSOCKET_UNAVAILABLE' });
    if (typeof onMessage !== 'function') throw new TypeError('onMessage must be a function.');
    if (onInteraction !== undefined && typeof onInteraction !== 'function') throw new TypeError('onInteraction must be a function.');
    if (onInteractionReceived !== undefined && typeof onInteractionReceived !== 'function') throw new TypeError('onInteractionReceived must be a function.');
    const presenceStatus = account.status ?? 'online';
    if (!['online', 'idle', 'dnd', 'invisible', 'offline'].includes(presenceStatus)) throw new DiscordError('Discord presence status is invalid.', { code: 'INVALID_PRESENCE' });
    this.#presence = { status: presenceStatus, since: null, afk: false, activities: [] };
    this.#account = account; this.#token = account.token.trim(); this.#WebSocket = WebSocketImpl;
    this.#onMessage = onMessage; this.#onInteraction = onInteraction; this.#onInteractionReceived = onInteractionReceived;
    this.#logger = logger; this.#timers = timers; this.#random = random;
  }
  status() { return { running: !this.#stopped, connected: this.#socket?.readyState === 1, ready: this.#ready,
    accountId: this.#account.accountId ?? 'default', botUserId: this.#userId, receivedSequence: this.#receivedSeq,
    committedSequence: this.#committedSeq, pendingDispatches: this.#pending, fatalCode: this.#fatal }; }
  #log(message) { this.#logger?.warn?.(message); }
  #timer(callback, milliseconds) { const timer = this.#timers.setTimeout(callback, milliseconds); timer?.unref?.(); return timer; }
  #clearTimers() {
    for (const timer of [this.#heartbeatTimer, this.#helloTimer]) if (timer !== undefined) this.#timers.clearTimeout(timer);
    this.#heartbeatTimer = this.#helloTimer = undefined;
  }
  #clearSession() { this.#session = this.#resumeURL = undefined; this.#receivedSeq = this.#committedSeq = null; this.#channels.clear(); this.#guilds.clear(); }
  async start() {
    if (!this.#stopped) return;
    this.#stopped = false; this.#fatal = undefined;
    try {
      const discovery = await this.#client.gatewayInfo();
      this.#gatewayURL = gatewayURL(discovery.url);
      if (Number.isInteger(discovery.shards) && discovery.shards > 1) throw new DiscordError('This bridge supports a single Discord shard; a sharded bot requires a separate gateway runtime.', { code: 'SHARDING_REQUIRED' });
      if (discovery.session_start_limit?.remaining === 0) throw new DiscordError('Discord identify session limit is exhausted.', { code: 'SESSION_LIMIT', retryable: true, retryAfterMs: discovery.session_start_limit.reset_after });
      await this.#connect();
    } catch (error) { this.#stopped = true; throw error; }
  }
  async #connect() {
    await this.#dispatchTail;
    if (this.#stopped) return;
    this.#paused = false; this.#ready = false; this.#awaitingAck = false;
    const generation = ++this.#generation;
    let socket;
    try { socket = new this.#WebSocket(this.#session ? this.#resumeURL : this.#gatewayURL); } catch { this.#scheduleReconnect(); return; }
    this.#socket = socket;
    this.#helloTimer = this.#timer(() => { if (this.#socket === socket) this.#disconnect(); }, 30_000);
    socket.addEventListener('message', (event) => { if (this.#socket !== socket || this.#stopped) return; this.#receive(event.data, generation); });
    socket.addEventListener('error', () => { if (this.#socket === socket && !this.#stopped) this.#disconnect(); });
    socket.addEventListener('close', (event) => {
      if (this.#socket !== socket) return;
      this.#socket = undefined; this.#ready = false; this.#clearTimers();
      if (this.#stopped) return;
      if (FATAL_CLOSE_CODES.has(event.code)) {
        this.#fatal = event.code; this.#stopped = true;
        this.#log(`Discord gateway stopped (close code ${event.code}); check the bot token, intents and shard configuration.`);
        return;
      }
      if (NO_RESUME_CLOSE_CODES.has(event.code)) this.#dispatchTail = this.#dispatchTail.then(() => this.#clearSession());
      this.#scheduleReconnect();
    });
  }
  #send(op, data) {
    if (this.#socket?.readyState !== 1) return false;
    try { this.#socket.send(JSON.stringify({ op, d: data })); return true; } catch { this.#disconnect(); return false; }
  }
  #disconnect() {
    this.#clearTimers(); this.#ready = false;
    const socket = this.#socket;
    this.#socket = undefined;
    try { socket?.close(4000, 'Reconnect'); } catch {}
    if (!this.#stopped) this.#scheduleReconnect();
  }
  #scheduleReconnect(invalidSession = false) {
    if (this.#stopped || this.#reconnectTimer !== undefined) return;
    const wait = invalidSession ? 1000 + Math.floor(this.#random() * 4000) : Math.min(30_000, 1000 * 2 ** Math.min(this.#attempt++, 5)) + Math.floor(this.#random() * 1000);
    this.#reconnectTimer = this.#timer(() => { this.#reconnectTimer = undefined; this.#connect().catch(() => { this.#log('Discord gateway reconnect failed.'); this.#scheduleReconnect(); }); }, wait);
  }
  #heartbeat(repeat = false) {
    if (this.#stopped || !this.#socket) return;
    if (repeat && this.#awaitingAck) { this.#log('Discord gateway heartbeat acknowledgement was missed.'); this.#disconnect(); return; }
    if (this.#send(1, this.#receivedSeq)) this.#awaitingAck = true;
    if (repeat) this.#heartbeatTimer = this.#timer(() => this.#heartbeat(true), this.#heartbeatInterval);
  }
  #receive(data, generation) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > 8 * RESPONSE_LIMIT) { this.#disconnect(); return; }
    let payload;
    try { payload = JSON.parse(data); } catch { this.#disconnect(); return; }
    if (!payload || typeof payload !== 'object' || !Number.isInteger(payload.op)) { this.#disconnect(); return; }
    switch (payload.op) {
      case 10: {
        if (this.#heartbeatTimer !== undefined || !Number.isFinite(payload.d?.heartbeat_interval) || payload.d.heartbeat_interval < 100) { this.#disconnect(); return; }
        this.#timers.clearTimeout(this.#helloTimer); this.#helloTimer = undefined;
        this.#heartbeatInterval = payload.d.heartbeat_interval;
        this.#heartbeatTimer = this.#timer(() => this.#heartbeat(true), Math.floor(this.#random() * this.#heartbeatInterval));
        if (this.#session && this.#committedSeq !== null) this.#send(6, { token: this.#token, session_id: this.#session, seq: this.#committedSeq });
        else this.#send(2, { token: this.#token, intents: 1 | (1 << 9) | (1 << 12) | (this.#account.intents?.messageContent === false ? 0 : (1 << 15)) | (this.#account.intents?.guildMembers ? 2 : 0),
          properties: { os: process.platform, browser: 'codex-discord-bridge', device: 'codex-discord-bridge' }, presence: this.#presence });
        this.#helloTimer = this.#timer(() => { if (!this.#ready) this.#disconnect(); }, 30_000);
        break;
      }
      case 11: this.#awaitingAck = false; break;
      case 1: this.#heartbeat(false); break;
      case 7: this.#disconnect(); break;
      case 9:
        if (payload.d !== true) this.#dispatchTail = this.#dispatchTail.then(() => this.#clearSession());
        this.#clearTimers();
        { const socket = this.#socket; this.#socket = undefined; try { socket?.close(4000, 'Invalid session'); } catch {} }
        this.#scheduleReconnect(true); break;
      case 0:
        if (!Number.isSafeInteger(payload.s) || payload.s < 0 || typeof payload.t !== 'string') { this.#disconnect(); return; }
        this.#receivedSeq = payload.s;
        if (++this.#pending > 1000) { this.#pending--; this.#paused = true; this.#disconnect(); return; }
        // A preceding metadata lookup must not consume an interaction's ACK deadline.
        // Attach both outcomes immediately so a fast rejection cannot go unhandled
        // while the ordered dispatch queue is still processing an earlier message.
        const interactionAck = payload.t === 'INTERACTION_CREATE' && this.#onInteractionReceived && !this.#paused &&
          (this.#committedSeq === null || payload.s > this.#committedSeq)
          ? Promise.resolve().then(() => this.#onInteractionReceived({ ...payload.d, botUserId: this.#userId }))
            .then(() => true, () => false)
          : undefined;
        this.#dispatchTail = this.#dispatchTail.then(async () => {
          if (this.#paused || this.#stopped || generation !== this.#generation || (this.#committedSeq !== null && payload.s <= this.#committedSeq)) return;
          try {
            if (interactionAck !== undefined && !await interactionAck) throw new Error('Interaction was not acknowledged.');
            await this.#dispatch(payload);
            this.#committedSeq = payload.s;
          } catch {
            this.#paused = true; this.#log('Discord ingress was not durably accepted; reconnecting from the last committed sequence.'); this.#disconnect();
          }
        }).finally(() => { this.#pending--; });
        break;
      default: break;
    }
  }
  async #dispatch(payload) {
    const data = payload.d;
    if (!data || typeof data !== 'object') throw new Error('Invalid dispatch data.');
    if (payload.t === 'READY') {
      text(data.session_id, 'Gateway session ID', 256);
      const resumeURL = gatewayURL(data.resume_gateway_url);
      const userId = discordId(data.user?.id, 'Bot user ID');
      this.#resumeURL = resumeURL; this.#session = data.session_id;
      this.#userId = userId; this.#ready = true; this.#attempt = 0;
      this.#timers.clearTimeout(this.#helloTimer); this.#helloTimer = undefined;
      for (const channel of data.private_channels ?? []) if (channel?.id) this.#channels.set(channel.id, channel);
      for (const guild of data.guilds ?? []) if (guild?.id) this.#guilds.set(guild.id, { id: guild.id, ...(typeof guild.name === 'string' ? { name: guild.name } : {}) });
    } else if (payload.t === 'RESUMED') {
      this.#ready = true; this.#attempt = 0; this.#timers.clearTimeout(this.#helloTimer); this.#helloTimer = undefined;
    } else if (payload.t === 'GUILD_CREATE') {
      if (data.id) this.#guilds.set(data.id, { ...this.#guilds.get(data.id), id: data.id, ...(typeof data.name === 'string' ? { name: data.name } : {}) });
      for (const channel of [...(data.channels ?? []), ...(data.threads ?? [])]) if (channel?.id) this.#channels.set(channel.id, { ...channel, guild_id: data.id });
    } else if (payload.t === 'GUILD_UPDATE') {
      if (data.id) this.#guilds.set(data.id, { ...this.#guilds.get(data.id), id: data.id, ...(typeof data.name === 'string' ? { name: data.name } : {}) });
    } else if (payload.t === 'GUILD_DELETE' && !data.unavailable) {
      this.#guilds.delete(data.id);
      for (const [id, channel] of this.#channels) if (channel.guild_id === data.id) this.#channels.delete(id);
    } else if (['CHANNEL_CREATE', 'CHANNEL_UPDATE', 'THREAD_CREATE', 'THREAD_UPDATE'].includes(payload.t)) {
      if (data.id) this.#channels.set(data.id, { ...this.#channels.get(data.id), ...data });
    } else if (['CHANNEL_DELETE', 'THREAD_DELETE'].includes(payload.t)) this.#channels.delete(data.id);
    else if (payload.t === 'THREAD_LIST_SYNC') {
      for (const channel of data.threads ?? []) if (channel?.id) this.#channels.set(channel.id, { ...channel, guild_id: data.guild_id });
    } else if (payload.t === 'MESSAGE_CREATE') {
      const channel = this.#channels.get(data.channel_id);
      const parent = channel?.parent_id ? this.#channels.get(channel.parent_id) : undefined;
      const guild = data.guild_id ? this.#guilds.get(data.guild_id) : undefined;
      const channelMetadata = channel ? { ...channel, ...(parent ? { parent: { id: parent.id, ...(typeof parent.name === 'string' ? { name: parent.name } : {}), type: parent.type } } : {}) } : undefined;
      await this.#onMessage({ ...data, ...(guild ? { guild: { ...guild } } : {}), ...(channelMetadata ? { channel: channelMetadata, channelType: channel.type, parentId: channel.parent_id } : {}), botUserId: this.#userId });
    } else if (payload.t === 'INTERACTION_CREATE' && this.#onInteraction) {
      const channel=this.#channels.get(data.channel_id),guild=data.guild_id?this.#guilds.get(data.guild_id):undefined,parent=channel?.parent_id?this.#channels.get(channel.parent_id):undefined;
      await this.#onInteraction({ ...data, ...(guild?{guild:{...guild}}:{}),...(channel?{channel:{...channel,...(parent?{parent:{id:parent.id,name:parent.name,type:parent.type}}:{})}}:{}),botUserId:this.#userId });
    }
  }
  async close() {
    this.#stopped = true; this.#ready = false; this.#clearTimers();
    if (this.#reconnectTimer !== undefined) this.#timers.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    const socket = this.#socket; this.#socket = undefined;
    try { socket?.close(1000, 'Bridge stopped'); } catch {}
    await this.#dispatchTail;
    this.#clearSession();
  }
}
