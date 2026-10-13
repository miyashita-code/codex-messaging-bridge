import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordClient, DiscordError, DiscordGateway, discordNonce, validateDiscordMessages } from '../src/discord.mjs';

const TOKEN = 'secret-discord-token';
const account = { token: TOKEN, accountId: 'test' };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const flush = async () => { for (let index = 0; index < 100; index++) await Promise.resolve(); };
const message = { id: '900', channel_id: '200', author: { id: '300' }, content: 'Hello' };

test('native message validation enforces Discord text, embed and component limits before sending', () => {
  const link = { type: 1, components: [{ type: 2, style: 5, label: 'Details', url: 'https://example.com' }] };
  const button = { type: 1, components: [{ type: 2, style: 1, label: 'Approve', custom_id: 'approval:one' }] };
  for (const item of [{ content: '😀'.repeat(1000) }, { embeds: [{ title: 'A', description: 'B', fields: [{ name: 'C', value: 'D' }] }] }, { components: [link, button] }]) assert.doesNotThrow(() => validateDiscordMessages([item]));
  for (const item of [
    { content: 'a'.repeat(2001) }, {}, { content: 'A', allowed_mentions: { parse: ['everyone'] } },
    { content: 'A', flags: 64 }, { embeds: [{ description: 'a'.repeat(4097) }] },
    { embeds: [{ description: 'a'.repeat(4000) }, { description: 'b'.repeat(2001) }] },
    { embeds: [{ fields: Array(26).fill({ name: 'a', value: 'b' }) }] },
    { components: Array(6).fill(link) }, { components: [{ type: 1, components: Array(6).fill(link.components[0]) }] },
    { components: [{ type: 1, components: [{ type: 3, custom_id: 'select' }] }] },
    { components: [{ type: 1, components: [{ type: 2, style: 5, label: 'A', url: 'javascript:alert(1)' }] }] },
    { components: [{ type: 1, components: [{ type: 2, style: 1, label: 'A', custom_id: 'a'.repeat(101) }] }] },
    { components: [button, button] }, { content: 'A', replyTo: '../channel' },
  ]) assert.throws(() => validateDiscordMessages([item]), DiscordError);
});

test('stable decimal nonces fit the provider limit and differ by message index', () => {
  assert.equal(discordNonce('logical-outbox-id'), discordNonce('logical-outbox-id'));
  assert.match(discordNonce('logical-outbox-id'), /^\d{1,25}$/);
  assert.notEqual(discordNonce('logical-outbox-id', 0), discordNonce('logical-outbox-id', 1));
  assert.throws(() => discordNonce(''), DiscordError);
});

test('send suppresses all mentions, preserves retry nonce, and reports provider receipts', async () => {
  const calls = [];
  const client = new DiscordClient(account, { fetchImpl: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return json({ id: '500' }); } });
  const first = await client.send('200', [{ content: '@everyone <@300>', replyTo: '900' }], 'same-delivery');
  await client.send('200', [{ content: '@everyone <@300>', replyTo: '900' }], 'same-delivery');
  assert.deepEqual(first.messageIds, ['500']);
  assert.equal(first.receiptComplete, true);
  assert.equal(calls[0].url, 'https://discord.com/api/v10/channels/200/messages');
  assert.equal(calls[0].init.headers.Authorization, `Bot ${TOKEN}`);
  assert.equal(calls[0].body.enforce_nonce, true);
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [], replied_user: false });
  assert.deepEqual(calls[0].body.message_reference, { message_id: '900', fail_if_not_exists: false });
  assert.equal(calls[0].body.nonce, calls[1].body.nonce);
  assert.equal(calls[0].init.redirect, 'error');
});

test('429 returns rate limit metadata without hidden retries or changing nonce', async () => {
  let calls = 0;
  const client = new DiscordClient(account, { fetchImpl: async () => { calls++; return json({ retry_after: 1.125, global: true, message: TOKEN }, 429); } });
  await assert.rejects(client.send('200', [{ content: 'A' }], 'retry'), (error) => error instanceof DiscordError && error.status === 429 && error.retryAfterMs === 1125 && error.globalRateLimit && error.retryable && !error.uncertain && !error.message.includes(TOKEN));
  assert.equal(calls, 1);
});

test('timeout and server errors preserve uncertain delivery and partial receipts without leaking secrets', async () => {
  const network = new DiscordClient(account, { fetchImpl: async () => { throw new Error(`Bot ${TOKEN}`); } });
  await assert.rejects(network.send('200', [{ content: 'A' }], 'retry'), (error) => error.uncertain && error.retryable && !String(error).includes(TOKEN));
  let calls = 0;
  const partial = new DiscordClient(account, { fetchImpl: async () => ++calls === 1 ? json({ id: '500' }) : json({ message: TOKEN }, 500) });
  await assert.rejects(partial.send('200', [{ content: 'A' }, { content: 'B' }], 'partial'), (error) => error.status === 500 && error.uncertain && error.retryable && error.messageIds[0] === '500');
  const accepted = new DiscordClient(account, { fetchImpl: async () => json({}) });
  await assert.rejects(accepted.send('200', [{ content: 'A' }], 'accepted'), (error) => error.accepted && error.uncertain && !error.retryable);
});

test('credentials and unsafe outbound fields are rejected before requests', async () => {
  assert.throws(() => new DiscordClient({}), (error) => error.code === 'MISSING_CREDENTIAL');
  let calls = 0;
  const client = new DiscordClient(account, { fetchImpl: async () => { calls++; return json({}); } });
  await assert.rejects(client.send('200', [{ content: 'A', flags: 4096 }], 'nonce'), DiscordError);
  await assert.rejects(client.send('../200', [{ content: 'A' }], 'nonce'), DiscordError);
  await assert.rejects(client.send('200', [{ content: 'A' }]), DiscordError);
  assert.equal(calls, 0);
});

test('bot/application discovery and typing use authenticated official REST endpoints', async () => {
  const calls = [];
  const client = new DiscordClient(account, { fetchImpl: async (url, init) => { calls.push({ url, init }); return url.endsWith('/typing') ? new Response(null, { status: 204 }) : json({ id: '500' }); } });
  await client.botInfo(); await client.applicationInfo(); await client.channelInfo('200'); await client.typing('200');
  assert.deepEqual(calls.map(({ url }) => url), ['https://discord.com/api/v10/users/@me', 'https://discord.com/api/v10/oauth2/applications/@me', 'https://discord.com/api/v10/channels/200', 'https://discord.com/api/v10/channels/200/typing']);
  assert(calls.every(({ init }) => init.headers.Authorization === `Bot ${TOKEN}`));
});

test('interaction callbacks defer privately and edits suppress mentions without bot authorization', async () => {
  const calls = [];
  const client = new DiscordClient(account, { fetchImpl: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); } });
  await client.interactionCallback('123', 'interaction/token', { type: 5, data: { flags: 64 } });
  await client.interactionCallback('123', 'interaction/token', { type: 4, data: { content: '@everyone', flags: 64 } });
  await client.editInteractionResponse('456', 'interaction/token', { content: 'Done' });
  assert.equal(calls[0].url, 'https://discord.com/api/v10/interactions/123/interaction%2Ftoken/callback');
  assert.deepEqual(calls[0].body, { type: 5, data: { flags: 64 } });
  assert(calls.every(({ init }) => init.headers.Authorization === undefined));
  assert.deepEqual(calls[1].body.data.allowed_mentions, { parse: [], replied_user: false });
  assert.deepEqual(calls[2].body.allowed_mentions, { parse: [], replied_user: false });
  await assert.rejects(client.interactionCallback('123', 'token', { type: 4, data: { content: 'A', flags: 32768 } }), DiscordError);
});

test('interaction API errors expose the numeric provider code without exposing tokens or response text', async () => {
  const client = new DiscordClient(account, { fetchImpl: async () => json({ code: 40060, message: `Already acknowledged ${TOKEN}` }, 400) });
  await assert.rejects(client.interactionCallback('123', 'private-interaction-token', { type: 5, data: { flags: 64 } }),
    (error) => error.status === 400 && error.discordCode === 40060 && !error.retryable && !JSON.stringify(error).includes(TOKEN) && !JSON.stringify(error).includes('private-interaction-token'));
});

test('explicit native command registration validates before bulk replacement', async () => {
  const calls = [];
  const commands = [{ name: 'help', description: 'Show help', type: 1 }];
  const client = new DiscordClient(account, { fetchImpl: async (url, init) => { calls.push({ url, init }); return json(commands); } });
  assert.deepEqual(await client.registerCommands('456', commands, '789'), commands);
  assert.equal(calls[0].url, 'https://discord.com/api/v10/applications/456/guilds/789/commands');
  assert.equal(calls[0].init.method, 'PUT');
  await assert.rejects(client.registerCommands('456', [{ name: 'HELP', description: 'Show help' }]), DiscordError);
  await assert.rejects(client.registerCommands('456', [commands[0], commands[0]]), DiscordError);
  assert.equal(calls.length, 1);
});

test('attachment downloads use only trusted CDN, stream limits, atomic files and private mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'discord-media-'));
  try {
    const path = join(directory, 'photo.png');
    let request;
    const client = new DiscordClient(account, { fetchImpl: async (url, init) => { request = { url, init }; return new Response('hello', { headers: { 'content-type': 'image/png', 'content-length': '5' } }); } });
    const result = await client.download({ url: 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=123', size: 5 }, path, 5);
    assert.equal(result.contentType, 'image/png'); assert.equal(result.size, 5);
    assert.equal(await readFile(path, 'utf8'), 'hello'); assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(request.init.redirect, 'error'); assert.equal(request.init.headers, undefined);
    for (const url of ['https://127.0.0.1/attachments/1/a', 'https://cdn.discordapp.com.evil.com/attachments/1/a', 'http://cdn.discordapp.com/attachments/1/a', 'https://cdn.discordapp.com:444/attachments/1/a', 'https://cdn.discordapp.com/not-an-attachment']) await assert.rejects(client.download({ url }, path), DiscordError);
    await assert.rejects(client.download({ url: 'https://cdn.discordapp.com/attachments/1/2/a', size: 6 }, path, 5), DiscordError);
    assert.deepEqual(await readdir(directory), ['photo.png']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed media streams preserve existing files and reject symlink targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'discord-media-'));
  try {
    const path = join(directory, 'image');
    await writeFile(path, 'original');
    const client = new DiscordClient(account, { fetchImpl: async () => new Response('oversize', { headers: { 'content-type': 'image/png' } }) });
    const attachment = { url: 'https://media.discordapp.net/attachments/1/2/image' };
    await assert.rejects(client.download(attachment, path, 5), (error) => error.code === 'MEDIA_TOO_LARGE');
    assert.equal(await readFile(path, 'utf8'), 'original');
    const link = join(directory, 'link'); await symlink(path, link);
    await assert.rejects(client.download(attachment, link), (error) => error.code === 'INVALID_MEDIA_TARGET');
    assert.deepEqual((await readdir(directory)).sort(), ['image', 'link']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; this.listeners = new Map(); FakeSocket.instances.push(this); }
  addEventListener(type, listener) { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
  send(data) { this.sent.push(JSON.parse(data)); }
  emit(type, event) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  payload(data) { this.emit('message', { data: JSON.stringify(data) }); }
  close(code = 1000) { this.readyState = 3; this.emit('close', { code }); }
}
class FakeTimers {
  constructor() { this.next = 1; this.jobs = new Map(); }
  setTimeout = (callback, wait) => { const id = this.next++; this.jobs.set(id, { callback, wait }); return id; };
  clearTimeout = (id) => { this.jobs.delete(id); };
  runShortest() { const [id, job] = [...this.jobs].sort((a, b) => a[1].wait - b[1].wait)[0] ?? []; if (!job) throw new Error('No timer'); this.jobs.delete(id); job.callback(); }
}
function createGateway(options = {}, suppliedAccount = account) {
  FakeSocket.instances = [];
  const timers = new FakeTimers();
  const warnings = [];
  const gateway = new DiscordGateway(suppliedAccount, { WebSocketImpl: FakeSocket, timers, random: () => 0, logger: { warn: (value) => warnings.push(value) },
    fetchImpl: async () => json({ url: 'wss://gateway.discord.gg', shards: 1, session_start_limit: { remaining: 20 } }), onMessage: async () => {}, ...options });
  return { gateway, timers, warnings };
}
async function ready(gateway) {
  await gateway.start(); const socket = FakeSocket.instances.at(-1);
  socket.payload({ op: 10, d: { heartbeat_interval: 1000 } });
  socket.payload({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-one', resume_gateway_url: 'wss://gateway-us-east1-a.discord.gg', user: { id: '100' } } });
  await flush(); return socket;
}

test('gateway identifies with configured intents, sends heartbeats and checks ACK watchdog', async () => {
  const { gateway, timers, warnings } = createGateway({}, { ...account, intents: { guildMembers: true } });
  const socket = await ready(gateway);
  assert.equal(socket.url, 'wss://gateway.discord.gg/?v=10&encoding=json');
  assert.equal(socket.sent[0].op, 2); assert.equal(socket.sent[0].d.intents, 1 | 2 | (1 << 9) | (1 << 12) | (1 << 15));
  assert.equal(gateway.status().ready, true);
  timers.runShortest(); assert.deepEqual(socket.sent.at(-1), { op: 1, d: 1 });
  socket.payload({ op: 11 }); timers.runShortest(); assert.equal(gateway.status().connected, true);
  timers.runShortest(); assert.equal(gateway.status().connected, false); assert.equal(warnings.length, 1);
  await gateway.close(); assert.equal(timers.jobs.size, 0);
});

test('server heartbeat requests are answered immediately', async () => {
  const { gateway } = createGateway(); const socket = await ready(gateway);
  socket.payload({ op: 1 }); assert.deepEqual(socket.sent.at(-1), { op: 1, d: 1 });
  await gateway.close();
});

test('gateway commits only durable ordered ingress and supplies thread and member metadata', async () => {
  let resolveIngress;
  const received = [];
  const { gateway } = createGateway({ onMessage: async (value) => { received.push(value); await new Promise((resolve) => { resolveIngress = resolve; }); } });
  const socket = await ready(gateway);
  socket.payload({ op: 0, t: 'GUILD_CREATE', s: 2, d: { id: '400', channels: [], threads: [{ id: '200', type: 11, parent_id: '201' }] } });
  socket.payload({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: { ...message, guild_id: '400', member: { roles: ['500'] } } });
  socket.payload({ op: 0, t: 'MESSAGE_CREATE', s: 4, d: { ...message, id: '901' } });
  await flush();
  assert.equal(received.length, 1); assert.equal(gateway.status().receivedSequence, 4); assert.equal(gateway.status().committedSequence, 2);
  assert.equal(received[0].channelType, 11); assert.equal(received[0].parentId, '201'); assert.deepEqual(received[0].member.roles, ['500']);
  resolveIngress(); await flush(); assert.equal(received.length, 2); assert.equal(gateway.status().committedSequence, 3);
  resolveIngress(); await flush(); assert.equal(gateway.status().committedSequence, 4);
  await gateway.close();
});

test('gateway supplies guild and thread-parent names from ordered metadata events', async () => {
  const received = [];
  const { gateway } = createGateway({ onMessage: async (value) => received.push(value) });
  const socket = await ready(gateway);
  socket.payload({ op: 0, t: 'GUILD_CREATE', s: 2, d: { id: '400', name: 'Assistant Workspace',
    channels: [{ id: '201', type: 0, name: 'secretary-requests' }], threads: [{ id: '200', type: 11, parent_id: '201', name: 'Plan' }] } });
  socket.payload({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: { ...message, guild_id: '400' } });
  socket.payload({ op: 0, t: 'GUILD_UPDATE', s: 4, d: { id: '400', name: 'Renamed Workspace' } });
  socket.payload({ op: 0, t: 'CHANNEL_UPDATE', s: 5, d: { id: '201', name: 'updated-requests' } });
  socket.payload({ op: 0, t: 'THREAD_CREATE', s: 6, d: { id: '202', type: 12, parent_id: '201', guild_id: '400', name: 'Private Plan' } });
  socket.payload({ op: 0, t: 'MESSAGE_CREATE', s: 7, d: { ...message, id: '901', channel_id: '202', guild_id: '400' } });
  await flush();
  assert.deepEqual(received[0].guild, { id: '400', name: 'Assistant Workspace' });
  assert.deepEqual(received[0].channel.parent, { id: '201', name: 'secretary-requests', type: 0 });
  assert.deepEqual(received[1].guild, { id: '400', name: 'Renamed Workspace' });
  assert.deepEqual(received[1].channel.parent, { id: '201', name: 'updated-requests', type: 0 });
  assert.equal(received[1].channel.name, 'Private Plan');
  await gateway.close();
});

test('unknown guild and parent names remain absent and deleted guild metadata is removed', async () => {
  const received = [];
  const { gateway } = createGateway({ onMessage: async (value) => received.push(value) });
  const socket = await ready(gateway);
  socket.payload({ op: 0, t: 'THREAD_CREATE', s: 2, d: { id: '200', type: 11, parent_id: '201', guild_id: '400' } });
  socket.payload({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: { ...message, guild_id: '400' } });
  socket.payload({ op: 0, t: 'GUILD_CREATE', s: 4, d: { id: '400', name: 'Workspace', channels: [{ id: '201', type: 0, name: 'requests' }], threads: [{ id: '200', type: 11, parent_id: '201' }] } });
  socket.payload({ op: 0, t: 'GUILD_DELETE', s: 5, d: { id: '400' } });
  socket.payload({ op: 0, t: 'MESSAGE_CREATE', s: 6, d: { ...message, guild_id: '400' } });
  await flush();
  assert.equal(received[0].guild, undefined); assert.equal(received[0].channel.parent, undefined);
  assert.equal(received[1].guild, undefined); assert.equal(received[1].channel, undefined);
  await gateway.close();
});

test('failed persistence resumes from committed sequence and replays the unaccepted message', async () => {
  let calls = 0;
  const { gateway, timers, warnings } = createGateway({ onMessage: async () => { if (++calls === 1) throw new Error(TOKEN); } });
  const socket = await ready(gateway);
  socket.payload({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: message }); await flush();
  assert.equal(gateway.status().committedSequence, 1); assert.equal(gateway.status().connected, false);
  assert(!warnings.join('').includes(TOKEN));
  timers.runShortest(); await flush(); const resumed = FakeSocket.instances.at(-1);
  assert.match(resumed.url, /^wss:\/\/gateway-us-east1-a.discord.gg/);
  resumed.payload({ op: 10, d: { heartbeat_interval: 1000 } });
  assert.deepEqual(resumed.sent[0], { op: 6, d: { token: TOKEN, session_id: 'session-one', seq: 1 } });
  resumed.payload({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: message });
  resumed.payload({ op: 0, t: 'RESUMED', s: 3, d: {} }); await flush();
  assert.equal(calls, 2); assert.equal(gateway.status().committedSequence, 3); assert.equal(gateway.status().ready, true);
  await gateway.close();
});

test('reconnect drains accepted pending ingress before choosing the resume sequence', async () => {
  let commit;
  const { gateway, timers } = createGateway({ onMessage: () => new Promise((resolve) => { commit = resolve; }) });
  const socket = await ready(gateway);
  socket.payload({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: message }); await flush();
  socket.payload({ op: 7 }); timers.runShortest(); await flush();
  assert.equal(FakeSocket.instances.length, 1);
  commit(); await flush(); const resumed = FakeSocket.instances.at(-1);
  resumed.payload({ op: 10, d: { heartbeat_interval: 1000 } });
  assert.equal(resumed.sent[0].d.seq, 2); await gateway.close();
});

test('nonresumable invalid sessions re-identify after the required delay', async () => {
  const { gateway, timers } = createGateway(); const socket = await ready(gateway);
  socket.payload({ op: 9, d: false }); await flush();
  assert.equal(gateway.status().committedSequence, null);
  timers.runShortest(); await flush(); const next = FakeSocket.instances.at(-1);
  next.payload({ op: 10, d: { heartbeat_interval: 1000 } }); assert.equal(next.sent[0].op, 2);
  await gateway.close();
});

test('authentication and privileged-intent failures stop rather than reconnecting in a loop', async () => {
  for (const code of [4004, 4014]) {
    const { gateway, timers } = createGateway(); const socket = await ready(gateway); socket.close(code); await flush();
    assert.equal(gateway.status().fatalCode, code); assert.equal(gateway.status().running, false); assert.equal(timers.jobs.size, 0);
    await gateway.close();
  }
});

test('gateway discovery rejects untrusted hosts, insecure URLs, sharded bots and exhausted sessions', async () => {
  for (const discovery of [{ url: 'ws://gateway.discord.gg' }, { url: 'wss://evil.com' }, { url: 'wss://gateway.discord.gg.evil.com' }, { url: 'wss://gateway.discord.gg', shards: 2 }, { url: 'wss://gateway.discord.gg', session_start_limit: { remaining: 0, reset_after: 1234 } }]) {
    const { gateway } = createGateway({ fetchImpl: async () => json(discovery) });
    await assert.rejects(gateway.start(), DiscordError); assert.equal(gateway.status().running, false); await gateway.close();
  }
});

test('interaction dispatch is delivered to the handler and advances the durable sequence', async () => {
  const interactions = [];
  const { gateway } = createGateway({ onInteraction: async (value) => interactions.push(value) }); const socket = await ready(gateway);
  socket.payload({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: { id: '123', token: 'interaction-token', type: 2, data: { name: 'help' } } }); await flush();
  assert.equal(interactions[0].botUserId, '100'); assert.equal(interactions[0].data.name, 'help'); assert.equal(gateway.status().committedSequence, 2);
  await gateway.close();
});

test('interaction ACK handling starts immediately but commits after earlier durable message ingress', async () => {
  let commitMessage;
  const acknowledgements = [], interactions = [];
  const { gateway } = createGateway({ onMessage: () => new Promise((resolve) => { commitMessage = resolve; }),
    onInteractionReceived: async (value) => { acknowledgements.push(value); },
    onInteraction: async (value) => { interactions.push(value); } });
  const socket = await ready(gateway);
  socket.payload({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: message });
  socket.payload({ op: 0, t: 'INTERACTION_CREATE', s: 3, d: { id: '123', token: 'interaction-token', type: 2, data: { name: 'help' } } });
  await flush();
  assert.equal(acknowledgements.length, 1);
  assert.equal(interactions.length, 0);
  assert.equal(gateway.status().receivedSequence, 3);
  assert.equal(gateway.status().committedSequence, 1);
  commitMessage(); await flush();
  assert.equal(interactions.length, 1);
  assert.equal(gateway.status().committedSequence, 3);
  await gateway.close();
});

test('a fast interaction failure never commits ahead of pending message ingress', async () => {
  let commitMessage;
  const { gateway } = createGateway({ onMessage: () => new Promise((resolve) => { commitMessage = resolve; }),
    onInteractionReceived: async () => { throw new Error('Acknowledgement failed'); }, onInteraction: async () => { assert.fail('Failed ACK cannot reach durable handler'); } });
  const socket = await ready(gateway);
  socket.payload({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: message });
  socket.payload({ op: 0, t: 'INTERACTION_CREATE', s: 3, d: { id: '123', type: 2 } });
  await flush();
  assert.equal(gateway.status().committedSequence, 1);
  commitMessage(); await flush();
  assert.equal(gateway.status().committedSequence, 2);
  assert.equal(gateway.status().connected, false);
  await gateway.close();
});
