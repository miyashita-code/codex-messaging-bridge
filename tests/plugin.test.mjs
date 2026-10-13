import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';

test('portable MCP OAuth scopes authorize combined LINE and Discord reads, replies and events', async (t) => {
  const example = JSON.parse(readFileSync(new URL('../plugin/mcp.json.example', import.meta.url), 'utf8'));
  const scopes = Object.values(example.mcpServers)[0].extensions['com.openai'].auth.baseScopes;
  const dir = mkdtempSync(join(tmpdir(), 'plugin-oauth-'));
  const user = '111111111111111111', channel = '333333333333333333';
  const config = normalizeConfig({
    backend: 'dot', port: 0, dataDir: dir, publicUrl: 'https://bridge.example.com', ownerSecret: 'fixture-owner',
    channels: {
      line: { channelAccessToken: 'fixture-line-token', channelSecret: 'fixture-line-secret', dmPolicy: 'allowlist', allowFrom: ['U1'] },
      discord: { enabled: true, token: 'fixture-discord-token', dmPolicy: 'allowlist', allowFrom: [user] },
    },
  }, { base: dir, env: {} });
  const sent = { line: [], discord: [] };
  const lineClient = { reply: async (_token, messages) => { sent.line.push(messages); return { sentMessages: [{ id: 'line-reply' }] }; } };
  const discordClient = { send: async (_channel, messages) => { sent.discord.push(messages); return { accepted: true, receiptComplete: true, sentMessages: [{ id: 'discord-reply' }] }; } };
  const app = await startServer(config, {
    store: new Store(':memory:'), clients: new Map([['default', lineClient]]), discordClients: new Map([['default', discordClient]]),
    enableDiscordGateway: false, acquireLock: false, logger: () => {},
  });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const redirectUri = 'https://client.example.com/callback';
  const client = await (await fetch(`${origin}/oauth/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: [redirectUri] }) })).json();
  const verifier = 'v'.repeat(43);
  const query = new URLSearchParams({
    client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), scope: scopes.join(' '),
  });
  const consent = await fetch(`${origin}/oauth/authorize?${query}`);
  assert.equal(consent.status, 200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await consent.text())[1];
  const approved = await fetch(`${origin}/oauth/consent`, {
    method: 'POST', body: new URLSearchParams({ csrf, owner_secret: 'fixture-owner', decision: 'accept' }),
    headers: { cookie: consent.headers.get('set-cookie').split(';')[0] }, redirect: 'manual',
  });
  assert.equal(approved.status, 302);
  const code = new URL(approved.headers.get('location')).searchParams.get('code');
  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: redirectUri, code, code_verifier: verifier }),
  });
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json();
  const rpc = async (method, params = {}) => {
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${token.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    assert.equal(response.status, 200, `${method} ${params.name || ''} must be authorized by the example's granted scopes`);
    const body = await response.json();
    assert.equal(body.error, undefined);
    return body.result;
  };
  const message = { type: 'message', webhookEventId: randomUUID(), timestamp: Date.now(), replyToken: 'fixture-reply-token', source: { type: 'user', userId: 'U1' }, message: { type: 'text', id: randomUUID(), text: 'LINE request' } };
  app.bridge.ingest(config.accounts[0], message);
  const incoming = { id: '555555555555555555', channel_id: channel, author: { id: user }, content: 'Discord request', timestamp: new Date().toISOString(), channel: { id: channel, type: 1 } };
  app.discordBridge.ingest(config.discordAccounts[0], incoming);
  app.bridge.tick(); app.discordBridge.tick();
  for (let attempt = 0; attempt < 200 && (!app.bridge.listInbox().length || !app.discordBridge.listInbox().length); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(app.bridge.listInbox().length, 1);
  assert.equal(app.discordBridge.listInbox().length, 1);
  for (const provider of ['line', 'discord']) {
    const inbox = await rpc('tools/call', { name: `${provider}_list_inbox` });
    const [stored] = inbox.structuredContent.messages;
    assert.equal(stored.text, `${provider === 'line' ? 'LINE' : 'Discord'} request`);
    const reply = await rpc('tools/call', { name: `${provider}_reply`, arguments: { message_id: stored.id, text: 'Completed', idempotency_key: `${provider}-answer` } });
    assert.equal(reply.structuredContent.delivery.accepted, true);
    assert.equal(sent[provider].length, 1);
  }
  assert.deepEqual((await rpc('events/list')).events.map(event => event.name), ['line.message.created', 'discord.message.created']);
});
