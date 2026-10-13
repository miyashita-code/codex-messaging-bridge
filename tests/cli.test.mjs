import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const line = { channelAccessToken: 'cli-fake-line-token', channelSecret: 'cli-fake-line-secret' };
const discord = { token: 'cli-fake-discord-token' };
const lineRules = [
  { url: 'https://api.line.me/v2/bot/info', body: { displayName: 'Test bridge' } },
  { url: 'https://api.line.me/v2/bot/channel/webhook/endpoint', body: { endpoint: 'https://example.com/line/webhook', active: true } },
];
const discordRules = [
  { url: 'https://discord.com/api/v10/users/@me', body: { id: '100', username: 'test-bridge' } },
  { url: 'https://discord.com/api/v10/oauth2/applications/@me', body: { id: '100', flags: 0 } },
];

function runStatus(t, channels, args, rules = []) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-cli-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json'), preloadPath = join(dir, 'fetch.mjs'), callsPath = join(dir, 'calls.json');
  writeFileSync(configPath, JSON.stringify({ backend: 'inbox', transport: channels.line ? 'http' : 'headless', channels }));
  // Replace fetch at the subprocess boundary: no real API, local .env, or inherited credentials are used.
  writeFileSync(preloadPath, `
    import { writeFileSync } from 'node:fs';
    const rules = ${JSON.stringify(rules)}, calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push(String(url));
      writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
      const rule = rules.find(item => item.url === String(url) &&
        (!item.authorization || item.authorization === init.headers.Authorization));
      if (!rule) throw new Error('Simulated network failure');
      return new Response(JSON.stringify(rule.body ?? {}), { status: rule.status ?? 200 });
    };
  `);
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, cli, '--config', configPath, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.stderr, '');
  return {
    exit: child.status, checks: JSON.parse(child.stdout),
    calls: existsSync(callsPath) ? JSON.parse(readFileSync(callsPath, 'utf8')) : [],
  };
}

test('doctor without --probe preserves credential-presence checks without making network requests', t => {
  const result = runStatus(t, { line, discord }, ['doctor']);
  assert.equal(result.exit, 0);
  assert.equal(result.checks.ready, true);
  assert.equal(result.checks.line[0].probe, undefined);
  assert.equal(result.checks.discord[0].probe, undefined);
  assert.deepEqual(result.calls, []);
});

test('doctor --probe fails when Discord refuses a present token even if LINE succeeds', t => {
  const result = runStatus(t, { line, discord }, ['doctor', '--probe'], [
    ...lineRules, { ...discordRules[0], status: 401 },
  ]);
  assert.equal(result.exit, 1);
  assert.equal(result.checks.ready, false);
  assert.equal(result.checks.line[0].probe.ok, true);
  assert.deepEqual(result.checks.discord[0].probe, { ok: false, code: 'HTTP_ERROR', status: 401 });
});

test('channels status --probe fails when LINE webhook discovery fails after a successful bot lookup', t => {
  const result = runStatus(t, { line, discord }, ['channels', 'status', '--probe'], [
    lineRules[0], { ...lineRules[1], status: 403 }, ...discordRules,
  ]);
  assert.equal(result.exit, 1);
  assert.equal(result.checks.ready, false);
  assert.deepEqual(result.checks.line[0].probe, { ok: false, code: 'HTTP_ERROR', status: 403 });
  assert.equal(result.checks.discord[0].probe.ok, true);
});

test('--probe requires every enabled account and reports a failed network lookup', t => {
  const result = runStatus(t, {
    discord: { accounts: { default: discord, second: { token: 'cli-fake-second-token' }, disabled: { enabled: false } } },
  }, ['doctor', '--probe'], discordRules.map(rule => ({ ...rule, authorization: `Bot ${discord.token}` })));
  assert.equal(result.exit, 1);
  assert.equal(result.checks.ready, false);
  assert.equal(result.checks.discord.length, 2);
  assert.equal(result.checks.discord[0].probe.ok, true);
  assert.deepEqual(result.checks.discord[1].probe, { ok: false, code: 'NETWORK_ERROR', status: 0 });
});

test('--probe succeeds only after all enabled LINE and Discord probes succeed', t => {
  const result = runStatus(t, { line, discord }, ['doctor', '--probe'], [...lineRules, ...discordRules]);
  assert.equal(result.exit, 0);
  assert.equal(result.checks.ready, true);
  assert.equal(result.checks.line[0].probe.ok, true);
  assert.equal(result.checks.discord[0].probe.ok, true);
  assert.equal(result.calls.length, 4);
});

test('--probe fails for missing credentials before any network request', t => {
  const result = runStatus(t, { line: {}, discord: {} }, ['doctor', '--probe']);
  assert.equal(result.exit, 1);
  assert.equal(result.checks.ready, false);
  assert.deepEqual(result.checks.line[0].probe, { ok: false, code: 'credentials_missing' });
  assert.deepEqual(result.checks.discord[0].probe, { ok: false, code: 'credentials_missing' });
  assert.deepEqual(result.calls, []);
});
