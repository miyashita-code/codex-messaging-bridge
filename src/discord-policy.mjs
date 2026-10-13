import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizePairingCodeTtlMs } from './pairing.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value || {}, key);
const slug = value => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
const threadTypes = new Set([10, 11, 12]);

function secretFile(path, base) {
  if (!path) return '';
  if (typeof path !== 'string') throw new Error('Discord tokenFile must be a path');
  const target = resolve(base, path), info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Credential files must be regular files, not symlinks');
  return readFileSync(target, 'utf8').trim();
}

function tokenValue(value, env) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => env[key] || '').trim();
  if (object(value) && value.source === 'env' && (!value.provider || value.provider === 'default') && /^[A-Z_][A-Z0-9_]*$/.test(value.id || '')) return (env[value.id] || '').trim();
  throw new Error('Discord token must be a string or a default-provider env SecretRef');
}

function list(value, label) {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new Error(`${label} must contain strings`);
}

function validateRules(rules, label) {
  if (!object(rules)) throw new Error(`${label} must be an object`);
  for (const key of ['users', 'roles']) if (rules[key] !== undefined) list(rules[key], `${label}.${key}`);
  for (const key of ['enabled', 'allow', 'requireMention', 'requireMentionInBotThreads', 'ignoreOtherMentions', 'autoThread']) {
    if (rules[key] !== undefined && typeof rules[key] !== 'boolean') throw new Error(`${label}.${key} must be boolean`);
  }
  if (rules.channels !== undefined) {
    if (!object(rules.channels)) throw new Error(`${label}.channels must be an object`);
    for (const [key, value] of Object.entries(rules.channels)) validateRules(value, `${label}.channels.${key}`);
  }
}

function mergeGuilds(defaults = {}, overrides = {}) {
  return Object.fromEntries([...new Set([...Object.keys(defaults), ...Object.keys(overrides)])].map(key => {
    const a = defaults[key] || {}, b = overrides[key] || {}, result = { ...a, ...b };
    if (a.channels !== undefined || b.channels !== undefined) result.channels = { ...a.channels, ...b.channels };
    return [key, result];
  }));
}

/** Normalize the OpenClaw channels.discord config into enabled bot accounts. */
export function normalizeDiscord(raw, { base = process.cwd(), env = process.env } = {}) {
  const discord = raw?.channels?.discord;
  if (!discord || discord.enabled === false) return [];
  if (!object(discord)) throw new Error('channels.discord must be an object');
  const { accounts, ...defaults } = discord;
  if (accounts !== undefined && !object(accounts)) throw new Error('Discord accounts must be an object');
  const entries = accounts === undefined ? [['default', {}]] : Object.entries(accounts);
  return entries.flatMap(([accountId, overrides]) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(accountId) || !object(overrides)) throw new Error('Invalid Discord account');
    if (overrides.enabled === false) return [];
    for (const scope of [defaults, overrides]) {
      for (const key of ['dm', 'intents', 'guilds']) if (scope[key] !== undefined && !object(scope[key])) throw new Error(`Discord ${key} must be an object`);
      for (const [key, value] of Object.entries(scope.guilds || {})) validateRules(value, `Discord guilds.${key}`);
    }
    const account = { ...defaults, ...overrides, accountId, channel: 'discord' };
    const credentials = accountId === 'default' ? { ...defaults, ...overrides } : overrides;
    account.token = tokenValue(credentials.token, env) || secretFile(credentials.tokenFile, base) || (accountId === 'default' ? (env.DISCORD_BOT_TOKEN || '').trim() : '');
    account.dm = { enabled: true, groupEnabled: false, ...defaults.dm, ...overrides.dm };
    account.dmPolicy = overrides.dmPolicy ?? overrides.dm?.policy ?? defaults.dmPolicy ?? defaults.dm?.policy ?? 'pairing';
    account.pairingCodeTtlMs = normalizePairingCodeTtlMs(account.pairingCodeTtlMs);
    account.allowFrom = overrides.allowFrom ?? overrides.dm?.allowFrom ?? defaults.allowFrom ?? defaults.dm?.allowFrom ?? [];
    account.groupPolicy ??= 'allowlist';
    account.allowBots ??= true;
    account.requireMention ??= true;
    account.mediaMaxMb ??= 100;
    account.textChunkLimit ??= 2000;
    account.maxLinesPerMessage ??= 17;
    account.guilds = mergeGuilds(defaults.guilds, overrides.guilds);
    account.intents = { messageContent: true, guildMembers: false, ...defaults.intents, ...overrides.intents };
    if (!['pairing', 'allowlist', 'open', 'disabled'].includes(account.dmPolicy) || !['allowlist', 'open', 'disabled'].includes(account.groupPolicy)) throw new Error('Invalid Discord access policy');
    if (![true, false, 'mentions'].includes(account.allowBots)) throw new Error('Discord allowBots must be boolean or mentions');
    list(account.allowFrom, 'Discord allowFrom');
    if (account.dmPolicy === 'open' && !account.allowFrom.includes('*')) throw new Error('Discord dmPolicy=open requires allowFrom=["*"]');
    for (const key of ['enabled', 'groupEnabled']) if (typeof account.dm[key] !== 'boolean') throw new Error(`Discord dm.${key} must be boolean`);
    if (account.dm.groupChannels !== undefined) list(account.dm.groupChannels, 'Discord dm.groupChannels');
    if (!object(account.guilds)) throw new Error('Discord guilds must be an object');
    for (const [key, value] of Object.entries(account.guilds)) validateRules(value, `Discord guilds.${key}`);
    for (const key of ['requireMention', 'dangerouslyAllowNameMatching']) if (account[key] !== undefined && typeof account[key] !== 'boolean') throw new Error(`Discord ${key} must be boolean`);
    for (const [key, min, max] of [['mediaMaxMb', 1, 100], ['textChunkLimit', 1, 2000], ['maxLinesPerMessage', 1, 1000]]) {
      if (!Number.isInteger(account[key]) || account[key] < min || account[key] > max) throw new Error(`Invalid Discord ${key}`);
    }
    for (const key of ['messageContent', 'guildMembers']) if (typeof account.intents[key] !== 'boolean') throw new Error(`Discord intents.${key} must be boolean`);
    return [account];
  });
}

function normalizeId(value, kind) {
  let id = String(value || '').trim().replace(/^discord:/i, '');
  id = id.replace(new RegExp(`^${kind}:`, 'i'), '');
  if (kind === 'user') id = id.replace(/^<@!?(\d+)>$/, '$1');
  if (kind === 'channel') id = id.replace(/^<#(\d+)>$/, '$1');
  if (kind === 'role') id = id.replace(/^<@&(\d+)>$/, '$1');
  return id;
}

function mapEntry(map, id, name, kind) {
  if (!object(map)) return undefined;
  for (const [key, value] of Object.entries(map)) if (key !== '*' && normalizeId(key, kind) === id) return value;
  if (name) for (const [key, value] of Object.entries(map)) {
    if (key !== '*' && !/^\d+$/.test(normalizeId(key, kind)) && slug(key.replace(/^#/, '')) === slug(name)) return value;
  }
  return undefined;
}

function rulesFor(account, message) {
  const guilds = account.guilds || {}, specific = mapEntry(guilds, message.guild_id, message.guild?.name, 'guild');
  const guild = { ...guilds['*'], ...specific };
  const listedGuild = specific !== undefined || own(guilds, '*');
  const channel = message.channel || {}, channels = guild.channels;
  let entry = mapEntry(channels, message.channel_id, channel.name, 'channel');
  if (entry === undefined && threadTypes.has(channel.type) && channel.parent_id) entry = mapEntry(channels, channel.parent_id, channel.parent?.name, 'channel');
  const listedChannel = channels === undefined || entry !== undefined || own(channels, '*');
  return { guild, rules: { ...guild, ...(channels?.['*'] || {}), ...entry }, listedGuild, listedChannel };
}

function userAllowed(entries, message, nameMatching = false) {
  const author = message.author || {};
  return (entries || []).some(value => {
    if (value === '*') return true;
    const id = normalizeId(value, 'user');
    if (id === author.id) return true;
    if (!nameMatching || /^\d+$/.test(id)) return false;
    return [author.username, author.global_name, message.member?.nick, author.discriminator && `${author.username}#${author.discriminator}`].some(name => name && name.toLowerCase() === id.toLowerCase());
  });
}

function senderAllowed(rules, account, message) {
  if (rules.users === undefined && rules.roles === undefined) return true;
  return userAllowed(rules.users, message, account.dangerouslyAllowNameMatching) || (rules.roles || []).some(role => (message.member?.roles || []).includes(normalizeId(role, 'role')));
}

const botIdFor = (account, message) => account.botId || message.bot_id || message.botUserId;
function activeMention(message, botId) {
  if (!botId) return false;
  const content = String(message.content || '').replace(/```[\s\S]*?```|`[^`]*`/g, '');
  return content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`);
}

/** Admission only; mention gating is applied separately by discordAddressed. */
export function discordAdmitted(account, message, paired = false) {
  if (!message?.author?.id || !message.channel_id) return false;
  const botId = botIdFor(account, message);
  if (botId && message.author.id === botId) return false;
  if (message.author.bot || message.webhook_id) {
    if (account.allowBots === false || (account.allowBots === 'mentions' && !activeMention(message, botId))) return false;
  }
  if (!message.guild_id) {
    if (account.dm?.enabled === false) return false;
    if (message.channel?.type === 3) {
      if (account.dm?.groupEnabled !== true) return false;
      const channels = account.dm.groupChannels;
      if (channels?.length && !channels.some(value => value === '*' || normalizeId(value, 'channel') === message.channel_id || message.channel.name && slug(value.replace(/^#/, '')) === slug(message.channel.name))) return false;
    } else if (message.channel?.type !== 1) return false;
    if (account.dmPolicy === 'disabled') return false;
    if (userAllowed(account.allowFrom, message, account.dangerouslyAllowNameMatching)) return true;
    return account.dmPolicy === 'open' || account.dmPolicy === 'pairing' && paired === true;
  }
  if (account.groupPolicy === 'disabled') return false;
  const { guild, rules, listedGuild, listedChannel } = rulesFor(account, message);
  if (account.groupPolicy !== 'open' && !listedGuild) return false;
  if (!listedChannel || guild.enabled === false || rules.enabled === false || rules.allow === false) return false;
  return senderAllowed(rules, account, message);
}

export function discordAddressed(account, message, botId = botIdFor(account, message)) {
  if (!message.guild_id && message.channel?.type !== 3) return true;
  const { rules } = rulesFor(account, message);
  const channel = message.channel || {};
  if (botId && threadTypes.has(channel.type) && channel.owner_id === botId && rules.requireMentionInBotThreads === true && !activeMention(message, botId)) return false;
  const mention = activeMention(message, botId) || (message.mentions || []).some(user => user.id === botId);
  const reply = Boolean(botId && message.referenced_message?.author?.id === botId);
  if (mention) return true;
  if (rules.ignoreOtherMentions && ((message.mentions || []).length || (message.mention_roles || []).length || message.referenced_message?.author?.bot && !reply)) return false;
  if ((rules.requireMention ?? account.requireMention ?? true) === false) return true;
  if (botId && threadTypes.has(channel.type) && channel.owner_id === botId && (rules.requireMentionInBotThreads === false || rules.requireMentionInBotThreads === undefined && rules.autoThread === true)) return true;
  return reply;
}

export const discordConversation = message => message.channel_id;
export const discordSessionKey = (accountId, message) => `discord:${accountId}:${message.guild_id ? 'guild' : message.channel?.type === 3 ? 'group' : 'dm'}:${discordConversation(message)}`;

export function stripDiscordMentions(message, botId) {
  if (!botId || !/^\d+$/.test(botId)) return (message.content || '').trim();
  return (message.content || '').replace(new RegExp(`<@!?${botId}>`, 'g'), ' ').trim();
}
