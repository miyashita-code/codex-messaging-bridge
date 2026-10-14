const WINDOW_MS = 45000;
const FRAME_MS = 5000;
const CSP_NONCE = /^[A-Za-z0-9_-]{20,64}$/;

// The index routes own expiry, owner and Origin checks. This helper has no
// credentials, environment bindings, external requests or detached lifetime.
export function createKeeperProbeSocket({ WebSocketPairImpl = globalThis.WebSocketPair, ResponseImpl = Response } = {}) {
  const unavailable = () => {
    const body = JSON.stringify({ error: 'KEEPER_WEBSOCKET_UNAVAILABLE' });
    const init = { status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } };
    try { if (typeof ResponseImpl === 'function') return new ResponseImpl(body, init); } catch { /* safe native fallback */ }
    return new Response(body, init);
  };
  let server;
  let heartbeat;
  let deadline;
  let ended = false;
  const listeners = [];
  const cleanup = () => {
    clearInterval(heartbeat);
    clearTimeout(deadline);
    for (const [type, callback] of listeners) {
      try { server.removeEventListener(type, callback); } catch { /* no diagnostic contents */ }
    }
    listeners.length = 0;
  };
  const finish = (code = 1000, reason = 'probe window complete') => {
    if (ended) return;
    ended = true;
    cleanup();
    try { if (server?.readyState !== 3) server?.close(code, reason); } catch { /* bounded connection only */ }
  };
  try {
    if (typeof WebSocketPairImpl !== 'function' || typeof ResponseImpl !== 'function') return unavailable();
    const pair = new WebSocketPairImpl();
    const client = pair[0];
    server = pair[1];
    if (!client || !server || !['accept', 'send', 'close', 'addEventListener', 'removeEventListener'].every(name => typeof server[name] === 'function')) throw new Error();
    const sessionId = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    let seq = 0;
    const listen = (type, callback) => { server.addEventListener(type, callback); listeners.push([type, callback]); };
    // Explicit close is safe both with and without workerd's auto-reciprocal
    // Close compatibility flag. It does not create a replacement connection.
    listen('close', () => finish(1000, 'probe stopped'));
    listen('error', () => finish(1000, 'probe stopped'));
    // The diagnostic is receive-only on its browser side. Never echo input.
    listen('message', () => finish(1008, 'probe accepts no client payloads'));
    server.accept();
    if (ended) throw new Error();
    const response = new ResponseImpl(null, { status: 101, webSocket: client });
    const frame = () => {
      if (ended) return;
      try { server.send(JSON.stringify({ sessionId, nonce, serverTime: Date.now(), seq: seq++ })); }
      catch { finish(1000, 'probe stopped'); }
    };
    deadline = setTimeout(() => finish(), WINDOW_MS);
    heartbeat = setInterval(frame, FRAME_MS);
    frame();
    if (ended) throw new Error();
    return response;
  } catch {
    finish(1000, 'probe stopped');
    return unavailable();
  }
}

export function keeperProbePage({ cspNonce } = {}) {
  if (typeof cspNonce !== 'string' || !CSP_NONCE.test(cspNonce)) throw new TypeError('INVALID_CSP_NONCE');
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>クラウド接続の短時間テスト</title>
<style nonce="${cspNonce}">body{max-width:850px;margin:32px auto;padding:0 20px;font:16px/1.7 system-ui,sans-serif;color:#17202a;background:#f8fafc}h1{font-size:25px}button{padding:10px 18px;margin:8px 8px 8px 0;border:1px solid #64748b;border-radius:8px;font:inherit}button:enabled{cursor:pointer}#status{font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:white;border:1px solid #cbd5e1;border-radius:8px;font-size:13px}small{color:#475569}</style></head>
<body><h1>クラウド接続の短時間テスト</h1>
<p>この画面と本人用SiteのWebSocket接続を、最大2回・各45秒確認します。100秒以内に終了します。Botや外部サービスには接続しません。</p>
<p><small>この結果だけでは、常駐・再起動後の復旧・Mac停止時の動作は確認できません。</small></p>
<button id="start" type="button">接続テストを開始</button><button id="stop" type="button" disabled>接続テストを停止</button>
<p id="status" role="status" aria-live="polite">待機中。開始ボタンでテストを実行します。</p>
<h2>受信した診断フレーム</h2><pre id="frames" role="log" aria-label="受信した診断フレーム">まだ受信していません。</pre>
<h2>検証結果</h2><pre id="result" aria-label="検証結果">未実行</pre>
<script nonce="${cspNonce}">
(() => {
  const start = document.getElementById('start');
  const stop = document.getElementById('stop');
  const status = document.getElementById('status');
  const frames = document.getElementById('frames');
  const result = document.getElementById('result');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const STORAGE = 'codex-bridge-keeper-probe-v1';
  let socket = null;
  let globalTimer = null;
  let nextTimer = null;
  let active = false;
  let generation = 0;
  let state = null;
  function render() {
    frames.textContent = state?.frames.length ? state.frames.map(frame => JSON.stringify(frame)).join('\\n') : 'まだ受信していません。';
    result.textContent = state ? JSON.stringify(state, null, 2) : '未実行';
  }
  function finish(reason) {
    if (!active) return;
    active = false;
    clearTimeout(globalTimer);
    clearTimeout(nextTimer);
    state.finishedAt = Date.now();
    state.reason = reason;
    state.runtimeVerified = false;
    state.uptimeVerified = false;
    state.completedWindows = state.connections.filter(connection => connection.reason === 'server_window_complete').length;
    try { if (socket && socket.readyState !== 3) socket.close(1000, 'probe stopped'); } catch {}
    socket = null;
    start.disabled = false;
    stop.disabled = true;
    status.textContent = reason === 'two_windows_complete' ? '2回の短時間テストが終了しました。' : 'テストを終了しました。';
    render();
    try { localStorage.setItem(STORAGE, JSON.stringify(state)); } catch {}
  }
  function connect(currentGeneration) {
    if (!active || currentGeneration !== generation || state.connections.length >= 2) return;
    const connection = { attempt: state.connections.length + 1, startedAt: Date.now(), openedAt: null, closedAt: null, sessionId: null, nonce: null, frames: 0, lastSeq: -1, closeCode: null, reason: null };
    state.connections.push(connection);
    const endpoint = new URL('/runtime/keeper-socket', location.href);
    if (endpoint.origin !== location.origin || endpoint.protocol !== 'https:') { finish('https_required'); return; }
    endpoint.protocol = 'wss:';
    let ownSocket;
    try { ownSocket = new WebSocket(endpoint.href); socket = ownSocket; } catch { finish('connection_failed'); return; }
    const current = () => active && currentGeneration === generation && socket === ownSocket;
    ownSocket.addEventListener('open', () => { if (!current()) return; connection.openedAt = Date.now(); status.textContent = '接続 ' + connection.attempt + '/2：診断フレームを受信中です。'; render(); });
    ownSocket.addEventListener('message', event => {
      if (!current()) return;
      let packet;
      try {
        if (typeof event.data !== 'string' || event.data.length > 512) throw new Error();
        packet = JSON.parse(event.data);
        if (!packet || Object.keys(packet).sort().join(',') !== 'nonce,seq,serverTime,sessionId' || !UUID.test(packet.sessionId) || !UUID.test(packet.nonce) || !Number.isSafeInteger(packet.serverTime) || packet.serverTime < 0 || !Number.isSafeInteger(packet.seq) || packet.seq < 0 || packet.seq > 10) throw new Error();
        if (connection.sessionId === null) { if (packet.seq !== 0) throw new Error(); connection.sessionId = packet.sessionId; connection.nonce = packet.nonce; }
        if (packet.sessionId !== connection.sessionId || packet.nonce !== connection.nonce || packet.seq !== connection.lastSeq + 1 || state.frames.length >= 24) throw new Error();
      } catch { finish('invalid_frame'); return; }
      connection.lastSeq = packet.seq;
      connection.frames++;
      state.frames.push({ attempt: connection.attempt, ...packet });
      render();
    });
    ownSocket.addEventListener('error', () => { if (current()) finish('connection_failed'); });
    ownSocket.addEventListener('close', event => {
      if (!current()) return;
      connection.closedAt = Date.now();
      connection.closeCode = Number.isInteger(event.code) && event.code >= 0 && event.code <= 4999 ? event.code : null;
      const complete = event.code === 1000 && event.reason === 'probe window complete' && connection.frames > 0 && connection.openedAt !== null && connection.closedAt - connection.openedAt >= 40000;
      connection.reason = complete ? 'server_window_complete' : 'unexpected_close';
      socket = null;
      render();
      if (!complete) { finish('unexpected_close'); return; }
      if (connection.attempt === 2) { finish('two_windows_complete'); return; }
      nextTimer = setTimeout(() => connect(currentGeneration), 250);
    });
  }
  start.addEventListener('click', () => {
    if (active) return;
    generation++;
    active = true;
    state = { version: 1, startedAt: Date.now(), finishedAt: null, reason: null, runtimeVerified: false, uptimeVerified: false, completedWindows: 0, connections: [], frames: [] };
    start.disabled = true;
    stop.disabled = false;
    status.textContent = '接続テストを開始しています。';
    render();
    globalTimer = setTimeout(() => finish('time_limit'), 100000);
    connect(generation);
  });
  stop.addEventListener('click', () => finish('user_stopped'));
  addEventListener('pagehide', () => finish('page_closed'));
})();
</script></body></html>`;
}
