import { readFileSync, lstatSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { normalizeDiscord } from './discord-policy.mjs';
import { normalizePairingCodeTtlMs } from './pairing.mjs';

function fileSecret(path, base) {
  if (!path) return '';
  const target = resolve(base, path);
  if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) throw new Error('Credential files must be regular files, not symlinks');
  return readFileSync(target, 'utf8').trim();
}
function expand(value, env) {
  if (typeof value === 'string') return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => env[key] || '');
  if (Array.isArray(value)) return value.map(v => expand(v, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,expand(v,env)]));
  return value;
}
export function loadConfig(path = 'bridge.config.json', env = process.env) {
  const absolute = resolve(path), base = dirname(absolute);
  return normalizeConfig(expand(JSON.parse(readFileSync(absolute, 'utf8')), env), {base,env});
}
export function normalizeConfig(raw, {base=process.cwd(),env=process.env}={}) {
  const config = {...raw};
  config.backend ??= 'dot';
  if (!['dot','codex','inbox'].includes(config.backend)) throw new Error('backend must be dot, codex or inbox');
  config.transport ??= 'http';
  if(!['http','headless'].includes(config.transport))throw new Error('transport must be http or headless');
  config.host ??= '127.0.0.1'; config.port ??= 8787;
  config.dataDir = resolve(base, config.dataDir || './data');
  config.concurrency ??= 8; config.maxAttempts ??= 8; config.mediaMaxMb ??= raw.channels?.line?.mediaMaxMb ?? 10;
  config.retentionDays ??= 30;config.queueLimit ??= 10000;
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid port');
  for (const [key,min,max] of [['concurrency',1,32],['maxAttempts',1,20],['mediaMaxMb',1,50]]) {
    if (!Number.isInteger(config[key]) || config[key]<min || config[key]>max) throw new Error(`Invalid ${key}`);
  }
  config.publicUrl = (config.publicUrl || env.LINE_BRIDGE_PUBLIC_URL || '').replace(/\/$/, '');
  if (config.publicUrl) {const u=new URL(config.publicUrl);if(u.protocol!=='https:' || u.origin!==config.publicUrl)throw new Error('publicUrl must be an HTTPS origin without path, credentials, query or fragment');}
  if(!Number.isInteger(config.retentionDays) || config.retentionDays<1 || config.retentionDays>365 || !Number.isInteger(config.queueLimit) || config.queueLimit<100 || config.queueLimit>100000)throw new Error('Invalid retention or queue limit');
  config.mcp = {subscriptionTtlMs:86400000,...raw.mcp,token:raw.mcp?.token || env.LINE_BRIDGE_MCP_TOKEN || ''};
  config.ownerSecret = env.LINE_BRIDGE_OWNER_SECRET || raw.ownerSecret || '';
  config.codex = {command:'codex',sandbox:'read-only',approvalPolicy:'on-request',turnTimeoutMs:900000,...raw.codex};
  config.codex.cwd = resolve(base, config.codex.cwd || './data/workspace');
  if (!['read-only','workspace-write'].includes(config.codex.sandbox)) throw new Error('Unsupported Codex sandbox');
  if (config.codex.approvalPolicy !== 'on-request') throw new Error('Codex approvalPolicy must be on-request');
  const line = raw.channels?.line;
  const {accounts,...defaults} = line || {};
  const entries = !line || line.enabled===false?[]:accounts ? Object.entries(accounts) : [['default',{}]];
  config.accounts = entries.filter(([,v]) => v.enabled !== false).map(([id,overrides]) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid account ID');
    const a = {...defaults,...overrides, accountId:id};
    a.groups = {...defaults.groups,...overrides.groups};
    a.webhookPath ??= id==='default' ? '/line/webhook' : `/line/${id}`;
    if (!/^\/[a-zA-Z0-9/_-]+$/.test(a.webhookPath) || a.webhookPath.startsWith('/oauth') || ['/mcp','/healthz'].includes(a.webhookPath)) throw new Error('Invalid webhookPath');
    const credentials=id==='default'?{...defaults,...overrides}:overrides;
    a.channelAccessToken = credentials.channelAccessToken || fileSecret(credentials.tokenFile,base) || (id==='default' ? env.LINE_CHANNEL_ACCESS_TOKEN : '') || '';
    a.channelSecret = credentials.channelSecret || fileSecret(credentials.secretFile,base) || (id==='default' ? env.LINE_CHANNEL_SECRET : '') || '';
    a.dmPolicy ??= 'pairing'; a.groupPolicy ??= 'allowlist';
    a.pairingCodeTtlMs = normalizePairingCodeTtlMs(a.pairingCodeTtlMs);
    a.mediaMaxMb ??= config.mediaMaxMb;
    if(!Number.isInteger(a.mediaMaxMb) || a.mediaMaxMb<1 || a.mediaMaxMb>50)throw new Error('Invalid LINE mediaMaxMb');
    a.allowFrom ??= []; a.groupAllowFrom ??= [];
    if (!['pairing','allowlist','open','disabled'].includes(a.dmPolicy) || !['allowlist','open','disabled'].includes(a.groupPolicy)) throw new Error('Invalid channel access policy');
    if (a.dmPolicy==='open' && !a.allowFrom.includes('*')) throw new Error('dmPolicy=open requires allowFrom=["*"]');
    for (const list of [a.allowFrom,a.groupAllowFrom,...Object.values(a.groups || {}).map(g=>g.allowFrom).filter(Boolean)]) {
      if (!Array.isArray(list) || list.some(v=>typeof v!=='string')) throw new Error('Allowlists must contain strings');
    }
    return a;
  });
  if (new Set(config.accounts.map(a=>a.webhookPath)).size !== config.accounts.length) throw new Error('Account webhook paths must be unique');
  config.discordAccounts=normalizeDiscord(raw,{base,env});
  if(!config.accounts.length && !config.discordAccounts.length)throw new Error('At least one channel must be enabled');
  if(config.transport==='headless' && config.accounts.length)throw new Error('LINE requires an HTTP webhook receiver; headless mode supports Discord only');
  if(config.transport==='headless' && config.backend==='dot')throw new Error('Use backend=inbox for headless access from Your dot\'s computer; MCP Events requires a reachable MCP endpoint');
  return config;
}
