import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DotMcp } from '../src/mcp.mjs';
import { MultiMcp } from '../src/multi-mcp.mjs';

const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const secret = `whsec_${randomBytes(32).toString('base64')}`;
// Intentionally collide IDs across providers: no worker or read tool may infer
// the channel from an account or conversation identifier alone.
const baseMessage = { id: 'same-message-id', accountId: 'secretary', conversationId: 'same-conversation-id', userId: 'alice', type: 'text', text: '予定を調べて', timestamp: 1791878400000 };
function subscription(channel, overrides = {}) {
  return { name: `${channel}.message.created`, arguments: { account_id: baseMessage.accountId, conversation_id: baseMessage.conversationId }, delivery: { mode: 'webhook', url: 'https://events.example.com/callback', secret }, ...overrides };
}
function fixture(t, { fetchers = {} } = {}) {
  const db = new DatabaseSync(':memory:');
  const requests = { line: [], discord: [] }; const sent = { line: [], discord: [] };
  const allowed = { line: true, discord: true };
  const messages = Object.fromEntries(['line', 'discord'].map((channel) => [channel, { ...baseMessage, channel, text: `${channel} private message`, raw: { secret: 'DO_NOT_DISCLOSE' }, botToken: 'DO_NOT_DISCLOSE' }]));
  const mcps = {}; const bridges = {};
  for (const channel of ['line', 'discord']) {
    const bridge = {
      listConversations: () => [{ ...messages[channel], type: channel === 'line' ? 'user' : 'dm' }],
      listInbox: () => [messages[channel]],
      readMessage: (id) => id === baseMessage.id ? messages[channel] : undefined,
      readMedia: () => [{ type: 'resource', resource: { uri: `${channel}://message/media`, mimeType: 'text/plain', text: `${channel} attachment` } }],
      isConversationAllowed: (account, conversation, user) => allowed[channel] && account === baseMessage.accountId && conversation === baseMessage.conversationId && (!user || user === baseMessage.userId),
      sendReply: async (args) => { sent[channel].push(args); return { sent: true, channel }; },
    };
    bridges[channel] = bridge;
    mcps[channel] = new DotMcp({ channel, store: { db }, bridge, config: { mcp: { subscriptionTtlMs: 120000 } }, webhookFetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests[channel].push({ url, body, options });
      if (fetchers[channel]) return await fetchers[channel](url, options);
      return { ok: true, status: 200, json: async () => ({ challenge: body.challenge }) };
    } });
  }
  const mcp = new MultiMcp(mcps);
  t.after(async () => { await mcp.close(); db.close(); });
  return { db, mcp, ...mcps, bridges, messages, requests, sent, allowed };
}

test('one MCP endpoint discovers distinct LINE and Discord tools and events', async (t) => {
  const { mcp } = fixture(t);
  const discovery = (await mcp.dispatch(rpc('server/discover'), 'owner')).result;
  assert.equal(discovery.serverInfo.name, 'codex-secretary-bridge');
  assert.deepEqual(discovery.supportedVersions, ['2026-07-28']);
  assert.match(discovery.instructions, /LINE/u); assert.match(discovery.instructions, /Discord/u);
  const initialize = (await mcp.dispatch(rpc('initialize', { protocolVersion: '2025-06-18' }), 'owner')).result;
  assert.equal(initialize.protocolVersion, '2025-06-18');
  const tools = (await mcp.dispatch(rpc('tools/list'), 'owner')).result.tools;
  assert.equal(tools.length, 10);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, 10);
  const events = (await mcp.dispatch(rpc('events/list'), 'owner')).result.events;
  assert.deepEqual(events.map((event) => event.name), ['line.message.created', 'discord.message.created']);
});

test('tool routing does not disclose a colliding provider message or send to its conversation', async (t) => {
  const { mcp, line, bridges, messages, sent } = fixture(t);
  const lineRead = await mcp.dispatch(rpc('tools/call', { name: 'line_read_message', arguments: { message_id: baseMessage.id } }), 'owner');
  const discordRead = await mcp.dispatch(rpc('tools/call', { name: 'discord_read_message', arguments: { message_id: baseMessage.id } }), 'owner');
  assert.equal(lineRead.result.structuredContent.message.text, 'line private message');
  assert.equal(discordRead.result.structuredContent.message.text, 'discord private message');
  assert.equal(JSON.stringify(lineRead).includes('DO_NOT_DISCLOSE'), false);
  assert.equal(JSON.stringify(discordRead).includes('DO_NOT_DISCLOSE'), false);
  for (const channel of ['line', 'discord']) {
    const response = await mcp.dispatch(rpc('tools/call', { name: `${channel}_reply`, arguments: { message_id: baseMessage.id, text: '確認します', idempotency_key: 'same-key' } }), 'owner');
    assert.equal(response.result.structuredContent.delivery.channel, channel);
  }
  assert.equal(sent.line.length, 1); assert.equal(sent.discord.length, 1);
  bridges.line.readMessage = () => messages.discord;
  assert.equal((await mcp.dispatch(rpc('tools/call', { name: 'line_read_message', arguments: { message_id: baseMessage.id } }), 'owner')).error.code, -32003);
  assert.equal((await line.dispatch(rpc('tools/call', { name: 'discord_read_message', arguments: { message_id: baseMessage.id } }), 'owner')).error.code, -32602);
  bridges.line.listInbox = () => [messages.line, messages.discord];
  const inbox = (await mcp.dispatch(rpc('tools/call', { name: 'line_list_inbox' }), 'owner')).result.structuredContent.messages;
  assert.deepEqual(inbox.map((message) => message.channel), ['line']);
  bridges.line.listConversations = () => [messages.line, messages.discord];
  const conversations = (await mcp.dispatch(rpc('tools/call', { name: 'line_list_conversations' }), 'owner')).result.structuredContent.conversations;
  assert.deepEqual(conversations.map((conversation) => conversation.channel), ['line']);
});

test('shared database workers only publish and drain their own event namespace', async (t) => {
  const { mcp, line, discord, db, messages, requests } = fixture(t);
  const lineSubscription = (await mcp.dispatch(rpc('events/subscribe', subscription('line')), 'owner')).result;
  const discordSubscription = (await mcp.dispatch(rpc('events/subscribe', subscription('discord')), 'owner')).result;
  assert.notEqual(lineSubscription.id, discordSubscription.id);
  assert.deepEqual(await line.publish(messages.line), { queued: 1 });
  assert.deepEqual(await discord.publish(messages.discord), { queued: 1 });
  assert.deepEqual(await line.publish(messages.discord), { queued: 0 });
  assert.deepEqual(await discord.publish(messages.line), { queued: 0 });
  assert.deepEqual(await line.publish(messages.line), { queued: 0 });
  assert.deepEqual(await line.drain(), { delivered: 1 });
  assert.equal(requests.line[1].body.name, 'line.message.created');
  assert.equal(requests.discord.length, 1, 'Discord has only its verification request');
  assert.equal(db.prepare('SELECT status FROM dot_deliveries WHERE subscription_id=?').get(discordSubscription.id).status, 'pending');
  assert.deepEqual(await discord.drain(), { delivered: 1 });
  assert.equal(requests.discord[1].body.name, 'discord.message.created');
  assert.notEqual(requests.line[1].body.eventId, requests.discord[1].body.eventId);
  assert.match(requests.line[1].body.eventId, /^evt_line_/u);
  assert.match(requests.discord[1].body.eventId, /^evt_discord_/u);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dot_deliveries WHERE status='delivered'").get().n, 2);
});

test('subscription limit is channel scoped when two providers share one store', async (t) => {
  const { mcp, db } = fixture(t);
  const lineSubscription = (await mcp.dispatch(rpc('events/subscribe', subscription('line')), 'owner')).result;
  const insert = db.prepare(`INSERT INTO dot_subscriptions(id,principal,event_name,arguments_json,callback_url,secret,expires_at,verified_at,active,created_at)
    SELECT ?,principal,event_name,arguments_json,callback_url,secret,expires_at,verified_at,active,created_at FROM dot_subscriptions WHERE id=?`);
  for (let index = 1; index < 100; index++) insert.run(`line-limit-${index}`, lineSubscription.id);
  const anotherLine = await mcp.dispatch(rpc('events/subscribe', subscription('line', { arguments: { ...subscription('line').arguments, user_id: 'alice' } })), 'owner');
  assert.equal(anotherLine.error.code, -32000);
  assert.ok((await mcp.dispatch(rpc('events/subscribe', subscription('discord')), 'owner')).result.id);
});

test('LINE expiry, key cleanup and revocation cannot cancel pending Discord deliveries', async (t) => {
  const { mcp, line, discord, db, messages, requests } = fixture(t);
  const ids = {};
  for (const channel of ['line', 'discord']) {
    ids[channel] = (await mcp.dispatch(rpc('events/subscribe', subscription(channel)), 'owner')).result.id;
    await (channel === 'line' ? line : discord).publish(messages[channel]);
  }
  db.prepare('UPDATE dot_subscriptions SET expires_at=0 WHERE id=?').run(ids.line);
  db.prepare('UPDATE dot_subscriptions SET old_secret=?,old_secret_until=0 WHERE id=?').run(secret, ids.discord);
  await line.drain();
  assert.equal(db.prepare('SELECT status FROM dot_deliveries WHERE subscription_id=?').get(ids.line).status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM dot_deliveries WHERE subscription_id=?').get(ids.discord).status, 'pending');
  assert.equal(db.prepare('SELECT old_secret FROM dot_subscriptions WHERE id=?').get(ids.discord).old_secret, secret);
  assert.deepEqual(line.revokeSubscriptions('owner'), { revoked: 1 });
  assert.equal(db.prepare('SELECT active FROM dot_subscriptions WHERE id=?').get(ids.discord).active, 1);
  await discord.drain();
  assert.equal(requests.discord[1].body.name, 'discord.message.created');
  assert.equal(db.prepare('SELECT old_secret FROM dot_subscriptions WHERE id=?').get(ids.discord).old_secret, null);
});

test('unsubscribe is routed to one event while owner revocation covers both channels', async (t) => {
  const { mcp, line, discord, db, messages } = fixture(t);
  const ids = {};
  for (const channel of ['line', 'discord']) {
    ids[channel] = (await mcp.dispatch(rpc('events/subscribe', subscription(channel)), 'owner')).result.id;
    await (channel === 'line' ? line : discord).publish(messages[channel]);
  }
  const params = subscription('line'); delete params.delivery.secret;
  assert.deepEqual((await mcp.dispatch(rpc('events/unsubscribe', params), 'owner')).result, {});
  assert.equal(db.prepare('SELECT active FROM dot_subscriptions WHERE id=?').get(ids.line).active, 0);
  assert.equal(db.prepare('SELECT active FROM dot_subscriptions WHERE id=?').get(ids.discord).active, 1);
  assert.equal(db.prepare('SELECT status FROM dot_deliveries WHERE subscription_id=?').get(ids.discord).status, 'pending');
  await mcp.dispatch(rpc('events/subscribe', subscription('line')), 'owner');
  assert.deepEqual(mcp.revokeSubscriptions('owner'), { revoked: 2 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dot_deliveries WHERE status='pending'").get().n, 0);
});

test('callback 410 from one worker leaves the other provider subscription active', async (t) => {
  const { mcp, line, discord, db, messages } = fixture(t, { fetchers: { line: async (_url, options) => {
    const payload = JSON.parse(options.body);
    return payload.type === 'verification' ? { ok: true, status: 200, json: async () => ({ challenge: payload.challenge }) } : { ok: false, status: 410 };
  } } });
  const ids = {};
  for (const channel of ['line', 'discord']) {
    ids[channel] = (await mcp.dispatch(rpc('events/subscribe', subscription(channel)), 'owner')).result.id;
    await (channel === 'line' ? line : discord).publish(messages[channel]);
  }
  await line.drain();
  assert.equal(db.prepare('SELECT active FROM dot_subscriptions WHERE id=?').get(ids.line).active, 0);
  assert.equal(db.prepare('SELECT active FROM dot_subscriptions WHERE id=?').get(ids.discord).active, 1);
  assert.deepEqual(await discord.drain(), { delivered: 1 });
});

test('combined MCP validates JSON-RPC and rejects unauthorized requests before routing', async (t) => {
  const { mcp, db } = fixture(t);
  for (const body of [null, [], { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }]) assert.equal((await mcp.dispatch(body, 'owner')).error.code, -32600);
  assert.equal((await mcp.dispatch(rpc('tools/list'), 'intruder')).error.code, -32001);
  assert.equal((await mcp.dispatch(rpc('tools/call', []), 'owner')).error.code, -32602);
  assert.equal((await mcp.dispatch(rpc('tools/call', { name: 'unknown_reply' }), 'owner')).error.code, -32602);
  assert.equal((await mcp.dispatch(rpc('events/subscribe', { name: 'discord.unknown' }), 'owner')).error.code, -32602);
  assert.equal((await mcp.dispatch(rpc('unknown/method'), 'owner')).error.code, -32601);
  assert.deepEqual((await mcp.dispatch(rpc('ping', {}, 'named-id'), 'owner')).result, {});
  assert.equal(await mcp.dispatch({ jsonrpc: '2.0', method: 'events/subscribe', params: subscription('discord') }, 'owner'), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dot_subscriptions').get().n, 0);
});

test('combined lifecycle starts and closes both workers while single channel retains metadata', async (t) => {
  const { mcp, line, discord } = fixture(t);
  const one = new MultiMcp({ line });
  assert.equal((await one.dispatch(rpc('server/discover'), 'owner')).result.serverInfo.name, 'codex-line-bridge');
  mcp.start();
  assert.equal(line.running, true); assert.equal(discord.running, true);
  await mcp.close();
  assert.equal(line.closed, true); assert.equal(discord.closed, true);
  assert.equal((await mcp.dispatch(rpc('tools/list'), 'owner')).error.code, -32000);
  assert.throws(() => mcp.start(), /closed/u);
  assert.throws(() => new MultiMcp(), /At least one/u);
  assert.throws(() => new MultiMcp({ line: discord }), /Invalid line/u);
});
