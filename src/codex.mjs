import { spawn as spawnChild } from 'node:child_process';
import { isAbsolute } from 'node:path';

const RPC_TIMEOUT_MS = 15_000;
const MAX_PROTOCOL_LINE = 16 * 1024 * 1024;
const TURN_NOTIFICATIONS = new Set([
  'turn/started', 'turn/completed', 'item/started', 'item/completed',
  'item/agentMessage/delta', 'error',
]);

export class CodexError extends Error {
  constructor(message, code = 'CODEX_ERROR') {
    super(message);
    this.name = 'CodexError';
    this.code = code;
  }
}

/** Fail-closed responses from the Codex CLI 0.144.5 app-server schema. */
export function declineRequest(method, params = {}) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' };
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' };
    case 'item/tool/requestUserInput':
      return { answers: Object.fromEntries((params.questions ?? []).map(q => [q.id, { answers: [] }])) };
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null };
    case 'item/tool/call':
      return {
        success: false,
        contentItems: [{ type: 'inputText', text: 'This LINE bridge does not implement the requested client tool.' }],
      };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: 'denied' };
    default:
      return undefined;
  }
}

/**
 * One local stdio app-server, with independent persistent Codex threads.
 * Uses Codex's managed ChatGPT login; never reads or rewrites auth files.
 * `systemPrompt` is appended as developerInstructions, preserving Codex defaults.
 */
export class CodexBackend {
  #config;
  #logger;
  #spawn;
  #child = null;
  #ready = null;
  #closed = false;
  #sequence = 0;
  #generation = 0;
  #pending = new Map();
  #requests = new Map();
  #sessions = new Map();
  #threads = new Map();

  constructor(config, { logger, spawn = spawnChild } = {}) {
    if (!config || typeof config.command !== 'string' || !config.command) throw new TypeError('Codex command is required');
    if (!isAbsolute(config.cwd ?? '')) throw new TypeError('Codex cwd must be an absolute path');
    if (!['read-only', 'workspace-write'].includes(config.sandbox)) throw new TypeError('Unsupported Codex sandbox');
    if (config.approvalPolicy !== 'on-request') throw new TypeError('Codex approvalPolicy must be on-request');
    if (!Number.isSafeInteger(config.turnTimeoutMs) || config.turnTimeoutMs < 1) throw new TypeError('Invalid Codex turn timeout');
    if (config.model != null && (typeof config.model !== 'string' || !config.model.trim())) throw new TypeError('Invalid Codex model');
    this.#config = { ...config };
    this.#logger = logger;
    this.#spawn = spawn;
  }

  async health() {
    await this.#ensureReady();
    const result = await this.#rpc('account/read', { refreshToken: false });
    return {
      ok: true,
      authenticated: result.account?.type === 'chatgpt',
      authMode: result.account?.type ?? null,
      ...(result.account?.planType ? { planType: result.account.planType } : {}),
      requiresOpenaiAuth: Boolean(result.requiresOpenaiAuth),
    };
  }

  /** Public catalog metadata only; listing is not a guarantee of entitlement. */
  async models() {
    await this.#ensureReady();
    const models = [];
    const cursors = new Set();
    let cursor;
    do {
      const result = await this.#rpc('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) throw new CodexError('Codex returned no model catalog', 'PROTOCOL_ERROR');
      for (const item of result.data) {
        if (typeof item?.id !== 'string' || typeof item.model !== 'string' || !item.model) continue;
        models.push({
          id: item.id, model: item.model, displayName: item.displayName ?? item.model,
          isDefault: item.isDefault === true, hidden: item.hidden === true,
          inputModalities: Array.isArray(item.inputModalities) ? item.inputModalities : ['text', 'image'],
        });
      }
      cursor = result.nextCursor;
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor) || cursors.size >= 100)) {
        throw new CodexError('Invalid Codex model catalog pagination', 'PROTOCOL_ERROR');
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return models;
  }

  async run({ sessionKey, threadId, input, systemPrompt, onThread, onProgress, onRequest, signal }) {
    if (typeof sessionKey !== 'string' || !sessionKey) throw new TypeError('sessionKey is required');
    if (this.#sessions.has(sessionKey)) throw new CodexError('This session already has an active turn', 'SESSION_BUSY');
    if (!Array.isArray(input) || !input.length || input.some(item =>
      !(item?.type === 'text' && typeof item.text === 'string') &&
      !(item?.type === 'localImage' && typeof item.path === 'string' && isAbsolute(item.path)))) {
      throw new TypeError('Codex input must contain text or absolute localImage paths');
    }
    if (threadId != null && (typeof threadId !== 'string' || !threadId)) throw new TypeError('Invalid threadId');
    if (systemPrompt != null && typeof systemPrompt !== 'string') throw new TypeError('Invalid systemPrompt');
    if (signal?.aborted) throw new CodexError('Codex turn was cancelled', 'TURN_INTERRUPTED');
    let resolve, reject;
    const done = new Promise((res, rej) => { resolve = res; reject = rej; });
    const state = {
      sessionKey, threadId: null, turnId: null, onProgress, onRequest,
      messages: new Map(), settled: false, resolve, reject, done,
      cancelError: null, interruptPromise: null, progressChain: Promise.resolve(),
    };
    this.#sessions.set(sessionKey, state);
    const cancel = () => this.#cancel(state, new CodexError('Codex turn was cancelled', 'TURN_INTERRUPTED'));
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => this.#cancel(state, new CodexError('Codex turn timed out', 'TURN_TIMEOUT')), this.#config.turnTimeoutMs);
    try {
      const work = this.#run(state, { threadId, input, systemPrompt, onThread });
      // Race also cancels promptly during initialization, resume, or turn/start.
      return await Promise.race([work, done]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (this.#sessions.get(sessionKey) === state) this.#sessions.delete(sessionKey);
      if (this.#threads.get(state.threadId) === state) this.#threads.delete(state.threadId);
      this.#clearRequests(state);
    }
  }

  async #run(state, { threadId, input, systemPrompt, onThread }) {
    await this.#ensureReady();
    if (state.settled) return state.done;
    const auth = await this.#rpc('account/read', { refreshToken: false });
    if (state.settled) return state.done;
    if (auth.account?.type !== 'chatgpt') {
      throw new CodexError('Sign in to the local Codex CLI with ChatGPT before using this bridge', 'CHATGPT_LOGIN_REQUIRED');
    }
    // An inherited local CLI default can be unavailable for ChatGPT auth.
    // Explicit choices are preserved; otherwise use the server-advertised default.
    const model = this.#config.model ?? (await this.models()).find(item => item.isDefault && !item.hidden)?.model;
    if (state.settled) return state.done;
    if (!model) throw new CodexError('Codex advertised no default model; configure a model from its catalog', 'MODEL_DEFAULT_UNAVAILABLE');
    const params = {
      cwd: this.#config.cwd,
      sandbox: this.#config.sandbox,
      approvalPolicy: this.#config.approvalPolicy,
      approvalsReviewer: 'user',
      modelProvider: 'openai',
      model,
      ...(systemPrompt ? { developerInstructions: systemPrompt } : {}),
      ...(threadId ? { threadId } : {}),
    };
    const response = await this.#rpc(threadId ? 'thread/resume' : 'thread/start', params);
    if (state.settled) return state.done;
    const id = response.thread?.id;
    if (typeof id !== 'string' || !id) throw new CodexError('Codex returned no thread id', 'PROTOCOL_ERROR');
    if (this.#threads.has(id)) throw new CodexError('This Codex thread already has an active turn', 'THREAD_BUSY');
    state.threadId = id;
    this.#threads.set(id, state);
    // Persist the thread before inference so a crash cannot lose the conversation id.
    if (onThread) await onThread(id);
    if (state.settled) return state.done;
    const started = await this.#rpc('turn/start', { threadId: id, input });
    if (!started.turn?.id) throw new CodexError('Codex returned no turn id', 'PROTOCOL_ERROR');
    state.turnId ??= started.turn.id;
    if (state.cancelError) await this.#interruptState(state);
    return state.done;
  }

  async interrupt(sessionKey) {
    const state = this.#sessions.get(sessionKey);
    if (!state) return false;
    this.#cancel(state, new CodexError('Codex turn was interrupted', 'TURN_INTERRUPTED'));
    await this.#interruptState(state);
    return true;
  }

  /** Answer only a still-pending server request. No approval is inferred here. */
  answer(requestId, result) {
    const request = this.#requests.get(requestId);
    if (!request || request.generation !== this.#generation || !this.#child) return false;
    if (result === undefined) throw new TypeError('A Codex request result is required');
    this.#write({ id: requestId, result });
    this.#requests.delete(requestId);
    return true;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#child;
    if (!child) return;
    this.#failProcess(child, new CodexError('Codex backend was closed', 'BACKEND_CLOSED'));
    await new Promise(resolve => {
      if (child.exitCode != null || child.signalCode != null) return resolve();
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2_000);
      timeout.unref?.();
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
      child.stdin.end();
      child.kill('SIGTERM');
    });
  }

  #cancel(state, error) {
    if (state.settled) return;
    state.cancelError = error;
    this.#clearRequests(state);
    void this.#interruptState(state);
    this.#finish(state, error);
  }

  #interruptState(state) {
    if (!state.turnId || !state.threadId || !this.#child) return Promise.resolve();
    state.interruptPromise ??= this.#rpc('turn/interrupt', {
      threadId: state.threadId, turnId: state.turnId,
    }).catch(() => {});
    return state.interruptPromise;
  }

  #finish(state, error) {
    if (state.settled) return;
    state.settled = true;
    if (error) return state.reject(error);
    const messages = [...state.messages.values()];
    const final = messages.filter(item => item.phase === 'final_answer');
    // Older providers omit phase. Preserve only unknown-phase messages as fallback.
    const selected = final.length ? final : messages.filter(item => item.phase !== 'commentary');
    state.resolve({ threadId: state.threadId, text: selected.map(item => item.text).filter(Boolean).join('\n\n') });
  }

  #clearRequests(state) {
    for (const [id, request] of this.#requests) {
      if (request.state !== state) continue;
      this.#decline(id, request.method, request.params);
    }
  }

  #ensureReady() {
    if (this.#closed) return Promise.reject(new CodexError('Codex backend is closed', 'BACKEND_CLOSED'));
    if (this.#ready) return this.#ready;
    const generation = ++this.#generation;
    let child;
    try {
      const env = { ...process.env };
      // The chosen connection is managed ChatGPT auth, never inherited API keys.
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
      // The agent process must not inherit bridge/channel credentials for any
      // LINE account. Codex still manages its own ChatGPT login internally.
      for (const name of Object.keys(env)) if (name.startsWith('LINE_') || name.startsWith('DISCORD_')) delete env[name];
      child = this.#spawn(this.#config.command, ['app-server', '--listen', 'stdio://'], {
        cwd: this.#config.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      });
    } catch {
      return Promise.reject(new CodexError('Unable to start the Codex CLI', 'PROCESS_START_FAILED'));
    }
    this.#child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (child !== this.#child) return;
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > MAX_PROTOCOL_LINE) return this.#protocolFailure(child);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { return this.#protocolFailure(child); }
        this.#message(message);
      }
      if (buffer.length > MAX_PROTOCOL_LINE) this.#protocolFailure(child);
    });
    // Codex stderr can contain sensitive tool or auth diagnostics. Never relay it.
    child.stderr.resume();
    child.on('error', () => this.#failProcess(child, new CodexError('Unable to run the Codex CLI', 'PROCESS_START_FAILED')));
    child.on('exit', (code, signal) => {
      if (child !== this.#child) return;
      this.#logger?.warn?.({ event: 'codex_process_exit', code, signal });
      this.#failProcess(child, new CodexError('Codex app-server exited unexpectedly', 'PROCESS_EXITED'));
    });
    child.stdin.on('error', () => {
      this.#failProcess(child, new CodexError('Codex transport closed', 'TRANSPORT_ERROR'));
      child.kill('SIGTERM');
    });
    const ready = this.#rpc('initialize', {
      clientInfo: { name: 'codex_line_bridge', title: 'Codex LINE Bridge', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }).then(() => {
      if (child !== this.#child || generation !== this.#generation) throw new CodexError('Codex transport closed', 'TRANSPORT_ERROR');
      this.#write({ method: 'initialized', params: {} });
    }).catch(error => {
      this.#failProcess(child, error);
      child.kill('SIGTERM');
      throw error;
    });
    this.#ready = ready;
    return ready;
  }

  #protocolFailure(child) {
    this.#failProcess(child, new CodexError('Invalid Codex protocol message', 'PROTOCOL_ERROR'));
    child.kill('SIGTERM');
  }

  #failProcess(child, error) {
    if (this.#child !== child) return;
    this.#child = null;
    this.#ready = null;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    this.#requests.clear();
    for (const state of this.#sessions.values()) this.#finish(state, error);
  }

  #write(message) {
    if (!this.#child) throw new CodexError('Codex transport is unavailable', 'TRANSPORT_ERROR');
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #rpc(method, params) {
    const id = `line-bridge:${++this.#sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const child = this.#child;
        if (!child) return;
        this.#failProcess(child, new CodexError(`Codex ${method} did not respond`, 'RPC_TIMEOUT'));
        child.kill('SIGTERM');
      }, RPC_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#write({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  #message(message) {
    if (!message || typeof message !== 'object') return;
    if (message.method && message.id != null) return this.#serverRequest(message);
    if (message.id != null) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CodexError(message.error.message || 'Codex request failed', 'RPC_ERROR'));
      else pending.resolve(message.result ?? {});
      return;
    }
    const params = message.params ?? {};
    if (message.method === 'serverRequest/resolved') {
      this.#requests.delete(params.requestId);
      return;
    }
    // thread/resume can publish token usage for its previous turn while the
    // new thread is being persisted. Such snapshots must not bind this run.
    if (!TURN_NOTIFICATIONS.has(message.method)) return;
    const state = this.#threads.get(params.threadId);
    if (!state || state.settled) return;
    const eventTurnId = params.turnId ?? params.turn?.id;
    if (state.turnId && eventTurnId && state.turnId !== eventTurnId) return;
    if (eventTurnId) state.turnId ??= eventTurnId;
    if (message.method === 'item/started' || message.method === 'item/completed') {
      if (params.item?.type === 'agentMessage') {
        const item = params.item;
        state.messages.set(item.id, { text: item.text ?? '', phase: item.phase ?? null });
        if (message.method === 'item/completed' && item.phase === 'commentary' && item.text) this.#progress(state, item.text);
      }
    } else if (message.method === 'item/agentMessage/delta') {
      const item = state.messages.get(params.itemId) ?? { text: '', phase: null };
      item.text += params.delta ?? '';
      state.messages.set(params.itemId, item);
    } else if (message.method === 'turn/completed') {
      for (const item of params.turn?.items ?? []) {
        if (item.type === 'agentMessage') state.messages.set(item.id, { text: item.text ?? '', phase: item.phase ?? null });
      }
      if (params.turn?.status === 'completed') this.#finish(state);
      else if (params.turn?.status === 'interrupted') this.#finish(state, new CodexError('Codex turn was interrupted', 'TURN_INTERRUPTED'));
      else this.#finish(state, new CodexError(params.turn?.error?.message || 'Codex turn failed', 'TURN_FAILED'));
    } else if (message.method === 'error' && params.willRetry === false) {
      this.#finish(state, new CodexError(params.error?.message || 'Codex turn failed', 'TURN_FAILED'));
    }
  }

  #progress(state, text) {
    if (!state.onProgress) return;
    state.progressChain = state.progressChain.then(() => state.onProgress(text)).catch(() => {
      this.#logger?.warn?.({ event: 'codex_progress_delivery_failed' });
    });
  }

  #serverRequest({ id, method, params = {} }) {
    const state = this.#threads.get(params.threadId);
    if (this.#requests.has(id)) return;
    this.#requests.set(id, { method, params, state, generation: this.#generation });
    if (!state || state.settled || !state.onRequest) return this.#decline(id, method, params);
    if (params.turnId && state.turnId && params.turnId !== state.turnId) return this.#decline(id, method, params);
    Promise.resolve().then(() => state.onRequest({ requestId: id, method, params })).then(result => {
      if (result !== undefined) this.answer(id, result);
    }).catch(() => this.#decline(id, method, params));
  }

  #decline(id, method, params) {
    if (!this.#requests.has(id)) return;
    const result = declineRequest(method, params);
    try {
      if (result !== undefined) this.answer(id, result);
      else {
        this.#write({ id, error: { code: -32601, message: 'This bridge does not support that server request' } });
        this.#requests.delete(id);
      }
    } catch {
      this.#requests.delete(id);
    }
  }
}
