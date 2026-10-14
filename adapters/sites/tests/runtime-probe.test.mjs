import test from 'node:test';
import assert from 'node:assert/strict';
import { probeDiscordRuntime } from '../worker/runtime-probe.js';

const DISCOVERY = 'https://discord.com/api/v10/gateway';
const UPGRADE = 'https://gateway.discord.gg/?v=10&encoding=json';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class Socket {
  constructor(onAccept = socket => socket.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }) })) {
    this.readyState = 1;
    this.onAccept = onAccept;
    this.listeners = new Map();
    this.acceptCalls = 0;
    this.closeCalls = [];
    this.sent = [];
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener(event); }
  accept() { this.acceptCalls++; this.onAccept(this); }
  close(code, reason) { this.closeCalls.push({ code, reason }); this.readyState = 3; this.emit('close', { code }); }
  send(frame) { this.sent.push(frame); throw new Error('The probe must not send Gateway application frames'); }
  get listenerCount() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}
const discovery = (url = 'wss://gateway.discord.gg/') => ({ status: 200, json: async () => ({ url }) });
const setup = (socket = new Socket(), overrides = {}) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === DISCOVERY) return overrides.discovery ? overrides.discovery() : discovery();
    if (url === UPGRADE) return overrides.upgrade ? overrides.upgrade() : { status: 101, webSocket: socket };
    throw new Error('Unexpected destination');
  };
  return { socket, calls, fetchImpl };
};
const assertSafe = result => {
  assert.equal(result.runtimeVerified, false);
  assert.equal(result.uptimeVerified, false);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ERROR|Bot |Authorization|token/i);
};

test('HELLO probe uses two fixed credential-free requests and cleans up immediately', async t => {
  const tracked = [];
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args) => { const handle = originalSet(...args); tracked.push({ handle, cleared: false, ms: args[1] }); return handle; });
  t.mock.method(globalThis, 'clearTimeout', handle => { const entry = tracked.find(item => item.handle === handle); if (entry) entry.cleared = true; return originalClear(handle); });
  const fixture = setup();
  const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl, nonce: 'run_abc-42' });
  assert.equal(result.ok, true);
  assert.equal(result.nonce, 'run_abc-42');
  assert.equal(result.error, null);
  assert.deepEqual(result.https, { reached: true, ok: true, status: 200 });
  assert.equal(result.wss.hello, true);
  assert.equal(result.wss.heartbeatIntervalMs, 45000);
  assert.equal(result.wss.closeRequested, true);
  assert.equal(result.wss.closeObserved, true);
  assert.deepEqual(fixture.calls.map(call => call.url), [DISCOVERY, UPGRADE]);
  assert.equal(fixture.calls[0].options.signal, fixture.calls[1].options.signal);
  assert.equal(fixture.calls[1].options.signal.aborted, true);
  for (const call of fixture.calls) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'manual');
    assert.equal(call.options.body, undefined);
    assert.equal(new Headers(call.options.headers).has('authorization'), false);
  }
  assert.deepEqual(fixture.calls[1].options.headers, { Upgrade: 'websocket' });
  assert.equal(fixture.socket.acceptCalls, 1);
  assert.deepEqual(fixture.socket.closeCalls, [{ code: 1000, reason: 'probe complete' }]);
  assert.equal(fixture.socket.listenerCount, 0);
  assert.deepEqual(fixture.socket.sent, []);
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].ms, 20000);
  assert.equal(tracked[0].cleared, true);
  const snapshot = JSON.stringify(result);
  fixture.socket.emit('error', { message: 'PRIVATE_ERROR' });
  fixture.socket.emit('close');
  assert.equal(JSON.stringify(result), snapshot);
  assertSafe(result);
});

test('invalid duration, nonce and fetch arguments fail before making any request', async () => {
  for (const options of [{ timeoutMs: 20001 }, { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 1.5 }, { nonce: 'unsafe\nPRIVATE_ERROR' }, { nonce: 'a'.repeat(65) }, { fetchImpl: null }]) {
    let called = false;
    const result = await probeDiscordRuntime({ fetchImpl: () => { called = true; }, ...options });
    assert.equal(result.error, 'INVALID_OPTIONS');
    assert.equal(result.ok, false);
    assert.equal(called, false);
    assertSafe(result);
  }
});

test('discovery URL validation rejects alternate hosts, credentials, ports and suffix tricks', async () => {
  for (const url of ['http://gateway.discord.gg/', 'https://gateway.discord.gg/', 'wss://evil.example/', 'wss://gateway.discord.gg.evil.example/', 'wss://user:pass@gateway.discord.gg/', 'wss://gateway.discord.gg:443/', 'wss://gateway.discord.gg/elsewhere', 'wss://gateway.discord.gg/?foo=bar', 'wss://gateway.discord.gg/#frag', ' wss://gateway.discord.gg/', 'wss://127.0.0.1/', null]) {
    const fixture = setup(new Socket(), { discovery: () => discovery(url) });
    const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
    assert.equal(result.error, 'DISCOVERY_GATEWAY_DENIED');
    assert.equal(result.https.ok, true);
    assert.equal(result.wss.ok, false);
    assert.equal(fixture.calls.length, 1);
    assertSafe(result);
  }
});

test('network and HTTP discovery failures are distinct, sanitized and do not upgrade', async () => {
  for (const [reply, expected, reached, status] of [
    [() => { throw new Error('PRIVATE_ERROR'); }, 'DISCOVERY_NETWORK_ERROR', false, null],
    [() => { const error = new Error('PRIVATE_ERROR'); error.name = 'AbortError'; throw error; }, 'DISCOVERY_ABORTED', false, null],
    [() => ({ status: 403, json: () => { throw new Error('Must not read error body'); } }), 'DISCOVERY_HTTP_ERROR', true, 403],
    [() => ({ status: 200, redirected: true }), 'DISCOVERY_REDIRECT_DENIED', true, 200],
    [() => ({ status: 200, json: () => { throw new Error('PRIVATE_ERROR'); } }), 'DISCOVERY_JSON_INVALID', true, 200],
  ]) {
    const fixture = setup(new Socket(), { discovery: reply });
    const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
    assert.equal(result.error, expected);
    assert.equal(result.https.reached, reached);
    assert.equal(result.https.status, status);
    assert.equal(fixture.calls.length, 1);
    assertSafe(result);
  }
});

test('upgrade failures preserve successful HTTPS evidence and close inconsistent socket returns', async () => {
  for (const [reply, expected] of [
    [() => { throw new Error('PRIVATE_ERROR'); }, 'UPGRADE_NETWORK_ERROR'],
    [() => { const error = new Error('PRIVATE_ERROR'); error.name = 'AbortError'; throw error; }, 'UPGRADE_ABORTED'],
    [() => ({ status: 403 }), 'UPGRADE_HTTP_ERROR'],
    [() => ({ status: 101 }), 'WEBSOCKET_API_UNAVAILABLE'],
    [() => ({ status: 101, webSocket: {} }), 'WEBSOCKET_API_UNAVAILABLE'],
  ]) {
    const fixture = setup(new Socket(), { upgrade: reply });
    const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
    assert.equal(result.error, expected);
    assert.equal(result.https.ok, true);
    assert.equal(result.wss.ok, false);
    assert.equal(result.ok, false);
    assertSafe(result);
  }
  for (const extra of [{ status: 200 }, { status: 101, redirected: true }]) {
    const socket = new Socket();
    const fixture = setup(socket, { upgrade: () => ({ ...extra, webSocket: socket }) });
    const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(socket.acceptCalls, 0);
    assert.equal(socket.closeCalls.length, 1);
  }
});

test('only well-formed JSON HELLO with a positive safe interval passes, never Identify or Heartbeat', async () => {
  for (const [data, expected] of [
    ['PRIVATE_ERROR{', 'GATEWAY_MESSAGE_INVALID'],
    [new Uint8Array([1, 2]), 'GATEWAY_MESSAGE_INVALID'],
    ['x'.repeat(4097), 'GATEWAY_MESSAGE_INVALID'],
    ['null', 'GATEWAY_EVENT_UNEXPECTED'],
    [JSON.stringify({ op: 1, d: null }), 'GATEWAY_EVENT_UNEXPECTED'],
    [JSON.stringify({ op: 0, t: 'READY', d: { secret: 'PRIVATE_ERROR' } }), 'GATEWAY_EVENT_UNEXPECTED'],
    [JSON.stringify({ op: 10, d: {} }), 'GATEWAY_HELLO_INVALID'],
    [JSON.stringify({ op: 10, d: { heartbeat_interval: 0 } }), 'GATEWAY_HELLO_INVALID'],
    [JSON.stringify({ op: 10, d: { heartbeat_interval: '45000' } }), 'GATEWAY_HELLO_INVALID'],
  ]) {
    const fixture = setup(new Socket(socket => socket.emit('message', { data })));
    const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
    assert.equal(result.error, expected);
    assert.equal(result.wss.upgraded, true);
    assert.equal(result.wss.hello, false);
    assert.equal(result.wss.ok, false);
    assert.equal(fixture.socket.listenerCount, 0);
    assert.equal(fixture.socket.closeCalls.length, 1);
    assert.deepEqual(fixture.socket.sent, []);
    assertSafe(result);
  }
});

test('socket setup exceptions and early remote close/error are sanitized and cleaned up', async () => {
  for (const [onAccept, expected] of [
    [() => { throw new Error('PRIVATE_ERROR'); }, 'WEBSOCKET_SETUP_FAILED'],
    [socket => socket.emit('error', { message: 'PRIVATE_ERROR' }), 'WEBSOCKET_ERROR'],
    [socket => { socket.readyState = 3; socket.emit('close', { code: 1006 }); }, 'WEBSOCKET_CLOSED_BEFORE_HELLO'],
  ]) {
    const fixture = setup(new Socket(onAccept));
    const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
    assert.equal(result.error, expected);
    assert.equal(result.ok, false);
    assert.equal(fixture.socket.listenerCount, 0);
    assert.deepEqual(fixture.socket.sent, []);
    assertSafe(result);
  }
});

test('one total deadline stops hung discovery, body, upgrade and silent sockets', async () => {
  const never = () => new Promise(() => {});
  const silent = new Socket(() => {});
  for (const fixture of [
    setup(new Socket(), { discovery: never }),
    setup(new Socket(), { discovery: () => ({ status: 200, json: never }) }),
    setup(new Socket(), { upgrade: never }),
    setup(silent),
  ]) {
    const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl, timeoutMs: 10 });
    assert.equal(result.error, 'TIMEOUT');
    assert.equal(result.ok, false);
    assert.equal(fixture.calls[0].options.signal.aborted, true);
    assert.ok(result.durationMs < 1000);
    assertSafe(result);
  }
  assert.equal(silent.closeCalls.length, 1);
  assert.equal(silent.listenerCount, 0);
});

test('an upgrade response arriving after timeout closes its socket without accepting or mutating result', async () => {
  const socket = new Socket();
  const fixture = setup(socket, { upgrade: async () => { await pause(25); return { status: 101, webSocket: socket }; } });
  const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl, timeoutMs: 5 });
  assert.equal(result.error, 'TIMEOUT');
  const snapshot = JSON.stringify(result);
  await pause(35);
  assert.equal(socket.acceptCalls, 0);
  assert.equal(socket.closeCalls.length, 1);
  assert.equal(socket.listenerCount, 0);
  assert.deepEqual(socket.sent, []);
  assert.equal(JSON.stringify(result), snapshot);
  assertSafe(result);
});

test('cleanup close failure does not report an entirely successful probe', async () => {
  const socket = new Socket();
  socket.close = () => { throw new Error('PRIVATE_ERROR'); };
  const fixture = setup(socket);
  const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
  assert.equal(result.https.ok, true);
  assert.equal(result.wss.ok, true);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'WEBSOCKET_CLOSE_FAILED');
  assert.equal(socket.listenerCount, 0);
  assertSafe(result);
});

test('unavailable AbortController constructor fails safely without transport calls', async t => {
  t.mock.method(globalThis, 'AbortController', function () { throw new Error('PRIVATE_ERROR'); });
  let called = false;
  const result = await probeDiscordRuntime({ fetchImpl: () => { called = true; } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ABORT_API_UNAVAILABLE');
  assert.equal(called, false);
  assertSafe(result);
});

test('listener registration failure still closes the socket and removes installed listeners', async () => {
  const socket = new Socket();
  const originalAdd = socket.addEventListener;
  socket.addEventListener = function (type, callback) {
    if (type === 'error') throw new Error('PRIVATE_ERROR');
    originalAdd.call(this, type, callback);
  };
  const fixture = setup(socket);
  const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
  assert.equal(result.error, 'WEBSOCKET_SETUP_FAILED');
  assert.equal(result.ok, false);
  assert.equal(socket.acceptCalls, 0);
  assert.equal(socket.listenerCount, 0);
  assert.equal(socket.closeCalls.length, 1);
  assertSafe(result);
});

test('an upgrade socket accessor exception returns a sanitized failed result', async () => {
  const fixture = setup(new Socket(), { upgrade: () => ({ status: 101, get webSocket() { throw new Error('PRIVATE_ERROR'); } }) });
  const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
  assert.equal(result.https.ok, true);
  assert.equal(result.wss.ok, false);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'PROBE_FAILED');
  assertSafe(result);
});

test('cleanup exceptions are sanitized while preserving separately proven transport evidence', async () => {
  const socket = new Socket();
  socket.removeEventListener = () => { throw new Error('PRIVATE_ERROR'); };
  const fixture = setup(socket);
  const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
  assert.equal(result.https.ok, true);
  assert.equal(result.wss.ok, true);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'WEBSOCKET_CLEANUP_FAILED');
  assert.equal(socket.closeCalls.length, 1);
  assertSafe(result);
});

test('fetch failure exposes only a sanitized illegal invocation category', async () => {
  const error = new TypeError('Illegal invocation: incorrect this reference PRIVATE_ERROR https://secret.example/ Authorization: Bot fixture-secret');
  error.cause = { code: 'PRIVATE_ERROR_UNALLOWLISTED' };
  const fixture = setup(new Socket(), { discovery: () => { throw error; } });
  const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
  assert.equal(result.error, 'DISCOVERY_NETWORK_ERROR');
  assert.deepEqual(result.errorDetails, { name: 'TypeError', causeCode: null, category: 'ILLEGAL_INVOCATION', diagnosticWords: ['illegal', 'invocation', 'incorrect', 'this', 'reference'] });
  assert.equal(result.https.reached, false);
  assert.equal(fixture.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|secret\.example|incorrect this reference/i);
  assertSafe(result);
});

test('fetch AbortSignal incompatibility is distinguished without leaking its message', async () => {
  const fixture = setup(new Socket(), { upgrade: () => { throw new TypeError("Failed fetch: signal is not of type 'AbortSignal'. PRIVATE_ERROR https://secret.example/token"); } });
  const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
  assert.equal(result.error, 'UPGRADE_NETWORK_ERROR');
  assert.deepEqual(result.errorDetails, { name: 'TypeError', causeCode: null, category: 'ABORT_SIGNAL_INCOMPATIBLE', diagnosticWords: ['failed', 'fetch', 'signal', 'not', 'type', 'AbortSignal'] });
  assert.equal(result.https.ok, true);
  assert.equal(result.wss.ok, false);
  assert.equal(fixture.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /Failed fetch|secret\.example|not of type/i);
  assertSafe(result);
});

test('DNS, TLS, policy and unknown failures report fixed labels and allowlisted codes only', async () => {
  for (const [name, code, message, expected] of [
    ['TypeError', 'EAI_AGAIN', 'PRIVATE_ERROR https://secret.example/token', { name: 'TypeError', causeCode: 'EAI_AGAIN', category: 'DNS_FAILURE' }],
    ['Error', 'CERT_HAS_EXPIRED', 'PRIVATE_ERROR sensitive certificate detail', { name: 'Error', causeCode: 'CERT_HAS_EXPIRED', category: 'TLS_FAILURE' }],
    ['SecurityError', 'EACCES', 'PRIVATE_ERROR sensitive policy detail', { name: 'SecurityError', causeCode: 'EACCES', category: 'NETWORK_ACCESS_DENIED' }],
    ['PRIVATE_ERROR_CUSTOM_NAME', 'PRIVATE_ERROR_CUSTOM_CODE', 'PRIVATE_ERROR totally unrecognized private detail', { name: 'UNKNOWN', causeCode: null, category: 'UNKNOWN' }],
  ]) {
    const error = new Error(message);
    error.name = name;
    error.cause = { code };
    error.stack = 'PRIVATE_ERROR sensitive stack https://secret.example/token';
    const fixture = setup(new Socket(), { discovery: () => { throw error; } });
    const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
    assert.equal(result.error, 'DISCOVERY_NETWORK_ERROR');
    assert.deepEqual(result.errorDetails, { ...expected, diagnosticWords: [] });
    assert.equal(result.https.reached, false);
    assert.equal(fixture.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /sensitive|secret\.example|unrecognized|private detail/i);
    assertSafe(result);
  }
});

test('hostile diagnostic getters cannot escape the sanitized fetch-failure result', async () => {
  const error = Object.fromEntries(['name', 'cause', 'code', 'message'].map(name => [name, undefined]));
  for (const name of ['name', 'cause', 'code', 'message']) Object.defineProperty(error, name, { get() { throw new Error('PRIVATE_ERROR'); } });
  const fixture = setup(new Socket(), { discovery: () => { throw error; } });
  const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
  assert.equal(result.error, 'DISCOVERY_NETWORK_ERROR');
  assert.deepEqual(result.errorDetails, { name: 'UNKNOWN', causeCode: null, category: 'UNKNOWN', diagnosticWords: [] });
  assertSafe(result);
});

test('default fetch wrapper uses the current runtime API without extra network calls', async t => {
  const fixture = setup();
  t.mock.method(globalThis, 'fetch', (...args) => fixture.fetchImpl(...args));
  const result = await probeDiscordRuntime({ nonce: 'default_fetch' });
  assert.equal(result.ok, true);
  assert.equal(result.errorDetails, null);
  assert.deepEqual(fixture.calls.map(call => call.url), [DISCOVERY, UPGRADE]);
  assertSafe(result);
});

test('diagnostic words preserve only dictionary API words in order with a strict sixteen-word bound', async () => {
  const message = "Failed to execute 'fetch' on 'WorkerGlobalScope': parameter 'signal' expected a supported AbortSignal object; RequestInit is invalid and this function must be called with context. PRIVATE_ERROR 20261014";
  const fixture = setup(new Socket(), { discovery: () => { throw new TypeError(message); } });
  const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
  assert.deepEqual(result.errorDetails.diagnosticWords, ['failed', 'execute', 'fetch', 'WorkerGlobalScope', 'parameter', 'signal', 'expected', 'supported', 'AbortSignal', 'object', 'RequestInit', 'invalid', 'this', 'function', 'must', 'called']);
  assert.equal(result.errorDetails.diagnosticWords.length, 16);
  assert.doesNotMatch(JSON.stringify(result), /20261014|parameter 'signal'|must be called/);
  assertSafe(result);
});

test('URL contents and every secret-label suffix cannot contribute diagnostic words', async () => {
  for (const [message, expected] of [
    ['PRIVATE_ERROR https://fetch.example/Request?signal=AbortSignal&parameter=invalid', []],
    ['PRIVATE_ERROR wss://gateway.discord.gg/fetch/Request/AbortSignal', []],
    ['PRIVATE_ERROR fetch.example/Request/AbortSignal?parameter=invalid', []],
    ['PRIVATE_ERROR fetch.example?parameter=invalid&signal=AbortSignal', []],
    ['PRIVATE_ERROR fetch.example#Request', []],
    ['PRIVATE_ERROR 127.0.0.1/fetch/Request?signal=AbortSignal', []],
    ['PRIVATE_ERROR authorization: fetch Request Response URL signal', []],
    ['PRIVATE_ERROR Bearer fetch Request Response URL signal', []],
    ['PRIVATE_ERROR cookie=fetch Request Response URL signal', []],
    ['PRIVATE_ERROR password: fetch Request Response URL signal', []],
    ['PRIVATE_ERROR secret_value=fetch Request Response URL signal', []],
    ['PRIVATE_ERROR credentials: fetch Request Response URL signal', []],
    ['PRIVATE_ERROR token=fetch Request Response URL signal', []],
    ['Invalid object. Authorization: fetch Request Response URL signal', ['invalid', 'object']],
    ['fetch failed. token: Request Response URL signal', ['fetch', 'failed']],
  ]) {
    const fixture = setup(new Socket(), { discovery: () => { throw new TypeError(message); } });
    const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
    assert.deepEqual(result.errorDetails.diagnosticWords, expected);
    assert.equal(fixture.calls.length, 1);
    assertSafe(result);
  }
});

test('unknown identifiers and numeric-suffixed tokens do not contribute dictionary substrings', async () => {
  const fixture = setup(new Socket(), { discovery: () => { throw new TypeError('PRIVATE_ERROR fetcher preRequest notallowed fetch123 signal42 context_value constructor_X'); } });
  const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
  assert.deepEqual(result.errorDetails.diagnosticWords, []);
  assertSafe(result);
});

test('manual discovery redirects are never followed or read as JSON', async () => {
  for (const status of [301, 302, 303, 304, 307, 308]) {
    let readJson = false;
    const fixture = setup(new Socket(), { discovery: () => ({
      status, redirected: false,
      headers: new Headers({ location: 'https://untrusted.example/elsewhere' }),
      json: () => { readJson = true; throw new Error('PRIVATE_ERROR'); },
    }) });
    const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
    assert.equal(result.error, 'DISCOVERY_REDIRECT_DENIED');
    assert.equal(result.https.ok, false);
    assert.equal(result.wss.upgraded, false);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].url, DISCOVERY);
    assert.equal(fixture.calls[0].options.redirect, 'manual');
    assert.equal(readJson, false);
    assert.equal(fixture.socket.acceptCalls, 0);
    assert.doesNotMatch(JSON.stringify(result), /untrusted\.example|elsewhere/);
    assertSafe(result);
  }
});

test('manual upgrade redirects reject and close any returned socket without accepting it', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const socket = new Socket();
    const fixture = setup(socket, { upgrade: () => ({
      status, redirected: false, webSocket: socket,
      headers: new Headers({ location: 'https://untrusted.example/elsewhere' }),
    }) });
    const result = await probeDiscordRuntime({ fetchImpl: fixture.fetchImpl });
    assert.equal(result.error, 'UPGRADE_REDIRECT_DENIED');
    assert.equal(result.https.ok, true);
    assert.equal(result.wss.upgraded, false);
    assert.equal(result.wss.ok, false);
    assert.deepEqual(fixture.calls.map(call => call.url), [DISCOVERY, UPGRADE]);
    assert.ok(fixture.calls.every(call => call.options.redirect === 'manual'));
    assert.equal(socket.acceptCalls, 0);
    assert.equal(socket.closeCalls.length, 1);
    assert.equal(socket.listenerCount, 0);
    assert.deepEqual(socket.sent, []);
    assert.doesNotMatch(JSON.stringify(result), /untrusted\.example|elsewhere/);
    assertSafe(result);
  }
});
