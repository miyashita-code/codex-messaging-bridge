import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../src/config.mjs';
import { CodexBackend, declineRequest } from '../src/codex.mjs';
import { DiscordClient, DiscordGateway } from '../src/discord.mjs';
import { Store } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const CONFIRMATION = '実環境E2E接続確認OK';
const USER = '111111111111111111';
const BOT = '222222222222222222';
const CHANNEL = '333333333333333333';
const NO_TOOLS = 'これは接続確認です。ツール、コマンド、ファイル操作、外部アプリ操作は一切使用せず、依頼された文字列だけを返信してください。';
const NO_TOOL_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning', 'contextCompaction']);

function failure(code) {
  return Object.assign(new Error(code), { code });
}

async function main() {
  const summary = {
    test: 'real Codex inference with simulated Discord transport',
    optedIn: process.env.CODEX_E2E === '1',
    node: process.version,
    usesExistingManagedChatGPTLogin: false,
    usesRealCodexInference: false,
    discordTransport: 'simulated WebSocket and REST fetch',
    liveDiscord: false,
    liveYourDotCloud: false,
    readsBotCredentialsOrDotenv: false,
    httpListener: false,
    sandbox: 'read-only',
    approvalRequestsAlwaysDeclined: true,
    codexThreadsRemainAfterCleanup: false,
    passed: [],
    failures: [],
  };
  if (!summary.optedIn) {
    summary.skipped = true;
    summary.ok = false;
    summary.reason = 'Set CODEX_E2E=1 to use your existing Codex login and run two real inference turns. Temporary bridge data is removed; the Codex conversation itself remains.';
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 2;
    return;
  }

  summary.startedAt = new Date().toISOString();
  const directory = mkdtempSync(join(tmpdir(), 'codex-messaging-e2e-'));
  let activeApp, activeBackend, stage = 'setup';
  let sequence = 100000000000000000n;
  const outgoing = [], requests = [], itemTypes = [];
  const threads = new Set();
  const recordFailure = error => {
    // Never print raw app-server errors, stderr, account details, or assertions.
    const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(error.code) ? error.code : 'E2E_FAILED';
    summary.failures.push({ stage, code });
    summary.ok = false;
    process.exitCode = 1;
  };

  try {
    const workDirectory = join(directory, 'workspace');
    mkdirSync(workDirectory, { mode: 0o700 });
    // All configuration is synthetic. Do not load the project's .env/config.
    const config = normalizeConfig({
      backend: 'codex', transport: 'headless', dataDir: directory,
      codex: { command: 'codex', cwd: workDirectory, sandbox: 'read-only', approvalPolicy: 'on-request', turnTimeoutMs: 120000 },
      channels: {
        line: { enabled: false },
        discord: { enabled: true, token: 'synthetic-discord-token', dmPolicy: 'pairing', allowFrom: [] },
      },
    }, { base: repoRoot, env: {} });

    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    const simulatedFetch = async (url, init = {}) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://discord.com');
      const route = parsed.pathname;
      if (route === '/api/v10/users/@me') return json({ id: BOT, username: 'e2e-assistant', bot: true });
      if (route === '/api/v10/gateway/bot') return json({ url: 'wss://gateway.discord.gg', shards: 1, session_start_limit: { remaining: 100 } });
      if (route === `/api/v10/channels/${CHANNEL}`) return json({ id: CHANNEL, type: 1 });
      if (route === `/api/v10/channels/${CHANNEL}/typing`) return new Response(null, { status: 204 });
      if (route === `/api/v10/channels/${CHANNEL}/messages` && init.method === 'POST') {
        const body = JSON.parse(init.body);
        assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: false });
        assert.equal(body.enforce_nonce, true);
        assert.match(body.nonce, /^\d{1,25}$/);
        outgoing.push({ content: body.content, nonce: body.nonce });
        return json({ id: String(++sequence) });
      }
      throw failure('UNEXPECTED_SIMULATED_DISCORD_ROUTE');
    };

    class SimulatedSocket {
      static current;
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.listeners = new Map();
        SimulatedSocket.current = this;
      }
      addEventListener(type, callback) {
        const callbacks = this.listeners.get(type) || [];
        callbacks.push(callback);
        this.listeners.set(type, callbacks);
      }
      send(value) { JSON.parse(value); }
      emit(type, value) { for (const callback of this.listeners.get(type) || []) callback(value); }
      payload(value) { this.emit('message', { data: JSON.stringify(value) }); }
      close(code = 1000) { this.readyState = 3; this.emit('close', { code }); }
    }
    const timers = {
      next: 1, jobs: new Map(),
      setTimeout(callback, milliseconds) { const id = this.next++; this.jobs.set(id, { callback, milliseconds }); return id; },
      clearTimeout(id) { this.jobs.delete(id); },
    };
    class SimulatedGateway extends DiscordGateway {
      constructor(account, options) {
        super(account, { ...options, WebSocketImpl: SimulatedSocket, fetchImpl: simulatedFetch, timers, random: () => 0 });
      }
    }
    const spawn = (command, args, options) => {
      const child = spawnChild(command, args, options);
      let buffer = '';
      // Observe item types only; discard all other protocol/account content.
      child.stdout.on('data', bytes => {
        buffer += bytes.toString();
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const message = JSON.parse(line);
            if (message.method === 'item/started' && message.params?.item?.type) itemTypes.push(message.params.item.type);
          } catch {}
        }
      });
      return child;
    };
    const wait = async (predicate, timeoutMs = 120000) => {
      const started = Date.now();
      while (!predicate()) {
        const dead = activeApp?.store.db.prepare("SELECT error FROM jobs WHERE status='dead' LIMIT 1").get();
        if (dead) throw failure(dead.error || 'DISCORD_JOB_FAILED');
        if (Date.now() - started >= timeoutMs) throw failure('E2E_WAIT_TIMEOUT');
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    };
    const launch = async () => {
      const backend = new CodexBackend(config.codex, { spawn });
      activeBackend = backend;
      const run = backend.run.bind(backend);
      backend.run = args => {
        summary.usesRealCodexInference = true;
        return run({
          ...args,
          systemPrompt: `${args.systemPrompt}\n${NO_TOOLS}`,
          onThread: async id => { threads.add(id); await args.onThread?.(id); },
          onRequest: async request => {
            requests.push(request.method);
            const declined = declineRequest(request.method, request.params);
            // A rejecting handler makes the backend fail closed for unknown requests.
            if (declined === undefined) throw failure('UNSUPPORTED_CODEX_REQUEST');
            return declined;
          },
        });
      };
      const health = await backend.health();
      assert.equal(health.authenticated, true);
      assert.equal(health.authMode, 'chatgpt');
      summary.authenticated = true;
      summary.usesExistingManagedChatGPTLogin = true;
      summary.model = (await backend.models()).find(model => model.isDefault && !model.hidden)?.model;
      assert.equal(typeof summary.model, 'string');
      const app = await startServer(config, {
        store: new Store(join(directory, 'bridge.sqlite')), backend,
        discordClients: new Map([['default', new DiscordClient(config.discordAccounts[0], { fetchImpl: simulatedFetch })]]),
        GatewayImpl: SimulatedGateway, logger: () => {},
      });
      activeApp = app;
      SimulatedSocket.current.payload({ op: 10, d: { heartbeat_interval: 60000 } });
      SimulatedSocket.current.payload({ op: 0, t: 'READY', s: 1, d: { session_id: 'synthetic-session', resume_gateway_url: 'wss://gateway.discord.gg', user: { id: BOT } } });
      await wait(() => app.gateways[0].status().ready);
      assert.equal(app.server.listening, false);
      return app;
    };
    const dispatch = (content, id = String(++sequence), dispatchSequence = 2) => {
      SimulatedSocket.current.payload({ op: 0, t: 'MESSAGE_CREATE', s: dispatchSequence, d: {
        id, channel_id: CHANNEL, author: { id: USER, username: 'synthetic-user' }, content,
        timestamp: new Date().toISOString(), channel: { id: CHANNEL, type: 1 },
      } });
      return id;
    };
    const countDone = app => app.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='done'").get().n;

    stage = 'managed_codex_login';
    let app = await launch();
    summary.passed.push('managed ChatGPT login and advertised default model');

    stage = 'pairing';
    dispatch(NO_TOOLS);
    await wait(() => countDone(app) === 1);
    assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 0);
    assert.equal(outgoing.length, 1);
    assert.match(outgoing[0].content, /ペアリングコード/);
    const pairing = app.store.db.prepare('SELECT code FROM pairings WHERE approved=0').get();
    assert.ok(app.store.approve(pairing.code));
    summary.passed.push('unapproved DM is paired locally without running inference');

    stage = 'real_inference_and_simulated_reply';
    const firstId = dispatch(`${NO_TOOLS}\n次の文字列だけを返信してください: ${CONFIRMATION}`, undefined, 3);
    await wait(() => countDone(app) === 2);
    assert.equal(outgoing.length, 2);
    assert.equal(outgoing[1].content.trim(), CONFIRMATION);
    const threadId = app.store.db.prepare('SELECT thread_id FROM sessions').get()?.thread_id;
    assert.equal(typeof threadId, 'string');
    assert.equal(app.store.db.prepare('SELECT finished FROM runs').get().finished, 1);
    summary.passed.push('Gateway ingress, durable queue, real Codex inference, and simulated DiscordClient reply');

    stage = 'duplicate_ingress';
    dispatch('synthetic duplicate event', firstId, 4);
    await wait(() => app.gateways[0].status().committedSequence === 4);
    assert.equal(countDone(app), 2);
    assert.equal(outgoing.length, 2);
    summary.passed.push('duplicate Gateway event creates no duplicate inference or reply');

    stage = 'runtime_restart_and_resume';
    await app.close();
    activeApp = activeBackend = undefined;
    app = await launch();
    dispatch(`${NO_TOOLS}\n直前にあなたが返信した文字列だけをもう一度返信してください。`);
    await wait(() => countDone(app) === 3);
    assert.equal(outgoing.length, 3);
    assert.equal(outgoing[2].content.trim(), CONFIRMATION);
    assert.equal(app.store.db.prepare('SELECT thread_id FROM sessions').get().thread_id, threadId);
    assert.equal(threads.size, 1);
    summary.passed.push('runtime restart preserves pairing and resumes the same Codex conversation');

    stage = 'no_tools_and_outbound_contract';
    assert.equal(requests.length, 0);
    assert(itemTypes.every(type => NO_TOOL_ITEMS.has(type)));
    summary.passed.push('no tool execution or approval request; outbound mentions suppressed and decimal nonces enforced');
    summary.counts = {
      completedJobs: countDone(app),
      realInferenceRuns: app.store.db.prepare('SELECT COUNT(*) n FROM runs').get().n,
      simulatedOutboundMessages: outgoing.length,
      approvalRequests: requests.length,
      toolItems: itemTypes.filter(type => !NO_TOOL_ITEMS.has(type)).length,
      codexThreadsCreated: threads.size,
    };
    summary.reply = outgoing[2].content;
    summary.ok = true;
  } catch (error) {
    recordFailure(error);
  } finally {
    stage = 'cleanup';
    try { await activeApp?.close(); } catch (error) { recordFailure(error); }
    try { await activeBackend?.close(); } catch (error) { recordFailure(error); }
    try { rmSync(directory, { recursive: true, force: true }); } catch (error) { recordFailure(error); }
    summary.temporaryBridgeDataRemoved = !existsSync(directory);
    summary.codexThreadsRemainAfterCleanup = threads.size > 0;
    summary.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(summary, null, 2));
  }
}

await main();
