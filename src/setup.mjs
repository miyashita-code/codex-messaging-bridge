import { constants, lstatSync, realpathSync, mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const inside = (base, path) => { const part = relative(base, path); return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const stat = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

export function setupOptions(options = {}) {
  const target = options.target ?? 'dot-cloud', channel = options.channel ?? 'both';
  const mode = options.mode ?? (target === 'local' ? 'codex' : 'dot');
  if (!['dot-cloud', 'local'].includes(target)) fail('SETUP_INVALID_TARGET');
  if (!['line', 'discord', 'both'].includes(channel)) fail('SETUP_INVALID_CHANNEL');
  if (!['dot', 'inbox', 'codex'].includes(mode)) fail('SETUP_INVALID_MODE');
  if (target === 'dot-cloud' && mode === 'codex') fail('SETUP_CLOUD_CODEX_UNSUPPORTED');
  if (mode === 'inbox' && channel !== 'discord') fail('SETUP_INBOX_REQUIRES_DISCORD_ONLY');
  const cwd = realpathSync(options.cwd ?? process.cwd()), privateRoot = join(cwd, 'data', 'setup');
  const outputDir = resolve(cwd, options.outputDir ?? join('data', 'setup', target));
  if (!inside(privateRoot, outputDir)) fail('SETUP_OUTPUT_MUST_BE_UNDER_DATA_SETUP');
  const paths = {
    config: resolve(cwd, options.configPath ?? join(outputDir, 'bridge.config.json')),
    env: resolve(cwd, options.envPath ?? join(outputDir, '.env')),
    state: resolve(cwd, options.statePath ?? join(outputDir, 'setup-state.json')),
  };
  if (Object.values(paths).some(path => !inside(privateRoot, path)) || new Set(Object.values(paths)).size !== 3) fail('SETUP_INVALID_OUTPUT_PATHS');
  return { target, channel, mode, cwd, outputDir, paths, privateRoot };
}

function gates({ target, channel, mode }) {
  const cloud = target === 'dot-cloud', line = channel !== 'discord', dot = mode === 'dot';
  return [
    { id: 'cloud_preflight', status: cloud ? 'unverified' : 'not_required', actor: 'cloud', requirement: 'Verify Node >=22.13, SQLite, outbound HTTPS/WSS, persistent storage, and a runtime that survives inactive chats. cloud-check alone does not prove uptime.' },
    { id: 'local_account_setup', status: 'unverified', actor: 'local', requirement: `${line ? 'Create or reuse the LINE Official Account and enable Messaging API in Official Account Manager. ' : ''}${channel !== 'line' ? 'Create or reuse the Discord Application/Bot and configure required intents and invitation. ' : ''}Use the available authorized local browser/computer; passwords, SMS, CAPTCHA or terms may require user interaction under its rules.` },
    { id: 'secure_handoff', status: cloud ? 'unverified' : 'not_required', actor: 'local_to_cloud', requirement: 'Move only the selected bot credentials through an authorized encrypted secret/file transfer into the cloud private env file. Never put secrets in chat, repository, state JSON or command output; never copy Mac Codex authentication.' },
    { id: 'runtime_capability_check', status: 'unverified', actor: cloud ? 'cloud' : 'local', requirement: `${line || dot ? 'Verify a stable public HTTPS origin and inbound routing. ' : ''}${dot ? 'Verify OAuth consent, MCP Events subscription, signed callback delivery and renewal. ' : ''}${mode === 'inbox' ? 'Inbox has no automatic dot wakeup; verify manual inbox read/reply and continuous Discord Gateway connectivity. ' : ''}${mode === 'codex' ? 'Authenticate Codex on this local host using the existing user login. ' : ''}${cloud ? 'Verify persistent supervision and uptime; do not silently move the runtime to a laptop if unavailable.' : 'Verify local startup and understand that this PC must remain powered on and awake.'}` },
    { id: 'real_message_e2e', status: 'unverified', actor: cloud ? 'cloud_and_local' : 'local', requirement: 'Send a new real message to each selected Bot, approve the owner pairing, verify the actual reply and conversation continuity after a gateway restart. Webhook Verify, doctor and mocks alone do not prove E2E.' },
    { id: 'pc_independence', status: cloud ? 'unverified' : 'not_applicable', actor: 'user_and_cloud', requirement: cloud ? 'Identify all local bridge dependencies, temporarily isolate only owned local services/resources with rollback, and verify another real Bot reply from the cloud. Record the exact isolation scope. Literal PC-off operation requires a separate user-authorized shutdown/sleep test; never disrupt unrelated services to obtain proof.' : 'A local runtime stops receiving/responding while this PC is off or asleep; autostart resumes after login.' },
  ];
}

export function planSetup(input = {}) {
  const options = setupOptions(input), { target, channel, mode, paths, outputDir } = options;
  const channels = channel === 'both' ? ['line', 'discord'] : [channel];
  return {
    schemaVersion: 1, action: 'plan', target, channels, mode, outputDir, paths,
    ready: false, verification: 'unverified', automaticDotWakeup: mode === 'dot' ? 'requires_verified_mcp_events' : false,
    requirements: { stablePublicHttps: channel !== 'discord' || mode === 'dot', persistentRuntime: true, persistentStorage: true, macCodexAuthTransfer: false, separateHostingGuaranteedUnnecessary: false },
    checkpoints: gates(options),
    commands: {
      runtimePreflight: ['node', '--', join(sourceRoot, 'src/cli.mjs'), 'cloud-check'],
      accountSetup: channels.map(item => ['node', '--', join(sourceRoot, 'src/cli.mjs'), 'channels', 'add', '--channel', item, '--config', paths.config, '--env-path', paths.env]),
      doctor: ['node', `--env-file=${paths.env}`, '--', join(sourceRoot, 'src/cli.mjs'), 'doctor', '--probe', '--config', paths.config],
      gatewayAfterVerifiedSetup: ['node', `--env-file=${paths.env}`, '--', join(sourceRoot, 'src/cli.mjs'), 'gateway', '--config', paths.config],
    },
    performed: { networkRequests: false, processStart: false, accountChanges: false, billingChanges: false },
  };
}

function validateDirectory(path) {
  const info = stat(path);
  if (info && (info.isSymbolicLink() || !info.isDirectory() || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || (info.mode & 0o022))) fail('SETUP_UNSAFE_DIRECTORY');
  return info;
}

function validateFile(path) {
  const info = stat(path);
  if (info && (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || (info.mode & 0o077))) fail('SETUP_UNSAFE_FILE');
  return info;
}

function inspectParents(cwd, path) {
  const parts = relative(cwd, dirname(path)).split(sep).filter(Boolean);
  let cursor = cwd;
  validateDirectory(cursor);
  for (const part of parts) { cursor = join(cursor, part); validateDirectory(cursor); }
}

function createParents(cwd, path) {
  const parts = relative(cwd, dirname(path)).split(sep).filter(Boolean);
  let cursor = cwd;
  for (const part of parts) { cursor = join(cursor, part); if (!validateDirectory(cursor)) mkdirSync(cursor, { mode: 0o700 }); validateDirectory(cursor); }
}

// Publish a fully written private file without replacing an existing destination.
// If interrupted, rerunning adopts complete destination files; abandoned random
// temporary files contain no checkpoints and are never followed or reused.
function createPrivateFile(path, content) {
  if (validateFile(path)) return false;
  const temporary = join(dirname(path), `.setup-${randomBytes(16).toString('hex')}.tmp`);
  let fd, linked = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined;
    try { linkSync(temporary, path); linked = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; validateFile(path); }
  } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  validateFile(path);
  return linked;
}

function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { fail('SETUP_INVALID_PRIVATE_JSON'); } }

function buildConfig({ mode, channel }) {
  const raw = JSON.parse(readFileSync(join(sourceRoot, 'bridge.config.example.json'), 'utf8'));
  const discord = JSON.parse(readFileSync(join(sourceRoot, 'bridge.discord.example.json'), 'utf8')).channels.discord;
  raw.backend = mode; raw.transport = mode === 'inbox' || (mode === 'codex' && channel === 'discord') ? 'headless' : 'http';
  raw.dataDir = './runtime'; raw.codex.cwd = './workspace';
  raw.publicUrl = '${LINE_BRIDGE_PUBLIC_URL}';
  raw.channels.line.enabled = channel !== 'discord'; raw.channels.line.pairingCodeTtlMs = null;
  raw.channels.discord = { ...discord, enabled: channel !== 'line', pairingCodeTtlMs: null, guilds: {} };
  return raw;
}

function verifyExistingConfig(path, expected) {
  const raw = readJson(path);
  if (raw.backend !== expected.backend || (raw.transport ?? 'http') !== expected.transport || raw.channels?.line?.enabled !== expected.channels.line.enabled || raw.channels?.discord?.enabled !== expected.channels.discord.enabled) fail('SETUP_EXISTING_CONFIG_CONFLICT');
}

export function prepareSetup(input = {}) {
  const options = setupOptions(input), plan = planSetup(input), { paths, cwd, target, mode, channel } = options;
  // Validate every destination before creating anything. Never chmod or replace
  // unsafe existing files, and never inspect the content of an existing env file.
  for (const path of Object.values(paths)) { inspectParents(cwd, path); validateFile(path); }
  const expected = buildConfig(options), identity = { target, mode, channel, paths };
  if (stat(paths.config)) verifyExistingConfig(paths.config, expected);
  if (stat(paths.state)) {
    const state = readJson(paths.state);
    if (state.schemaVersion !== 1 || state.identity?.target !== target || state.identity?.mode !== mode || state.identity?.channel !== channel || Object.keys(paths).some(key => state.identity?.paths?.[key] !== paths[key])) fail('SETUP_EXISTING_STATE_CONFLICT');
  }
  for (const path of Object.values(paths)) createParents(cwd, path);
  const configCreated = createPrivateFile(paths.config, JSON.stringify(expected, null, 2) + '\n');
  verifyExistingConfig(paths.config, expected);
  const envCreated = createPrivateFile(paths.env, [
    '# Private setup credentials. Never paste values into chat or commit this file.',
    'LINE_CHANNEL_ACCESS_TOKEN=', 'LINE_CHANNEL_SECRET=', 'DISCORD_BOT_TOKEN=',
    `LINE_BRIDGE_OWNER_SECRET=${randomBytes(32).toString('base64url')}`,
    'LINE_BRIDGE_MCP_TOKEN=', 'LINE_BRIDGE_PUBLIC_URL=', '',
  ].join('\n'));
  const stateCreated = createPrivateFile(paths.state, JSON.stringify({
    schemaVersion: 1, identity, ready: false, verification: 'unverified',
    preparedAt: new Date().toISOString(),
    checkpoints: [{ id: 'private_artifacts', status: 'prepared', evidence: 'Configuration and private env file exist; credentials and runtime have not been verified.' }, ...plan.checkpoints],
  }, null, 2) + '\n');
  return { ...plan, action: 'prepare', files: { config: configCreated ? 'created' : 'preserved', env: envCreated ? 'created' : 'preserved', state: stateCreated ? 'created' : 'preserved' }, next: 'Use the checkpoints with authorized local account setup and secure cloud handoff. Keep ready=false until actual runtime, messaging E2E and PC independence are verified.' };
}

export function runSetup(args, { configPath } = {}) {
  const action = args[0];
  if (!['plan', 'prepare'].includes(action)) fail('SETUP_USE_PLAN_OR_PREPARE');
  const known = new Map([['--target', 'target'], ['--channel', 'channel'], ['--mode', 'mode'], ['--output-dir', 'outputDir'], ['--env-path', 'envPath'], ['--state-file', 'statePath']]);
  const options = configPath ? { configPath } : {};
  for (let i = 1; i < args.length; i += 2) {
    const key = known.get(args[i]);
    if (!key || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) fail('SETUP_INVALID_OPTION');
    options[key] = args[i + 1];
  }
  return action === 'plan' ? planSetup(options) : prepareSetup(options);
}
