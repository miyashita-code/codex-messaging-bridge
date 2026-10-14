const DISCOVERY_URL = 'https://discord.com/api/v10/gateway';
const UPGRADE_URL = 'https://gateway.discord.gg/?v=10&encoding=json';
const MAX_TIMEOUT_MS = 20000;
const NONCE = /^[A-Za-z0-9_-]{0,64}$/;
const GATEWAY_URL = /^wss:\/\/gateway\.discord\.gg\/?$/;
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'NetworkError', 'SecurityError', 'NotSupportedError', 'InvalidStateError', 'DOMException']);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const ACCESS_CODES = new Set(['EACCES', 'EPERM']);
const TLS_CODES = new Set(['ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', 'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED']);
const ERROR_CODES = new Set([...DNS_CODES, ...ACCESS_CODES, ...TLS_CODES, 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']);
const DIAGNOSTIC_WORDS = ['fetch', 'Request', 'Response', 'URL', 'string', 'object', 'argument', 'parameter', 'expected', 'invalid', 'not', 'allowed', 'supported', 'function', 'defined', 'execute', 'WorkerGlobalScope', 'RequestInit', 'AbortSignal', 'signal', 'constructor', 'context', 'with', 'called', 'must', 'type', 'io', 'network', 'outbound', 'disabled', 'denied', 'unsupported', 'unavailable', 'illegal', 'invocation', 'incompatible', 'receiver', 'undefined', 'failed', 'cannot', 'requires', 'only', 'incorrect', 'reference', 'runtime', 'global', 'scope', 'access', 'this'];
const DIAGNOSTIC_BY_LOWERCASE = new Map(DIAGNOSTIC_WORDS.map(word => [word.toLowerCase(), word]));

function safeDiagnosticWords(message) {
  // Drop complete URLs before examining words or secret-label boundaries.
  // This also excludes bare domains with paths; method-like dotted strings
  // may be over-redacted deliberately, never treated as diagnostic authority.
  let redacted = message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, ' ')
    .replace(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s"'<>]*)?/gi, ' ')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#][^\s"'<>]*)?/g, ' ');
  const secretLabel = /\b(?:authorization|bearer|cookies?|passwords?|secrets?|credentials?|tokens?)(?:\b|[_-])/i.exec(redacted);
  if (secretLabel) redacted = redacted.slice(0, secretLabel.index);
  const words = [];
  // Whole ASCII alphabetic tokens only. No substring matches, numbers,
  // unknown words, original capitalization, or surrounding punctuation.
  for (const token of redacted.match(/\b[A-Za-z]+\b/g) || []) {
    const known = DIAGNOSTIC_BY_LOWERCASE.get(token.toLowerCase());
    if (known) words.push(known);
    if (words.length === 16) break;
  }
  return words;
}

// Error strings are untrusted diagnostic inputs, never returned or logged.
// Only fixed labels and explicitly allowlisted codes cross the boundary.
const safeProperty = (value, key) => { try { return value?.[key]; } catch { return undefined; } };
function safeFetchError(error) {
  const candidateName = safeProperty(error, 'name');
  const nestedCode = safeProperty(safeProperty(error, 'cause'), 'code');
  const candidateCode = ERROR_CODES.has(nestedCode) ? nestedCode : safeProperty(error, 'code');
  const causeCode = ERROR_CODES.has(candidateCode) ? candidateCode : null;
  const rawMessage = safeProperty(error, 'message');
  const message = typeof rawMessage === 'string' ? rawMessage.slice(0, 2048) : '';
  let category = 'UNKNOWN';
  if (/\billegal invocation\b|\bincompatible receiver\b|\bincorrect this reference\b/i.test(message)) category = 'ILLEGAL_INVOCATION';
  else if (/\bAbortSignal\b/i.test(message) && /incompatib|not of type|not an instance|must be|invalid|expected/i.test(message)) category = 'ABORT_SIGNAL_INCOMPATIBLE';
  else if (DNS_CODES.has(causeCode) || /\b(?:ENOTFOUND|EAI_AGAIN|getaddrinfo|dns resolution failed|name resolution failed)\b/i.test(message)) category = 'DNS_FAILURE';
  else if (ACCESS_CODES.has(causeCode) || /\b(?:network access denied|network access blocked|outbound network (?:access )?(?:denied|blocked)|egress (?:denied|blocked)|blocked by (?:network|egress) policy)\b/i.test(message)) category = 'NETWORK_ACCESS_DENIED';
  else if (TLS_CODES.has(causeCode) || /\b(?:certificate verify failed|certificate verification failed|tls handshake failed|ssl handshake failed)\b/i.test(message)) category = 'TLS_FAILURE';
  return { name: ERROR_NAMES.has(candidateName) ? candidateName : 'UNKNOWN', causeCode, category, diagnosticWords: safeDiagnosticWords(message) };
}

class ProbeFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

// This is an active-request transport check. It has no credentials, database,
// worker-environment access, Identify, heartbeat, retry, or daemon behavior.
export async function probeDiscordRuntime({ fetchImpl = (...args) => fetch(...args), timeoutMs = MAX_TIMEOUT_MS, nonce = '' } = {}) {
  const started = Date.now();
  const result = {
    probe: 'sites-discord-transport',
    nonce: typeof nonce === 'string' && NONCE.test(nonce) ? nonce : '',
    runtime: 'worker-active-request',
    runtimeVerified: false,
    uptimeVerified: false,
    ok: false,
    https: { reached: false, ok: false, status: null },
    wss: {
      upgraded: false, ok: false, status: null, hello: false,
      heartbeatIntervalMs: null, closeRequested: false, closeObserved: false,
    },
    error: null,
    errorDetails: null,
    durationMs: 0,
  };
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS || typeof nonce !== 'string' || !NONCE.test(nonce)) {
    result.error = 'INVALID_OPTIONS';
    return result;
  }

  let controller;
  try { controller = new AbortController(); }
  catch { result.error = 'ABORT_API_UNAVAILABLE'; return result; }
  let timer;
  let socket;
  let finished = false;
  let timedOut = false;
  const listeners = [];
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ProbeFailure('TIMEOUT'));
    }, timeoutMs);
  });
  const closeLateSocket = response => {
    try {
      const lateSocket = response?.webSocket;
      if (lateSocket && typeof lateSocket.close === 'function' && lateSocket.readyState !== 3) lateSocket.close(1000, 'probe expired');
    } catch { /* No raw remote errors or late result mutations. */ }
  };
  const within = (operation, onLateResult) => {
    const pending = Promise.resolve(operation);
    if (onLateResult) pending.then(value => {
      if (finished || timedOut) onLateResult(value);
    }, () => {});
    return Promise.race([pending, deadline]);
  };
  const status = response => Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null;

  try {
    let response;
    try {
      response = await within(Promise.resolve().then(() => fetchImpl(DISCOVERY_URL, {
        // workerd's Request constructor rejects redirect:'error'. Manual mode
        // plus explicit rejection preserves the no-redirect boundary.
        method: 'GET', redirect: 'manual', headers: { Accept: 'application/json' }, signal: controller.signal,
      })));
    } catch (error) {
      if (error instanceof ProbeFailure) throw error;
      result.errorDetails = safeFetchError(error);
      throw new ProbeFailure(result.errorDetails.name === 'AbortError' ? 'DISCOVERY_ABORTED' : 'DISCOVERY_NETWORK_ERROR');
    }
    result.https.status = status(response);
    result.https.reached = result.https.status !== null;
    if (response?.redirected || (result.https.status >= 300 && result.https.status < 400)) throw new ProbeFailure('DISCOVERY_REDIRECT_DENIED');
    if (result.https.status !== 200) throw new ProbeFailure('DISCOVERY_HTTP_ERROR');
    result.https.ok = true;
    let discovery;
    try { discovery = await within(Promise.resolve().then(() => response.json())); }
    catch (error) {
      if (error instanceof ProbeFailure) throw error;
      throw new ProbeFailure('DISCOVERY_JSON_INVALID');
    }
    if (!discovery || typeof discovery.url !== 'string' || !GATEWAY_URL.test(discovery.url)) throw new ProbeFailure('DISCOVERY_GATEWAY_DENIED');

    let upgraded;
    try {
      upgraded = await within(Promise.resolve().then(() => fetchImpl(UPGRADE_URL, {
        method: 'GET', redirect: 'manual', headers: { Upgrade: 'websocket' }, signal: controller.signal,
      })), closeLateSocket);
    } catch (error) {
      if (error instanceof ProbeFailure) throw error;
      result.errorDetails = safeFetchError(error);
      throw new ProbeFailure(result.errorDetails.name === 'AbortError' ? 'UPGRADE_ABORTED' : 'UPGRADE_NETWORK_ERROR');
    }
    result.wss.status = status(upgraded);
    // Capture any returned socket before validating the response, so failure
    // cleanup also closes an inconsistent/redirected upgrade response.
    socket = upgraded?.webSocket;
    if (upgraded?.redirected || (result.wss.status >= 300 && result.wss.status < 400)) throw new ProbeFailure('UPGRADE_REDIRECT_DENIED');
    if (result.wss.status !== 101) throw new ProbeFailure('UPGRADE_HTTP_ERROR');
    if (!socket || !['accept', 'addEventListener', 'removeEventListener', 'close'].every(name => typeof socket[name] === 'function')) throw new ProbeFailure('WEBSOCKET_API_UNAVAILABLE');
    result.wss.upgraded = true;

    const hello = new Promise((resolve, reject) => {
      const listen = (type, callback) => {
        socket.addEventListener(type, callback);
        listeners.push([type, callback]);
      };
      try {
        listen('message', event => {
          if (finished) return;
          let packet;
          try {
            if (typeof event.data !== 'string' || event.data.length > 4096) throw new Error();
            packet = JSON.parse(event.data);
          } catch { reject(new ProbeFailure('GATEWAY_MESSAGE_INVALID')); return; }
          if (!packet || packet.op !== 10) { reject(new ProbeFailure('GATEWAY_EVENT_UNEXPECTED')); return; }
          const interval = packet.d?.heartbeat_interval;
          if (!Number.isSafeInteger(interval) || interval <= 0) { reject(new ProbeFailure('GATEWAY_HELLO_INVALID')); return; }
          resolve(interval);
        });
        listen('error', () => { if (!finished) reject(new ProbeFailure('WEBSOCKET_ERROR')); });
        listen('close', () => {
          if (finished) return;
          result.wss.closeObserved = true;
          reject(new ProbeFailure('WEBSOCKET_CLOSED_BEFORE_HELLO'));
        });
        // Listen before accepting, including runtimes that emit immediately.
        socket.accept();
      } catch { reject(new ProbeFailure('WEBSOCKET_SETUP_FAILED')); }
    });
    result.wss.heartbeatIntervalMs = await within(hello);
    result.wss.hello = true;
    result.wss.ok = true;
    result.ok = true;
  } catch (error) {
    result.error = timedOut ? 'TIMEOUT' : error instanceof ProbeFailure ? error.code : 'PROBE_FAILED';
  } finally {
    finished = true;
    clearTimeout(timer);
    controller.abort();
    if (socket) {
      try {
        if (socket.readyState === 3) result.wss.closeObserved = true;
        else if (typeof socket.close === 'function') {
          result.wss.closeRequested = true;
          socket.close(1000, 'probe complete');
          if (socket.readyState === 3) result.wss.closeObserved = true;
        }
      } catch {
        result.ok = false;
        result.error ||= 'WEBSOCKET_CLOSE_FAILED';
      }
      for (const [type, callback] of listeners) {
        try { socket.removeEventListener(type, callback); }
        catch { result.ok = false; result.error ||= 'WEBSOCKET_CLEANUP_FAILED'; }
      }
    }
    result.durationMs = Math.max(0, Date.now() - started);
  }
  return result;
}
