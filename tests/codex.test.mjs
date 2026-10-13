import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexBackend, declineRequest } from '../src/codex.mjs';

const config = {
  command: 'codex', cwd: process.cwd(), sandbox: 'read-only',
  approvalPolicy: 'on-request', turnTimeoutMs: 2_000,
};

function fixture(t, handler, overrides = {}) {
  const children = [];
  let threadSequence = 0;
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, {
      command, args, options, stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough(), exitCode: null, signalCode: null, messages: [],
      emitMessage(message) { this.stdout.write(`${JSON.stringify(message)}\n`); },
      respond(message, result) { this.emitMessage({ id: message.id, result }); },
      notification(method, params) { this.emitMessage({ method, params }); },
      kill(signal) {
        if (this.exitCode != null || this.signalCode != null) return false;
        this.signalCode = signal;
        queueMicrotask(() => this.emit('exit', null, signal));
        return true;
      },
    });
    let buffer = '';
    child.stdin.on('data', data => {
      buffer += data.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        child.messages.push(message);
        if (handler?.(child, message, children.length - 1) === true) continue;
        if (!message.method || message.id == null) continue;
        if (message.method === 'initialize') child.respond(message, {});
        else if (message.method === 'account/read') child.respond(message, {
          account: { type: 'chatgpt', planType: 'pro', email: 'private@example.com' }, requiresOpenaiAuth: true,
        });
        else if (message.method === 'model/list') child.respond(message, {
          data: [{ id: 'catalog-default-id', model: 'catalog-default-model', displayName: 'Catalog Default', isDefault: true, hidden: false }], nextCursor: null,
        });
        else if (message.method === 'thread/start' || message.method === 'thread/resume') child.respond(message, {
          thread: { id: message.params.threadId || `thread-${++threadSequence}` },
        });
        else if (message.method === 'turn/start') child.respond(message, { turn: { id: `turn-${message.params.threadId}` } });
        else if (message.method === 'turn/interrupt') child.respond(message, {});
      }
    });
    children.push(child);
    return child;
  };
  const backend = new CodexBackend({ ...config, ...overrides }, { spawn });
  t.after(() => backend.close());
  return { backend, children };
}

function complete(child, threadId, text = 'こんにちは', items) {
  const turnId = `turn-${threadId}`;
  child.notification('turn/completed', {
    threadId, turn: { id: turnId, status: 'completed', items: items ?? [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text }] },
  });
}

const input = [{ type: 'text', text: 'こんにちは' }];
const nextTick = () => new Promise(resolve => setImmediate(resolve));

test('initializes once, uses managed ChatGPT auth, and never exposes account email', async t => {
  const { backend, children } = fixture(t);
  assert.deepEqual(await backend.health(), {
    ok: true, authenticated: true, authMode: 'chatgpt', planType: 'pro', requiresOpenaiAuth: true,
  });
  await backend.health();
  assert.equal(children.length, 1);
  assert.deepEqual(children[0].messages.map(m => m.method), ['initialize', 'initialized', 'account/read', 'account/read']);
  assert.deepEqual(children[0].args, ['app-server', '--listen', 'stdio://']);
  assert.equal(children[0].options.shell, false);
  assert.equal(children[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(children[0].options.env.CODEX_API_KEY, undefined);
  assert.equal(children[0].messages[0].params.capabilities.experimentalApi, true);
});

test('agent child inherits no LINE channel, owner, MCP, or account credentials', async t => {
  const names = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'LINE_BRIDGE_OWNER_SECRET', 'LINE_BRIDGE_MCP_TOKEN', 'LINE_ACCOUNT_PRIVATE_TOKEN'];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = `synthetic-${name}`;
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const { backend, children } = fixture(t);
  await backend.health();
  for (const name of names) assert.equal(children[0].options.env[name], undefined);
  assert.equal(children[0].options.env.PATH, process.env.PATH);
  assert.equal(children[0].options.env.CODEX_HOME, process.env.CODEX_HOME);
  for (const name of names) assert.equal(process.env[name], `synthetic-${name}`);
});

test('starts and resumes a persistent thread, preserving Codex defaults and image input', async t => {
  const { backend, children } = fixture(t, (child, message) => {
    if (message.method === 'turn/start') queueMicrotask(() => complete(child, message.params.threadId));
  }, { model: 'test-model' });
  const persisted = [];
  const result = await backend.run({
    sessionKey: 'user:1', input: [...input, { type: 'localImage', path: '/tmp/example.png' }],
    systemPrompt: 'あなたはAI秘書です', onThread: async id => { persisted.push(id); },
  });
  assert.deepEqual(result, { threadId: 'thread-1', text: 'こんにちは' });
  assert.deepEqual(persisted, ['thread-1']);
  const start = children[0].messages.find(m => m.method === 'thread/start');
  assert.equal(start.params.developerInstructions, 'あなたはAI秘書です');
  assert.equal(start.params.baseInstructions, undefined);
  assert.equal(start.params.approvalsReviewer, 'user');
  assert.equal(start.params.approvalPolicy, 'on-request');
  assert.equal(start.params.sandbox, 'read-only');
  assert.equal(start.params.modelProvider, 'openai');
  assert.equal(start.params.model, 'test-model');
  assert.equal(children[0].messages.some(m => m.method === 'model/list'), false);
  assert.equal(children[0].messages.find(m => m.method === 'turn/start').params.input[1].path, '/tmp/example.png');
  await backend.run({ sessionKey: 'user:1', threadId: result.threadId, input, systemPrompt: 'new prompt' });
  assert.equal(children[0].messages.filter(m => m.method === 'thread/start').length, 1);
  assert.equal(children[0].messages.find(m => m.method === 'thread/resume').params.threadId, 'thread-1');
  assert.equal(children[0].messages.find(m => m.method === 'thread/resume').params.developerInstructions, 'new prompt');
});

test('resume token usage snapshots cannot bind the current turn to a previous turn', async t => {
  const { backend, children } = fixture(t, (child, message) => {
    if (message.method === 'turn/start') queueMicrotask(() => complete(child, message.params.threadId, '再開接続確認OK'));
  });
  const result = await backend.run({
    sessionKey: 'user:resume', threadId: 'persisted-thread', input,
    onThread: id => {
      // The real app-server emits this historical snapshot after thread/resume.
      // Persistence can yield between registering the thread and turn/start.
      children[0].notification('thread/tokenUsage/updated', { threadId: id, turnId: 'previous-turn' });
    },
  });
  assert.deepEqual(result, { threadId: 'persisted-thread', text: '再開接続確認OK' });
});

test('unspecified models use the advertised default model value for new and resumed threads', async t => {
  const { backend, children } = fixture(t, (child, message) => {
    if (message.method === 'turn/start') queueMicrotask(() => complete(child, message.params.threadId));
  });
  await backend.run({ sessionKey: 'user:1', input });
  await backend.run({ sessionKey: 'user:1', threadId: 'thread-1', input });
  const starts = children[0].messages.filter(m => ['thread/start', 'thread/resume'].includes(m.method));
  assert.equal(starts.length, 2);
  for (const message of starts) assert.equal(message.params.model, 'catalog-default-model');
});

test('models returns only public catalog fields and follows pagination', async t => {
  const { backend, children } = fixture(t, (child, message) => {
    if (message.method !== 'model/list') return;
    child.respond(message, message.params.cursor ? {
      data: [{ id: 'visible', model: 'visible-model', displayName: 'Visible Model', isDefault: true, hidden: false, inputModalities: ['text'], unrelatedField: 'omit-me' }], nextCursor: null,
    } : {
      data: [{ id: 'other', model: 'other-model', displayName: 'Other Model', isDefault: false, hidden: false }], nextCursor: 'next-page',
    });
    return true;
  });
  assert.deepEqual(await backend.models(), [
    { id: 'other', model: 'other-model', displayName: 'Other Model', isDefault: false, hidden: false, inputModalities: ['text', 'image'] },
    { id: 'visible', model: 'visible-model', displayName: 'Visible Model', isDefault: true, hidden: false, inputModalities: ['text'] },
  ]);
  assert.deepEqual(children[0].messages.filter(m => m.method === 'model/list').map(m => m.params), [
    { limit: 100, includeHidden: false }, { limit: 100, includeHidden: false, cursor: 'next-page' },
  ]);
});

test('missing advertised default fails before inference rather than guessing a model', async t => {
  const { backend, children } = fixture(t, (child, message) => {
    if (message.method !== 'model/list') return;
    child.respond(message, { data: [{ id: 'other', model: 'other-model', displayName: 'Other', isDefault: false, hidden: false }], nextCursor: null });
    return true;
  });
  await assert.rejects(backend.run({ sessionKey: 'user:1', input }), { code: 'MODEL_DEFAULT_UNAVAILABLE' });
  assert.equal(children[0].messages.some(m => m.method === 'thread/start'), false);
});

test('filters commentary from final output and replaces deltas with completed text', async t => {
  const progress = [];
  const { backend } = fixture(t, (child, message) => {
    if (message.method !== 'turn/start') return;
    queueMicrotask(() => {
      const threadId = message.params.threadId, turnId = `turn-${threadId}`;
      child.notification('item/started', { threadId, turnId, item: { type: 'agentMessage', id: 'progress', phase: 'commentary', text: '' } });
      child.notification('item/agentMessage/delta', { threadId, turnId, itemId: 'progress', delta: '調べています' });
      child.notification('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'progress', phase: 'commentary', text: '調べています' } });
      child.notification('item/agentMessage/delta', { threadId, turnId, itemId: 'answer', delta: '途中' });
      child.notification('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '回答' } });
      complete(child, threadId, '', []);
    });
  });
  assert.equal((await backend.run({ sessionKey: 'user:1', input, onProgress: async text => progress.push(text) })).text, '回答');
  await nextTick();
  assert.deepEqual(progress, ['調べています']);
});

test('supports legacy phase-less streamed answers and ignores another turn', async t => {
  const { backend } = fixture(t, (child, message) => {
    if (message.method !== 'turn/start') return;
    queueMicrotask(() => {
      const threadId = message.params.threadId, turnId = `turn-${threadId}`;
      child.notification('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
      child.notification('item/agentMessage/delta', { threadId, turnId: 'old-turn', itemId: 'old', delta: '混入' });
      child.notification('item/agentMessage/delta', { threadId, turnId, itemId: 'legacy', delta: 'legacy ' });
      child.notification('item/agentMessage/delta', { threadId, turnId, itemId: 'legacy', delta: 'answer' });
      complete(child, threadId, '', []);
    });
  });
  assert.equal((await backend.run({ sessionKey: 'user:1', input })).text, 'legacy answer');
});

test('rejects API-key auth rather than silently using an unapproved connection', async t => {
  const { backend, children } = fixture(t, (child, message) => {
    if (message.method !== 'account/read') return;
    child.respond(message, { account: { type: 'apiKey' }, requiresOpenaiAuth: true });
    return true;
  });
  await assert.rejects(backend.run({ sessionKey: 'user:1', input }), { code: 'CHATGPT_LOGIN_REQUIRED' });
  assert.equal(children[0].messages.some(m => m.method === 'thread/start'), false);
  assert.equal(children[0].messages.some(m => m.method === 'account/login/start'), false);
});

test('unhandled approvals and elicitations fail closed with current schema responses', async t => {
  const methods = [
    'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
    'item/permissions/requestApproval', 'item/tool/requestUserInput',
    'mcpServer/elicitation/request', 'item/tool/call', 'future/unsupported',
  ];
  const { backend, children } = fixture(t, (child, message) => {
    if (message.method !== 'turn/start') return;
    queueMicrotask(() => {
      for (let i = 0; i < methods.length; i++) child.emitMessage({ id: i + 100, method: methods[i], params: { threadId: message.params.threadId, questions: [{ id: 'q1' }] } });
      complete(child, message.params.threadId);
    });
  });
  await backend.run({ sessionKey: 'user:1', input });
  const replies = children[0].messages.filter(m => Number.isInteger(m.id));
  assert.deepEqual(replies.map(m => m.result ?? m.error), [
    { decision: 'decline' }, { decision: 'decline' }, { permissions: {}, scope: 'turn' },
    { answers: { q1: { answers: [] } } }, { action: 'decline', content: null },
    { success: false, contentItems: [{ type: 'inputText', text: 'This LINE bridge does not implement the requested client tool.' }] },
    { code: -32601, message: 'This bridge does not support that server request' },
  ]);
  assert.deepEqual(declineRequest('execCommandApproval'), { decision: 'denied' });
});

test('routes server requests to the owning session and supports deferred answers', async t => {
  let callbackRequest;
  const { backend, children } = fixture(t, (child, message) => {
    if (message.method === 'turn/start') queueMicrotask(() => child.emitMessage({
      id: 'approval:1', method: 'item/commandExecution/requestApproval',
      params: { threadId: message.params.threadId, turnId: `turn-${message.params.threadId}`, command: 'ls' },
    }));
    if (message.id === 'approval:1' && message.result) queueMicrotask(() => complete(child, 'thread-1'));
  });
  const run = backend.run({ sessionKey: 'user:1', input, onRequest: async request => { callbackRequest = request; } });
  await nextTick();
  assert.equal(callbackRequest.method, 'item/commandExecution/requestApproval');
  assert.equal(backend.answer(callbackRequest.requestId, { decision: 'accept' }), true);
  assert.equal((await run).text, 'こんにちは');
  assert.equal(backend.answer(callbackRequest.requestId, { decision: 'accept' }), false);
  assert.deepEqual(children[0].messages.find(m => m.id === 'approval:1').result, { decision: 'accept' });
});

test('a rejected request handler declines; server-cleared requests cannot be answered', async t => {
  const { backend, children } = fixture(t, (child, message) => {
    if (message.method === 'turn/start') queueMicrotask(() => child.emitMessage({
      id: 1, method: 'item/fileChange/requestApproval', params: { threadId: message.params.threadId },
    }));
    if (message.id === 1 && message.result) queueMicrotask(() => {
      child.notification('serverRequest/resolved', { threadId: 'thread-1', requestId: 1 });
      complete(child, 'thread-1');
    });
  });
  await backend.run({ sessionKey: 'user:1', input, onRequest: async () => { throw new Error('delivery failed'); } });
  assert.deepEqual(children[0].messages.find(m => m.id === 1).result, { decision: 'decline' });
  assert.equal(backend.answer(1, { decision: 'accept' }), false);
});

test('timeout interrupts an active turn and declines outstanding approval', async t => {
  const { backend, children } = fixture(t, (child, message) => {
    if (message.method === 'turn/start') queueMicrotask(() => child.emitMessage({
      id: 'pending', method: 'item/commandExecution/requestApproval', params: { threadId: message.params.threadId },
    }));
  }, { turnTimeoutMs: 30 });
  await assert.rejects(backend.run({ sessionKey: 'user:1', input, onRequest: async () => {} }), { code: 'TURN_TIMEOUT' });
  assert.deepEqual(children[0].messages.find(m => m.id === 'pending').result, { decision: 'decline' });
  assert.deepEqual(children[0].messages.find(m => m.method === 'turn/interrupt').params, { threadId: 'thread-1', turnId: 'turn-thread-1' });
  assert.equal(backend.answer('pending', { decision: 'accept' }), false);
});

test('abort during turn/start still interrupts the eventual server turn', async t => {
  let held;
  const { backend, children } = fixture(t, (child, message) => {
    if (message.method === 'turn/start') { held = message; return true; }
  });
  const controller = new AbortController();
  const run = backend.run({ sessionKey: 'user:1', input, signal: controller.signal });
  await nextTick();
  controller.abort();
  await assert.rejects(run, { code: 'TURN_INTERRUPTED' });
  children[0].respond(held, { turn: { id: 'late-turn' } });
  await nextTick();
  assert.equal(children[0].messages.find(m => m.method === 'turn/interrupt').params.turnId, 'late-turn');
});

test('same-session overlap is rejected while independent sessions share the transport', async t => {
  const { backend, children } = fixture(t);
  const first = backend.run({ sessionKey: 'user:1', input });
  await assert.rejects(backend.run({ sessionKey: 'user:1', input }), { code: 'SESSION_BUSY' });
  const second = backend.run({ sessionKey: 'user:2', input });
  await nextTick();
  assert.equal(children.length, 1);
  complete(children[0], 'thread-2', 'two');
  complete(children[0], 'thread-1', 'one');
  assert.equal((await first).text, 'one');
  assert.equal((await second).text, 'two');
});

test('turn failure and process exit reject waiting work; next run reinitializes', async t => {
  const { backend, children } = fixture(t, (child, message, index) => {
    if (message.method === 'turn/start' && index > 0) queueMicrotask(() => complete(child, message.params.threadId, 'recovered'));
  });
  const first = backend.run({ sessionKey: 'user:1', input });
  await nextTick();
  children[0].exitCode = 1;
  children[0].emit('exit', 1, null);
  await assert.rejects(first, { code: 'PROCESS_EXITED' });
  assert.equal((await backend.run({ sessionKey: 'user:1', threadId: 'thread-1', input })).text, 'recovered');
  assert.equal(children.length, 2);
  assert.equal(children[1].messages[0].method, 'initialize');
  const failing = fixture(t, (child, message) => {
    if (message.method === 'turn/start') queueMicrotask(() => child.notification('turn/completed', {
      threadId: message.params.threadId, turn: { id: `turn-${message.params.threadId}`, status: 'failed', items: [], error: { message: 'usage limit reached' } },
    }));
  });
  await assert.rejects(failing.backend.run({ sessionKey: 'user:1', input }), { code: 'TURN_FAILED', message: 'usage limit reached' });
});

test('close rejects active work, stops the child, and prevents a restart', async t => {
  const { backend, children } = fixture(t);
  const running = backend.run({ sessionKey: 'user:1', input });
  await nextTick();
  const rejected = assert.rejects(running, { code: 'BACKEND_CLOSED' });
  await backend.close();
  await rejected;
  assert.equal(children[0].signalCode, 'SIGTERM');
  await assert.rejects(backend.health(), { code: 'BACKEND_CLOSED' });
});

test('invalid protocol fails pending work without relaying raw output', async t => {
  const { backend, children } = fixture(t);
  const running = backend.run({ sessionKey: 'user:1', input });
  await nextTick();
  children[0].stderr.write('sensitive-token-do-not-log');
  children[0].stdout.write('sensitive-token-do-not-log\n');
  await assert.rejects(running, { code: 'PROTOCOL_ERROR', message: 'Invalid Codex protocol message' });
});

test('read-only real CLI smoke: initialize and account/read, no inference', { skip: process.env.CODEX_SMOKE !== '1' }, async t => {
  const backend = new CodexBackend(config);
  t.after(() => backend.close());
  const result = await backend.health();
  assert.equal(result.ok, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.authMode, 'chatgpt');
  const models = await backend.models();
  assert.equal(models.some(model => model.isDefault && !model.hidden), true);
});
