import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createKeeperProbeSocket, keeperProbePage } from '../worker/keeper-probe.js';

class Socket {
  constructor() { this.readyState = 1; this.sent = []; this.closed = []; this.listeners = new Map(); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, event = {}) { for (const listener of [...(this.listeners.get(type) || [])]) listener(event); }
  accept() {}
  send(frame) { this.sent.push(frame); }
  close(code, reason) { this.closed.push({ code, reason }); this.readyState = 3; this.emit('close', { code, reason }); }
  get listenerCount() { return [...this.listeners.values()].reduce((count, set) => count + set.size, 0); }
}
function serverFixture(server = new Socket()) {
  const client = new Socket();
  class Pair { constructor() { return { 0: client, 1: server }; } }
  class ResponseMock { constructor(body, init) { this.body = body; Object.assign(this, init); } }
  return { server, client, Pair, ResponseMock, options: { WebSocketPairImpl: Pair, ResponseImpl: ResponseMock } };
}
const nonce = 'abcdefghijklmno0123456789';
const uuidA = '11111111-1111-4111-8111-111111111111';
const uuidB = '22222222-2222-4222-8222-222222222222';

test('server emits only bounded non-secret diagnostic frames and closes at forty-five seconds', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 });
  const fixture = serverFixture();
  const response = createKeeperProbeSocket(fixture.options);
  assert.equal(response.status, 101);
  assert.equal(response.webSocket, fixture.client);
  assert.equal(fixture.server.sent.length, 1);
  t.mock.timers.tick(5000);
  assert.equal(fixture.server.sent.length, 2);
  t.mock.timers.tick(39999);
  assert.equal(fixture.server.closed.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(fixture.server.closed, [{ code: 1000, reason: 'probe window complete' }]);
  assert.equal(fixture.server.listenerCount, 0);
  const packets = fixture.server.sent.map(raw => JSON.parse(raw));
  assert.ok(packets.length <= 10);
  assert.ok(packets.every((packet, seq) => Object.keys(packet).sort().join(',') === 'nonce,seq,serverTime,sessionId' && packet.seq === seq && packet.sessionId === packets[0].sessionId && packet.nonce === packets[0].nonce));
  const count = fixture.server.sent.length;
  t.mock.timers.tick(100000);
  assert.equal(fixture.server.sent.length, count);
});

test('client payload, disconnect and error close the bounded socket and clear future frames', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 });
  for (const event of ['message', 'close', 'error']) {
    const fixture = serverFixture();
    createKeeperProbeSocket(fixture.options);
    fixture.server.emit(event, { data: 'untrusted input must never be echoed' });
    const count = fixture.server.sent.length;
    t.mock.timers.tick(100000);
    assert.equal(fixture.server.sent.length, count);
    assert.equal(fixture.server.listenerCount, 0);
    if (event === 'message') assert.deepEqual(fixture.server.closed, [{ code: 1008, reason: 'probe accepts no client payloads' }]);
    if (event === 'close') assert.equal(fixture.server.closed.length, 1);
  }
});

test('unavailable pair and setup/send exceptions return safe failure with no surviving timers', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 });
  assert.equal(createKeeperProbeSocket({ WebSocketPairImpl: undefined }).status, 503);
  for (const failingMethod of ['accept', 'send', 'addEventListener']) {
    const fixture = serverFixture();
    fixture.server[failingMethod] = () => { throw new Error('sensitive setup detail'); };
    const response = createKeeperProbeSocket(fixture.options);
    assert.equal(response.status, 503);
    assert.doesNotMatch(response.body, /sensitive/);
    assert.equal(fixture.server.closed.length, 1);
    assert.equal(fixture.server.listenerCount, 0);
    t.mock.timers.tick(100000);
    assert.equal(fixture.server.sent.length, 0);
  }
});

test('an unsupported 101 response constructor closes the owned socket before safe 503', () => {
  const fixture = serverFixture();
  class ResponseMock { constructor(body, init) { if (init.status === 101) throw Error('sensitive constructor detail'); this.body = body; Object.assign(this, init); } }
  const response = createKeeperProbeSocket({ ...fixture.options, ResponseImpl: ResponseMock });
  assert.equal(response.status, 503);
  assert.equal(fixture.server.closed.length, 1);
  assert.equal(fixture.server.listenerCount, 0);
  assert.doesNotMatch(response.body, /sensitive/);
});

test('pair constructor and Response API failures still return sanitized native 503', async () => {
  class BrokenPair { constructor() { throw Error('sensitive pair detail'); } }
  class BrokenResponse { constructor() { throw Error('sensitive response detail'); } }
  const response = createKeeperProbeSocket({ WebSocketPairImpl: BrokenPair, ResponseImpl: BrokenResponse });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'KEEPER_WEBSOCKET_UNAVAILABLE' });
});

test('page requires a safe CSP nonce and exposes explicit Japanese start/stop controls', () => {
  for (const cspNonce of ['', 'short', 'x'.repeat(65), '12345678901234567890"<script>', null]) assert.throws(() => keeperProbePage({ cspNonce }), /INVALID_CSP_NONCE/);
  const html = keeperProbePage({ cspNonce: nonce });
  assert.ok(html.includes('<script nonce="' + nonce + '">'));
  assert.ok(html.includes('接続テストを開始'));
  assert.ok(html.includes('接続テストを停止'));
  assert.doesNotMatch(html, /Bearer|Authorization|DISCORD_BOT_TOKEN|COMPANION_SHARED_KEY|https:\/\//);
});

function browserFixture() {
  const elements = Object.fromEntries(['start', 'stop', 'status', 'frames', 'result'].map(id => [id, { textContent: '', disabled: false, handlers: new Map(), addEventListener(type, handler) { this.handlers.set(type, handler); } }]));
  const sockets = [];
  const pageHandlers = new Map();
  const stored = new Map();
  class BrowserSocket extends Socket {
    constructor(url) { super(); this.url = url; this.readyState = 0; sockets.push(this); }
    open() { this.readyState = 1; this.emit('open'); }
  }
  const html = keeperProbePage({ cspNonce: nonce });
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    document: { getElementById: id => elements[id] },
    addEventListener: (type, handler) => pageHandlers.set(type, handler),
    location: new URL('https://owned-private.example/runtime/keeper-probe'),
    WebSocket: BrowserSocket, URL, Date, setTimeout, clearTimeout,
    localStorage: { setItem: (key, value) => stored.set(key, value) },
  });
  return { elements, sockets, pageHandlers, stored, click: id => elements[id].handlers.get('click')(), result: () => JSON.parse(elements.result.textContent) };
}
const sendPacket = (socket, seq, sessionId = uuidA, nonceValue = uuidB) => socket.emit('message', { data: JSON.stringify({ sessionId, nonce: nonceValue, serverTime: Date.now(), seq }) });

test('UI starts only on the button, performs at most two bounded windows and stores no account data', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const browser = browserFixture();
  assert.equal(browser.sockets.length, 0);
  browser.click('start');
  browser.click('start');
  assert.equal(browser.sockets.length, 1);
  assert.equal(browser.sockets[0].url, 'wss://owned-private.example/runtime/keeper-socket');
  browser.sockets[0].open(); sendPacket(browser.sockets[0], 0);
  t.mock.timers.tick(45000);
  browser.sockets[0].emit('close', { code: 1000, reason: 'probe window complete' });
  t.mock.timers.tick(250);
  assert.equal(browser.sockets.length, 2);
  browser.sockets[1].open(); sendPacket(browser.sockets[1], 0, uuidB, uuidA);
  t.mock.timers.tick(45000);
  browser.sockets[1].emit('close', { code: 1000, reason: 'probe window complete' });
  t.mock.timers.tick(200000);
  assert.equal(browser.sockets.length, 2);
  const result = browser.result();
  assert.equal(result.reason, 'two_windows_complete');
  assert.equal(result.completedWindows, 2);
  assert.equal(result.runtimeVerified, false);
  assert.equal(result.uptimeVerified, false);
  assert.equal(browser.stored.size, 1);
  assert.doesNotMatch([...browser.stored.values()][0], /Bearer|Authorization|cookie|owner|token|PRIVATE_ERROR/i);
});

test('stop, pagehide and global limit close the current client with no second attempt', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  for (const action of ['stop', 'pagehide', 'limit']) {
    const browser = browserFixture(); browser.click('start'); browser.sockets[0].open(); sendPacket(browser.sockets[0], 0);
    if (action === 'stop') browser.click('stop');
    else if (action === 'pagehide') browser.pageHandlers.get('pagehide')();
    else t.mock.timers.tick(100000);
    t.mock.timers.tick(200000);
    assert.equal(browser.sockets.length, 1);
    assert.equal(browser.sockets[0].closed.length, 1);
    assert.equal(browser.result().completedWindows, 0);
    assert.equal(browser.result().reason, action === 'stop' ? 'user_stopped' : action === 'pagehide' ? 'page_closed' : 'time_limit');
  }
});

test('unexpected close, invalid packet and server-session changes terminate without retry', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  for (const action of ['close', 'invalid', 'session']) {
    const browser = browserFixture(); browser.click('start'); browser.sockets[0].open(); sendPacket(browser.sockets[0], 0);
    if (action === 'close') browser.sockets[0].emit('close', { code: 1006, reason: 'sensitive server detail' });
    else if (action === 'invalid') browser.sockets[0].emit('message', { data: '{"sensitive":"PRIVATE_ERROR"}' });
    else sendPacket(browser.sockets[0], 1, uuidB, uuidA);
    t.mock.timers.tick(200000);
    assert.equal(browser.sockets.length, 1);
    assert.equal(browser.result().completedWindows, 0);
    assert.doesNotMatch(browser.elements.result.textContent, /sensitive|PRIVATE_ERROR/);
  }
});
