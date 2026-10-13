import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, chmodSync, lstatSync, existsSync, mkdirSync, rmSync, symlinkSync, linkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { planSetup, prepareSetup } from '../src/setup.mjs';
import { loadConfig } from '../src/config.mjs';
import { configureLine, configureDiscord } from '../src/onboarding.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
function fixture(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-setup-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}
const errorCode = code => error => error.code === code;

test('cloud plan is read-only and declares every actual cloud/PC-independent verification gate', t => {
  const cwd = fixture(t), plan = planSetup({ cwd });
  assert.equal(plan.mode, 'dot'); assert.equal(plan.target, 'dot-cloud');
  assert.deepEqual(plan.channels, ['line', 'discord']);
  assert.equal(plan.ready, false); assert.equal(plan.requirements.stablePublicHttps, true);
  assert.equal(plan.requirements.macCodexAuthTransfer, false);
  assert.equal(plan.checkpoints.length, 6);
  assert(plan.checkpoints.every(item => item.status === 'unverified'));
  assert.deepEqual(plan.performed, { networkRequests: false, processStart: false, accountChanges: false, billingChanges: false });
  assert.equal(existsSync(join(cwd, 'data')), false);
});

test('target/channel matrix produces compatible isolated configuration with indefinite pairing codes', t => {
  const cwd = fixture(t);
  for (const target of ['dot-cloud', 'local']) for (const channel of ['line', 'discord', 'both']) {
    const result = prepareSetup({ cwd, target, channel, outputDir: `data/setup/${target}-${channel}` });
    const raw = JSON.parse(readFileSync(result.paths.config, 'utf8'));
    const config = loadConfig(result.paths.config, {});
    assert.equal(config.backend, target === 'dot-cloud' ? 'dot' : 'codex');
    assert.equal(config.accounts.length, channel === 'discord' ? 0 : 1);
    assert.equal(config.discordAccounts.length, channel === 'line' ? 0 : 1);
    assert.equal(raw.channels.line.pairingCodeTtlMs, null);
    assert.equal(raw.channels.discord.pairingCodeTtlMs, null);
    assert.equal(config.transport, target === 'local' && channel === 'discord' ? 'headless' : 'http');
    assert.equal(config.dataDir, join(join(cwd, `data/setup/${target}-${channel}`), 'runtime'));
    assert.equal(config.publicUrl, ''); assert.equal(result.ready, false);
    for (const file of Object.values(result.paths)) assert.equal(lstatSync(file).mode & 0o777, 0o600);
    assert.equal(lstatSync(result.outputDir).mode & 0o777, 0o700);
  }
});

test('inbox only permits Discord and never implies automatic wakeup or public HTTP', t => {
  const cwd = fixture(t);
  for (const channel of ['line', 'both']) assert.throws(() => prepareSetup({ cwd, channel, mode: 'inbox' }), errorCode('SETUP_INBOX_REQUIRES_DISCORD_ONLY'));
  assert.throws(() => prepareSetup({ cwd, mode: 'codex' }), errorCode('SETUP_CLOUD_CODEX_UNSUPPORTED'));
  const result = prepareSetup({ cwd, channel: 'discord', mode: 'inbox' });
  assert.equal(result.automaticDotWakeup, false); assert.equal(result.requirements.stablePublicHttps, false);
  assert.equal(loadConfig(result.paths.config, {}).transport, 'headless');
  assert.match(result.checkpoints.find(item => item.id === 'runtime_capability_check').requirement, /no automatic dot wakeup/);
});

test('repeated prepare preserves private files and credentials byte-for-byte without reading them into output', t => {
  const cwd = fixture(t), first = prepareSetup({ cwd });
  const secrets = 'DISCORD_BOT_TOKEN=already-private-credential\nLINE_CHANNEL_SECRET=another-private-credential\n';
  writeFileSync(first.paths.env, secrets, { mode: 0o600 });
  const before = Object.fromEntries(Object.entries(first.paths).map(([key, path]) => [key, readFileSync(path)]));
  const repeat = prepareSetup({ cwd });
  assert.deepEqual(repeat.files, { config: 'preserved', env: 'preserved', state: 'preserved' });
  for (const [key, path] of Object.entries(first.paths)) assert.deepEqual(readFileSync(path), before[key]);
  assert(!JSON.stringify(repeat).includes('already-private-credential'));
  assert(!readFileSync(first.paths.state, 'utf8').includes('already-private-credential'));
  assert.equal(existsSync(join(cwd, '.env')), false);
});

test('generated account setup paths store both selected Bot credentials only in the prepared private env', async t => {
  const cwd = fixture(t), result = prepareSetup({ cwd }), output = [];
  const rootEnv = join(cwd, '.env'); writeFileSync(rootEnv, 'EXISTING_LOCAL_SETTING=preserved\n', { mode: 0o600 });
  for (const command of result.commands.accountSetup) {
    assert.equal(command[1], '--');
    assert.equal(command[command.indexOf('--env-path') + 1], result.paths.env);
    assert.equal(command[command.indexOf('--config') + 1], result.paths.config);
  }
  const answers = ['setup-private-line-token', 'setup-private-line-secret'];
  await configureLine({ envPath: result.paths.env, ask: async (_label, options) => { assert.equal(options.secret, true); return answers.shift(); }, write: text => output.push(text) });
  await configureDiscord({ envPath: result.paths.env, configPath: result.paths.config, ask: async (_label, options) => { assert.equal(options.secret, true); return 'setup-private-discord-token'; }, write: text => output.push(text) });
  const privateEnv = readFileSync(result.paths.env, 'utf8');
  for (const value of ['setup-private-line-token', 'setup-private-line-secret', 'setup-private-discord-token']) {
    assert(privateEnv.includes(value)); assert(!output.join('\n').includes(value)); assert(!readFileSync(result.paths.state, 'utf8').includes(value));
  }
  assert.equal(readFileSync(rootEnv, 'utf8'), 'EXISTING_LOCAL_SETTING=preserved\n');
  assert.equal(lstatSync(result.paths.env).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(result.paths.config)).channels.discord.pairingCodeTtlMs, null);
});

test('an interrupted preparation resumes from completed configuration/env without overwriting credentials', t => {
  const cwd = fixture(t), prepared = prepareSetup({ cwd, target: 'local' });
  const originalConfig = readFileSync(prepared.paths.config), originalEnv = readFileSync(prepared.paths.env);
  rmSync(prepared.paths.state);
  const resumed = prepareSetup({ cwd, target: 'local' });
  assert.deepEqual(resumed.files, { config: 'preserved', env: 'preserved', state: 'created' });
  assert.deepEqual(readFileSync(resumed.paths.env), originalEnv);
  assert.deepEqual(readFileSync(resumed.paths.config), originalConfig);
  assert.equal(JSON.parse(readFileSync(resumed.paths.state)).ready, false);
});

test('resuming preserves recorded checkpoints and semantically equal reordered state identity', t => {
  const cwd = fixture(t), first = prepareSetup({ cwd }), state = JSON.parse(readFileSync(first.paths.state, 'utf8'));
  state.identity = { paths: state.identity.paths, channel: state.identity.channel, mode: state.identity.mode, target: state.identity.target };
  state.checkpoints.find(item => item.id === 'local_account_setup').status = 'verified';
  writeFileSync(first.paths.state, JSON.stringify(state), { mode: 0o600 });
  const before = readFileSync(first.paths.state), resumed = prepareSetup({ cwd });
  assert.equal(resumed.files.state, 'preserved'); assert.equal(resumed.ready, false);
  assert.deepEqual(readFileSync(first.paths.state), before);
});

test('changing channel/mode in an existing preparation refuses a silent migration', t => {
  const cwd = fixture(t), first = prepareSetup({ cwd });
  const originalEnv = readFileSync(first.paths.env);
  assert.throws(() => prepareSetup({ cwd, channel: 'discord' }), errorCode('SETUP_EXISTING_CONFIG_CONFLICT'));
  assert.deepEqual(readFileSync(first.paths.env), originalEnv);
});

test('symlinked parent paths and private files are rejected before any writes', t => {
  const cwd = fixture(t), outside = fixture(t);
  symlinkSync(outside, join(cwd, 'data'));
  assert.throws(() => prepareSetup({ cwd }), errorCode('SETUP_UNSAFE_DIRECTORY'));
  assert.equal(existsSync(join(outside, 'setup')), false);
  rmSync(join(cwd, 'data'));
  const plan = planSetup({ cwd }); mkdirSync(plan.outputDir, { recursive: true, mode: 0o700 });
  const credential = join(outside, 'credential'); writeFileSync(credential, 'must-not-read-or-change', { mode: 0o600 });
  symlinkSync(credential, plan.paths.env);
  assert.throws(() => prepareSetup({ cwd }), errorCode('SETUP_UNSAFE_FILE'));
  assert.equal(existsSync(plan.paths.config), false);
  assert.equal(readFileSync(credential, 'utf8'), 'must-not-read-or-change');
});

test('unsafe writable parents, public-readable files, and hard links are refused', t => {
  const cwd = fixture(t), plan = planSetup({ cwd });
  mkdirSync(join(cwd, 'data'), { mode: 0o777 }); chmodSync(join(cwd, 'data'), 0o777);
  assert.throws(() => prepareSetup({ cwd }), errorCode('SETUP_UNSAFE_DIRECTORY'));
  chmodSync(join(cwd, 'data'), 0o700); mkdirSync(plan.outputDir, { recursive: true, mode: 0o700 });
  writeFileSync(plan.paths.env, 'a-private-value', { mode: 0o644 }); chmodSync(plan.paths.env, 0o644);
  assert.throws(() => prepareSetup({ cwd }), errorCode('SETUP_UNSAFE_FILE'));
  assert.equal(lstatSync(plan.paths.env).mode & 0o777, 0o644);
  chmodSync(plan.paths.env, 0o600); linkSync(plan.paths.env, join(plan.outputDir, 'another-link'));
  assert.throws(() => prepareSetup({ cwd }), errorCode('SETUP_UNSAFE_FILE'));
});

test('output overrides must remain in ignored setup storage and cannot alias one another', t => {
  const cwd = fixture(t);
  assert.throws(() => planSetup({ cwd, envPath: '.env' }), errorCode('SETUP_INVALID_OUTPUT_PATHS'));
  assert.throws(() => planSetup({ cwd, outputDir: '../outside' }), errorCode('SETUP_OUTPUT_MUST_BE_UNDER_DATA_SETUP'));
  assert.throws(() => planSetup({ cwd, configPath: 'data/setup/same', envPath: 'data/setup/same' }), errorCode('SETUP_INVALID_OUTPUT_PATHS'));
  const result = prepareSetup({ cwd, configPath: 'data/setup/custom/bridge.json', envPath: 'data/setup/custom/.env', statePath: 'data/setup/custom/state.json' });
  assert.equal(result.files.config, 'created');
});

test('invalid existing JSON emits only a safe code, never fragments of private content', t => {
  const cwd = fixture(t), plan = planSetup({ cwd });
  mkdirSync(plan.outputDir, { recursive: true, mode: 0o700 });
  writeFileSync(plan.paths.config, 'invalid private-config-credential-value', { mode: 0o600 });
  assert.throws(() => prepareSetup({ cwd }), errorCode('SETUP_INVALID_PRIVATE_JSON'));
  assert.equal(existsSync(plan.paths.env), false);
});

test('CLI setup works without loading root .env, accepts explicit private paths, and never prints owner secret', t => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, '.env'), 'LINE_CHANNEL_SECRET=do-not-load-root-env\n', { mode: 0o600 });
  const child = spawnSync(process.execPath, [cli, 'setup', 'prepare', '--target', 'local', '--channel', 'discord', '--config', 'data/setup/local/config.json', '--env-path', 'data/setup/local/.env', '--state-file', 'data/setup/local/state.json'], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' } });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout), env = readFileSync(result.paths.env, 'utf8');
  const owner = env.match(/^LINE_BRIDGE_OWNER_SECRET=(.+)$/m)[1];
  assert(owner.length >= 40); assert(!child.stdout.includes(owner));
  assert(!child.stdout.includes('do-not-load-root-env'));
  assert.equal(readFileSync(join(cwd, '.env'), 'utf8'), 'LINE_CHANNEL_SECRET=do-not-load-root-env\n');
  const bad = spawnSync(process.execPath, [cli, 'setup', 'prepare', '--mode', 'codex'], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' } });
  assert.equal(bad.status, 1); assert.equal(JSON.parse(bad.stderr).error, 'SETUP_CLOUD_CODEX_UNSUPPORTED');
});

test('actual wrapper shields CLI flags from Node and does not copy autoloaded local credentials into cloud setup', t => {
  const cwd = fixture(t), wrapper = join(cwd, 'bin', 'codex-line-bridge');
  mkdirSync(join(cwd, 'bin')); mkdirSync(join(cwd, 'src'));
  copyFileSync(fileURLToPath(new URL('../bin/codex-line-bridge', import.meta.url)), wrapper); chmodSync(wrapper, 0o755);
  // Preserve the production wrapper verbatim; its adjacent CLI resolves the real
  // source module, while its .env and cwd belong only to this private fixture.
  symlinkSync(cli, join(cwd, 'src', 'cli.mjs'));
  const secret = 'wrapper-existing-private-local-secret';
  writeFileSync(join(cwd, '.env'), `DISCORD_BOT_TOKEN=${secret}\nLINE_BRIDGE_OWNER_SECRET=${secret}\n`, { mode: 0o600 });
  const env = { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' };
  const guarded = spawnSync(wrapper, ['help', '--env-file', 'deliberately-does-not-exist'], { cwd, encoding: 'utf8', env });
  assert.equal(guarded.status, 0, guarded.stderr);
  const child = spawnSync(wrapper, ['setup', 'prepare', '--env-path', 'data/setup/dot-cloud/private.env'], { cwd, encoding: 'utf8', env });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  for (const path of Object.values(result.paths)) assert(!readFileSync(path, 'utf8').includes(secret));
  assert(!child.stdout.includes(secret));
  assert.match(readFileSync(result.paths.env, 'utf8'), /^DISCORD_BOT_TOKEN=$/m);
});
