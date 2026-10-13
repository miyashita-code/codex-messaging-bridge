import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DotMcp, isPublicAddress, validateCallbackUrl } from '../src/mcp.mjs';

const message = {
  id: 'message-1', accountId: 'secretary', conversationId: 'Ualice', userId: 'Ualice',
  type: 'text', text: '明日の予定を確認して', timestamp: 1791878400000,
  replyToken: 'DO_NOT_DISCLOSE', raw: { secret: 'DO_NOT_DISCLOSE' },
};
const secret = `whsec_${randomBytes(32).toString('base64')}`;
const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
function subscriptionParams(overrides = {}) {
  return { name: 'line.message.created', arguments: { account_id: 'secretary', conversation_id: 'Ualice' }, delivery: { mode: 'webhook', url: 'https://events.example.com/callback', secret }, ...overrides };
}
function fixture(t, { path = ':memory:', fetcher, bridge: extraBridge = {}, config: extraConfig = {}, channel = 'line' } = {}) {
  const db = new DatabaseSync(path); const requests = []; const sent = [];
  let allowed = true;
  const bridge = {
    listConversations: () => [{ accountId: 'secretary', conversationId: 'Ualice', userId: 'Ualice', type: 'user' }],
    listInbox: () => [message],
    readMessage: (id) => id === message.id ? message : undefined,
    readMedia: () => [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
    isConversationAllowed: (account, conversation, user) => allowed && account === 'secretary' && conversation === 'Ualice' && (!user || user === 'Ualice'),
    sendReply: async (args) => { sent.push(args); return { sent: true }; },
    ...extraBridge,
  };
  const webhookFetch = async (url, options) => {
    requests.push({ url, options });
    if (fetcher) return await fetcher(url, options);
    const payload = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ challenge: payload.challenge }) };
  };
  const mcp = new DotMcp({ store: { db }, bridge, config: { mcp: { token: 'private-owner-token', subscriptionTtlMs: 24 * 60 * 60 * 1000, ...extraConfig } }, webhookFetch, channel });
  t.after(async () => { await mcp.close(); db.close(); });
  return { mcp, db, requests, sent, deny: () => { allowed = false; }, bridge };
}

test('discovery supports MCP 2.0 events and legacy initialize with scoped tools', async (t) => {
  const { mcp } = fixture(t);
  const discovery = await mcp.dispatch(rpc('server/discover'), 'owner');
  assert.deepEqual(discovery.result.supportedVersions, ['2026-07-28']);
  assert.equal(discovery.result.resultType, 'complete');
  assert.deepEqual(discovery.result.capabilities.events, {});
  assert.equal((await mcp.dispatch(rpc('initialize', { protocolVersion: '2025-06-18' }), 'owner')).result.protocolVersion, '2025-06-18');
  const tools = (await mcp.dispatch(rpc('tools/list'), 'owner')).result.tools;
  assert.equal(tools.find((row) => row.name === 'line_reply').annotations.readOnlyHint, false);
  assert.equal(tools.find((row) => row.name === 'line_reply').annotations.idempotentHint, true);
  assert.equal(tools.find((row) => row.name === 'line_read_message').annotations.readOnlyHint, true);
  assert.equal((await mcp.dispatch(rpc('events/list'), 'owner')).result.events[0].delivery[0], 'webhook');
  assert.equal((await mcp.dispatch(rpc('tools/list'), 'intruder')).error.code, -32001);
  assert.equal((await mcp.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'owner')), undefined);
  assert.equal((await mcp.dispatch({ jsonrpc: '2.0', id: {}, method: 'tools/list' }, 'owner')).error.code, -32600);
});

test('callback validation blocks SSRF destinations, credentials, redirects targets and unsafe ports', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '169.254.169.254', '100.100.100.100', '192.168.1.1', '198.18.0.2', '192.0.2.1', '203.0.113.2', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::1', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
  for (const url of ['http://events.example.com/', 'https://localhost/', 'https://169.254.169.254/', 'https://127.1/', 'https://[::1]/', 'https://user:secret@events.example.com/', 'https://events.example.com:8443/', 'https://events.example.com/#fragment', 'https://events.example.com./']) assert.throws(() => validateCallbackUrl(url), undefined, url);
  assert.equal(validateCallbackUrl('https://events.example.com/callback', ['*.example.com']).hostname, 'events.example.com');
  assert.throws(() => validateCallbackUrl('https://attackerexample.com/callback', ['*.example.com']));
  assert.throws(() => validateCallbackUrl('https://example.com/callback', ['*.example.com']));
  assert.throws(() => validateCallbackUrl('https://events.example.com/callback', ['api.openai.com']));
});

test('subscription challenge validates ownership and Standard Webhooks signature', async (t) => {
  const { mcp, db, requests } = fixture(t);
  const response = await mcp.dispatch(rpc('events/subscribe', subscriptionParams()), 'owner');
  assert.ok(response.result.id.startsWith('sub_'));
  assert.equal(response.result.cursor, null);
  const verification = requests[0]; const headers = verification.options.headers;
  const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${verification.options.body}`).digest('base64');
  assert.equal(headers['webhook-signature'], `v1,${expected}`);
  assert.equal(headers['X-MCP-Subscription-Id'], response.result.id);
  assert.equal(verification.options.redirect, 'error');
  assert.equal(JSON.parse(verification.options.body).type, 'verification');
  const again = await mcp.dispatch(rpc('events/subscribe', subscriptionParams({ arguments: { conversation_id: 'Ualice', account_id: 'secretary' } })), 'owner');
  assert.equal(again.result.id, response.result.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dot_subscriptions').get().n, 1);
  assert.equal(requests.length, 1);
  const denied = await mcp.dispatch(rpc('events/subscribe', subscriptionParams({ arguments: { account_id: 'secretary', conversation_id: 'Uother' } })), 'owner');
  assert.equal(denied.error.code, -32003);
});

test('invalid signing keys and unverified callbacks never activate a subscription', async (t) => {
  const { mcp, db } = fixture(t, { fetcher: async () => ({ ok: true, status: 200, json: async () => ({ challenge: 'wrong' }) }) });
  const verification = await mcp.dispatch(rpc('events/subscribe', subscriptionParams()), 'owner');
  assert.equal(verification.error.code, -32015);
  assert.equal(verification.error.data.reason, 'challenge_failed');
  for (const bad of ['whsec_short', `whsec_${randomBytes(10).toString('base64')}`, 'raw-secret']) {
    const response = await mcp.dispatch(rpc('events/subscribe', subscriptionParams({ delivery: { mode: 'webhook', url: 'https://events.example.com/', secret: bad } })), 'owner');
    assert.equal(response.error.code, -32602);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dot_subscriptions').get().n, 0);
});

test('events are durable, deduplicated and scoped without exposing credentials', async (t) => {
  const { mcp, db, requests } = fixture(t);
  await mcp.publish(message);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dot_deliveries').get().n, 0, 'no replay before subscription');
  await mcp.dispatch(rpc('events/subscribe', subscriptionParams()), 'owner');
  assert.deepEqual(await mcp.publish(message), { queued: 1 });
  assert.deepEqual(await mcp.publish(message), { queued: 0 });
  assert.deepEqual(await mcp.publish({ ...message, id: 'other', conversationId: 'Uother' }), { queued: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dot_deliveries').get().n, 1);
  await mcp.drain();
  const event = JSON.parse(requests[1].options.body);
  assert.equal(event.name, 'line.message.created');
  assert.equal(event.data.message_id, message.id);
  assert.equal(event.cursor, null);
  assert.equal(event.timestamp, new Date(message.timestamp).toISOString());
  assert.equal(requests[1].options.body.includes('DO_NOT_DISCLOSE'), false);
  assert.equal(db.prepare('SELECT status FROM dot_deliveries').get().status, 'delivered');
});

test('transient failures retry with stable IDs, while 410 and 413 are terminal', async (t) => {
  let status = 503;
  const { mcp, db, requests } = fixture(t, { fetcher: async (_url, options) => {
    const value = JSON.parse(options.body);
    return value.type === 'verification' ? { ok: true, status: 200, json: async () => ({ challenge: value.challenge }) } : { ok: status === 200, status };
  } });
  await mcp.dispatch(rpc('events/subscribe', subscriptionParams()), 'owner');
  await mcp.publish(message); await mcp.drain();
  assert.equal(db.prepare('SELECT status FROM dot_deliveries').get().status, 'pending');
  status = 200;
  db.prepare('UPDATE dot_deliveries SET next_attempt=0').run(); await mcp.drain();
  assert.equal(JSON.parse(requests[1].options.body).eventId, JSON.parse(requests[2].options.body).eventId);
  assert.equal(requests[1].options.body, requests[2].options.body);
  for (const terminal of [413, 410]) {
    status = terminal;
    await mcp.publish({ ...message, id: `terminal-${terminal}` }); await mcp.drain();
    const row = db.prepare('SELECT status, attempts FROM dot_deliveries WHERE message_json LIKE ?').get(`%terminal-${terminal}%`);
    assert.equal(row.status, 'failed'); assert.equal(row.attempts, 1);
  }
  assert.equal(db.prepare('SELECT active FROM dot_subscriptions').get().active, 0);
});

test('access revocation, unsubscribe and expiry prevent queued delivery', async (t) => {
  const { mcp, db, requests, deny } = fixture(t);
  const params = subscriptionParams();
  await mcp.dispatch(rpc('events/subscribe', params), 'owner'); await mcp.publish(message);
  deny(); await mcp.drain();
  assert.equal(requests.length, 1);
  assert.equal(db.prepare('SELECT last_reason FROM dot_deliveries').get().last_reason, 'access_revoked');
  const unsub = { name: params.name, arguments: params.arguments, delivery: { mode: 'webhook', url: params.delivery.url } };
  assert.deepEqual((await mcp.dispatch(rpc('events/unsubscribe', unsub), 'owner')).result, {});
  assert.equal(db.prepare('SELECT active FROM dot_subscriptions').get().active, 0);
});

test('subscription TTL is bounded and replay requests are rejected', async (t) => {
  const { mcp, db, requests } = fixture(t, { config: { subscriptionTtlMs: 120000 } });
  const start = Date.now();
  const result = await mcp.dispatch(rpc('events/subscribe', subscriptionParams({ ttlMs: null })), 'owner');
  assert.ok(new Date(result.result.refreshBefore).getTime() <= Date.now() + 120000);
  assert.ok(new Date(result.result.refreshBefore).getTime() >= start + 120000);
  await mcp.publish(message);
  db.prepare('UPDATE dot_subscriptions SET expires_at=0').run(); await mcp.drain();
  assert.equal(requests.length, 1);
  assert.equal(db.prepare('SELECT status FROM dot_deliveries').get().status, 'cancelled');
  assert.equal((await mcp.dispatch(rpc('events/subscribe', subscriptionParams({ cursor: 'old-event' })), 'owner')).error.code, -32602);
});

test('revoking owner access cancels subscriptions and pending deliveries', async (t) => {
  const { mcp, db, requests } = fixture(t);
  await mcp.dispatch(rpc('events/subscribe', subscriptionParams()), 'owner'); await mcp.publish(message);
  assert.deepEqual(mcp.revokeSubscriptions('owner'), { revoked: 1 });
  await mcp.drain();
  assert.equal(requests.length, 1);
  assert.equal(db.prepare('SELECT active FROM dot_subscriptions').get().active, 0);
  assert.equal(db.prepare('SELECT last_reason FROM dot_deliveries').get().last_reason, 'owner_access_revoked');
});

test('renewing an expired subscription does not replay its expired pending delivery', async (t) => {
  const { mcp, db, requests } = fixture(t);
  await mcp.dispatch(rpc('events/subscribe', subscriptionParams()), 'owner'); await mcp.publish(message);
  db.prepare('UPDATE dot_subscriptions SET expires_at=0').run();
  await mcp.dispatch(rpc('events/subscribe', subscriptionParams()), 'owner'); await mcp.drain();
  assert.equal(requests.length, 2, 'only initial and renewal challenges');
  assert.equal(db.prepare('SELECT status FROM dot_deliveries').get().status, 'cancelled');
});

test('event delivery gives up after eight transient attempts', async (t) => {
  const { mcp, db } = fixture(t, { fetcher: async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.type === 'verification') return { ok: true, status: 200, json: async () => ({ challenge: payload.challenge }) };
    throw new Error('temporary network failure');
  } });
  await mcp.dispatch(rpc('events/subscribe', subscriptionParams()), 'owner'); await mcp.publish(message);
  for (let index = 0; index < 8; index++) { db.prepare('UPDATE dot_deliveries SET next_attempt=0').run(); await mcp.drain(); }
  assert.deepEqual({ ...db.prepare('SELECT status,attempts FROM dot_deliveries').get() }, { status: 'failed', attempts: 8 });
});

test('secret rotation verifies the new callback key and signs pending events with both keys briefly', async (t) => {
  const { mcp, requests } = fixture(t);
  const old = await mcp.dispatch(rpc('events/subscribe', subscriptionParams()), 'owner');
  const replacement = `whsec_${randomBytes(32).toString('base64')}`;
  const refreshed = await mcp.dispatch(rpc('events/subscribe', subscriptionParams({ delivery: { mode: 'webhook', url: 'https://events.example.com/callback', secret: replacement } })), 'owner');
  assert.equal(refreshed.result.id, old.result.id);
  assert.equal(requests.length, 2);
  await mcp.publish(message); await mcp.drain();
  assert.equal(requests[2].options.headers['webhook-signature'].split(' ').length, 2);
});

test('read and reply tools enforce admitted destinations and stable idempotency keys', async (t) => {
  const { mcp, sent, deny } = fixture(t);
  const read = await mcp.dispatch(rpc('tools/call', { name: 'line_read_message', arguments: { message_id: message.id } }), 'owner');
  assert.equal(JSON.stringify(read).includes('DO_NOT_DISCLOSE'), false);
  const reply = await mcp.dispatch(rpc('tools/call', { name: 'line_reply', arguments: { message_id: message.id, text: '確認します', idempotency_key: 'reply-message-1' } }), 'owner');
  assert.equal(reply.result.structuredContent.delivery.sent, true);
  assert.deepEqual(sent[0], { messageId: message.id, text: '確認します', idempotencyKey: 'reply-message-1' });
  for (const args of [
    { message_id: message.id, text: 'bad' },
    { message_id: 'unknown', text: 'bad', idempotency_key: 'a' },
    { message_id: message.id, text: 'bad', messages: [{ type: 'text', text: 'bad' }], idempotency_key: 'a' },
    { message_id: message.id, text: 'bad', idempotency_key: 'a', to: 'Uother' },
  ]) assert.ok((await mcp.dispatch(rpc('tools/call', { name: 'line_reply', arguments: args }), 'owner')).error);
  const media = await mcp.dispatch(rpc('tools/call', { name: 'line_read_media', arguments: { message_id: message.id } }), 'owner');
  assert.equal(media.result.content[0].type, 'image');
  deny();
  const revoked = await mcp.dispatch(rpc('tools/call', { name: 'line_read_message', arguments: { message_id: message.id } }), 'owner');
  assert.equal(revoked.error.code, -32003);
  assert.equal(sent.length, 1);
});

test('pending delivery survives database restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'line-dot-test-')); const path = join(directory, 'bridge.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let db = new DatabaseSync(path);
  const bridge = { listConversations: () => [{ accountId: message.accountId, conversationId: message.conversationId, userId: message.userId }], isConversationAllowed: () => true };
  const config = { mcp: { token: 'test', subscriptionTtlMs: 120000 } };
  const requests = [];
  const webhookFetch = async (_url, options) => { const payload = JSON.parse(options.body); requests.push(payload); return { ok: true, status: 200, json: async () => ({ challenge: payload.challenge }) }; };
  let mcp = new DotMcp({ store: { db }, bridge, config, webhookFetch });
  await mcp.dispatch(rpc('events/subscribe', subscriptionParams()), 'owner'); await mcp.publish(message);
  await mcp.close(); db.close();
  db = new DatabaseSync(path); mcp = new DotMcp({ store: { db }, bridge, config, webhookFetch });
  try {
    await mcp.drain();
    assert.equal(requests[1].data.message_id, message.id);
    assert.equal(db.prepare('SELECT status FROM dot_deliveries').get().status, 'delivered');
  } finally { await mcp.close(); db.close(); }
});

test('Discord tools preserve admitted destinations while accepting native Discord replies', async (t) => {
  const discordMessage = { ...message, channel: 'discord', guildId: 'guild-1', threadParentId: 'parent-1' };
  const { mcp, sent } = fixture(t, { channel: 'discord', bridge: { readMessage: () => discordMessage, listInbox: () => [discordMessage] } });
  const discovery = (await mcp.dispatch(rpc('server/discover'), 'owner')).result;
  assert.equal(discovery.serverInfo.name, 'codex-discord-bridge');
  assert.equal(discovery.instructions.includes('LINE'), false);
  const tools = (await mcp.dispatch(rpc('tools/list'), 'owner')).result.tools;
  assert.equal(tools.length, 5);
  for (const tool of tools) {
    assert.ok(tool.name.startsWith('discord_'));
    assert.equal(tool.description.includes('LINE'), false);
    assert.ok(tool.securitySchemes[0].scopes.every((scope) => scope.startsWith('discord:')));
  }
  const replyTool = tools.find((tool) => tool.name === 'discord_reply');
  assert.deepEqual(replyTool.securitySchemes[0].scopes, ['discord:read', 'discord:write']);
  assert.equal(replyTool.inputSchema.properties.messages.maxItems, 50);
  assert.equal(replyTool.inputSchema.properties.text.maxLength, 100000);
  assert.equal(replyTool.inputSchema.properties.messages.items.properties.type, undefined);
  const event = (await mcp.dispatch(rpc('events/list'), 'owner')).result.events[0];
  assert.equal(event.name, 'discord.message.created');
  assert.match(event.inputSchema.properties.conversation_id.description, /guild channel or thread/u);
  const read = (await mcp.dispatch(rpc('tools/call', { name: 'discord_read_message', arguments: { message_id: message.id } }), 'owner')).result;
  assert.equal(read.structuredContent.message.guildId, 'guild-1');
  assert.equal(read.structuredContent.message.threadParentId, 'parent-1');
  assert.equal(JSON.stringify(read).includes('DO_NOT_DISCLOSE'), false);
  const messages = [{ content: '確認します', embeds: [{ description: '明日の予定' }] }];
  const reply = await mcp.dispatch(rpc('tools/call', { name: 'discord_reply', arguments: { message_id: message.id, messages, idempotency_key: 'discord-native' } }), 'owner');
  assert.equal(reply.result.structuredContent.delivery.sent, true);
  assert.deepEqual(sent[0], { messageId: message.id, messages, idempotencyKey: 'discord-native' });
  assert.equal((await mcp.dispatch(rpc('tools/call', { name: 'line_read_message', arguments: { message_id: message.id } }), 'owner')).error.code, -32602);
  assert.equal((await mcp.dispatch(rpc('events/subscribe', subscriptionParams()), 'owner')).error.code, -32602);
  for (const args of [
    { message_id: message.id, text: 'x'.repeat(100001), idempotency_key: 'too-long' },
    { message_id: message.id, messages: Array.from({ length: 51 }, () => ({ content: 'x' })), idempotency_key: 'too-many' },
    { message_id: message.id, messages: ['x'], idempotency_key: 'malformed' },
  ]) assert.equal((await mcp.dispatch(rpc('tools/call', { name: 'discord_reply', arguments: args }), 'owner')).error.code, -32602);
  assert.equal(sent.length, 1);
});
