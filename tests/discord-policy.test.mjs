import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeDiscord, discordAdmitted, discordAddressed, discordConversation, discordSessionKey, stripDiscordMentions } from '../src/discord-policy.mjs';

const userId = '111111111111111111', botId = '222222222222222222', guildId = '333333333333333333', channelId = '444444444444444444', roleId = '555555555555555555';
const message = (extra = {}) => ({ id: '666666666666666666', channel_id: channelId, author: { id: userId, username: 'owner' }, content: 'hello', bot_id: botId, channel: { id: channelId, type: 1 }, ...extra });
const guildMessage = (extra = {}) => message({ guild_id: guildId, channel: { id: channelId, type: 0, name: 'general' }, member: { roles: [] }, ...extra });
const account = (discord = {}) => normalizeDiscord({ channels: { discord } }, { env: {} })[0];

test('Discord env credentials only activate an explicitly configured channel', () => {
  assert.deepEqual(normalizeDiscord({}, { env: { DISCORD_BOT_TOKEN: 'secret' } }), []);
  assert.deepEqual(normalizeDiscord({ channels: { discord: { enabled: false } } }), []);
  const a = normalizeDiscord({ channels: { discord: {} } }, { env: { DISCORD_BOT_TOKEN: 'secret' } })[0];
  assert.equal(a.token, 'secret');
  assert.equal(a.dmPolicy, 'pairing');
  assert.equal(a.groupPolicy, 'allowlist');
  assert.equal(a.allowBots, true);
  assert.equal(a.dm.groupEnabled, false);
  assert.equal(a.mediaMaxMb, 100);
});

test('named bots do not inherit another bot token or default-account credentials', () => {
  const accounts = normalizeDiscord({ channels: { discord: { token: 'root-token', allowFrom: [userId], accounts: { default: { token: 'default-token', allowFrom: ['777777777777777777'] }, work: {}, disabled: { enabled: false } } } } }, { env: { DISCORD_BOT_TOKEN: 'env-token' } });
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].token, 'default-token');
  assert.equal(accounts[1].token, '');
  assert.deepEqual(accounts[1].allowFrom, [userId]);
});

test('account-local legacy DM fields override channel policy and top-level local fields win legacy fields', () => {
  const accounts = normalizeDiscord({ channels: { discord: { dmPolicy: 'pairing', allowFrom: [userId], accounts: { work: { dm: { policy: 'disabled', allowFrom: ['777777777777777777'] } }, personal: { dmPolicy: 'allowlist', allowFrom: ['888888888888888888'], dm: { policy: 'disabled', allowFrom: [] } } } } } }, { env: {} });
  assert.equal(accounts[0].dmPolicy, 'disabled');
  assert.deepEqual(accounts[0].allowFrom, ['777777777777777777']);
  assert.equal(accounts[1].dmPolicy, 'allowlist');
  assert.deepEqual(accounts[1].allowFrom, ['888888888888888888']);
});

test('env SecretRef resolves only the supported env provider', () => {
  const a = normalizeDiscord({ channels: { discord: { token: { source: 'env', provider: 'default', id: 'CUSTOM_BOT_TOKEN' } } } }, { env: { CUSTOM_BOT_TOKEN: 'custom' } })[0];
  assert.equal(a.token, 'custom');
  assert.throws(() => account({ token: { source: 'exec', id: 'run' } }), /token must be/);
});

test('file secrets must be regular files and direct tokens have precedence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-secrets-'));
  try {
    writeFileSync(join(dir, 'token'), 'file-token\n');
    symlinkSync(join(dir, 'token'), join(dir, 'link'));
    const config = tokenFile => ({ channels: { discord: { tokenFile } } });
    assert.equal(normalizeDiscord(config('token'), { base: dir, env: {} })[0].token, 'file-token');
    assert.throws(() => normalizeDiscord(config('link'), { base: dir, env: {} }), /regular files/);
    assert.throws(() => normalizeDiscord(config('.'), { base: dir, env: {} }), /regular files/);
    assert.equal(normalizeDiscord({ channels: { discord: { token: 'direct', tokenFile: 'missing' } } }, { base: dir, env: {} })[0].token, 'direct');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('policy validation rejects malformed and accidentally public configs', () => {
  for (const invalid of [{ dmPolicy: 'bad' }, { groupPolicy: 'bad' }, { dmPolicy: 'open' }, { allowBots: 'yes' }, { guilds: 'bad' }, { dm: 'bad' }, { allowFrom: [111] }, { guilds: { [guildId]: { users: 'everyone' } } }, { guilds: { [guildId]: { channels: [] } } }, { mediaMaxMb: 101 }]) assert.throws(() => account(invalid));
  assert.equal(account({ dmPolicy: 'open', allowFrom: ['*'] }).dmPolicy, 'open');
});

test('pairing only grants approved DM senders and refuses unidentified senders', () => {
  const a = account();
  assert.equal(discordAdmitted(a, message()), false);
  assert.equal(discordAdmitted(a, message(), true), true);
  assert.equal(discordAdmitted(a, message({ author: {} }), true), false);
  assert.equal(discordAdmitted(a, message({ channel_id: undefined }), true), false);
  assert.equal(discordAdmitted(a, message({ channel: undefined }), true), false, 'unknown DM channel type must not admit a group DM');
});

test('DM allowlists recognize Discord target ID forms', () => {
  for (const entry of [userId, `discord:${userId}`, `user:${userId}`, `<@${userId}>`, `<@!${userId}>`, `discord:user:${userId}`]) assert.equal(discordAdmitted(account({ dmPolicy: 'allowlist', allowFrom: [entry] }), message()), true);
  assert.equal(discordAdmitted(account({ dmPolicy: 'allowlist', allowFrom: [] }), message(), true), false);
});

test('disabled DM policy and dm.enabled cannot be bypassed by allowlists or pairing', () => {
  assert.equal(discordAdmitted(account({ dmPolicy: 'disabled', allowFrom: ['*'] }), message(), true), false);
  assert.equal(discordAdmitted(account({ dm: { enabled: false }, allowFrom: ['*'] }), message(), true), false);
});

test('pairing approval never grants guild access', () => {
  assert.equal(discordAdmitted(account(), guildMessage(), true), false);
  assert.equal(discordAdmitted(account({ dmPolicy: 'open', allowFrom: ['*'] }), guildMessage(), true), false);
  assert.equal(discordAdmitted(account({ guilds: { [guildId]: {} } }), guildMessage()), true);
});

test('guild policies admit only configured guilds unless explicitly open', () => {
  assert.equal(discordAdmitted(account({ guilds: { '777777777777777777': {} } }), guildMessage()), false);
  assert.equal(discordAdmitted(account({ guilds: { '*': {} } }), guildMessage()), true);
  assert.equal(discordAdmitted(account({ groupPolicy: 'open' }), guildMessage()), true);
  assert.equal(discordAdmitted(account({ groupPolicy: 'disabled', guilds: { '*': {} } }), guildMessage()), false);
});

test('guild user OR role rules fail closed for empty lists and absent member roles', () => {
  const a = account({ guilds: { [guildId]: { users: ['777777777777777777'], roles: [roleId] } } });
  assert.equal(discordAdmitted(a, guildMessage()), false);
  assert.equal(discordAdmitted(a, guildMessage({ member: { roles: [roleId] } })), true);
  assert.equal(discordAdmitted(a, guildMessage({ author: { id: '777777777777777777' } })), true);
  assert.equal(discordAdmitted(account({ guilds: { [guildId]: { users: [] } } }), guildMessage()), false);
});

test('channel maps are allowlists including with groupPolicy=open', () => {
  const a = account({ groupPolicy: 'open', guilds: { [guildId]: { channels: { '777777777777777777': { enabled: true } } } } });
  assert.equal(discordAdmitted(a, guildMessage()), false);
  assert.equal(discordAdmitted(account({ guilds: { [guildId]: { channels: {} } } }), guildMessage()), false);
  assert.equal(discordAdmitted(account({ guilds: { [guildId]: { channels: { '*': { enabled: true } } } } }), guildMessage()), true);
});

test('channel sender and mention settings override guild defaults', () => {
  const a = account({ guilds: { [guildId]: { users: ['777777777777777777'], requireMention: true, channels: { [channelId]: { users: ['*'], requireMention: false } } } } });
  assert.equal(discordAdmitted(a, guildMessage()), true);
  assert.equal(discordAddressed(a, guildMessage(), botId), true);
});

test('wildcard channel defaults merge with explicit channel settings', () => {
  const a = account({ guilds: { [guildId]: { channels: { '*': { users: [userId], requireMention: false }, [channelId]: { enabled: true, requireMention: true } } } } });
  assert.equal(discordAdmitted(a, guildMessage()), true);
  assert.equal(discordAddressed(a, guildMessage(), botId), false);
  assert.equal(discordAdmitted(a, guildMessage({ author: { id: '777777777777777777' } })), false);
});

test('threads inherit their parent channel policy and keep distinct sessions', () => {
  const a = account({ guilds: { [guildId]: { channels: { [channelId]: { users: [userId], requireMention: false } } } } });
  const thread = guildMessage({ channel_id: '777777777777777777', channel: { id: '777777777777777777', type: 11, parent_id: channelId } });
  assert.equal(discordAdmitted(a, thread), true);
  assert.equal(discordAddressed(a, thread, botId), true);
  assert.notEqual(discordSessionKey('default', thread), discordSessionKey('default', guildMessage()));
  assert.equal(discordAdmitted(a, { ...thread, channel: { ...thread.channel, type: 0 } }), false, 'category parents must not bypass the channel allowlist');
});

test('explicit thread policy wins parent policy', () => {
  const threadId = '777777777777777777', a = account({ guilds: { [guildId]: { channels: { [channelId]: { users: ['*'] }, [threadId]: { enabled: false } } } } });
  assert.equal(discordAdmitted(a, guildMessage({ channel_id: threadId, channel: { id: threadId, type: 11, parent_id: channelId } })), false);
});

test('guild and channel names are supported but sender names require explicit opt-in', () => {
  const cfg = { guilds: { 'my-server': { users: ['owner'], channels: { general: {} } } } };
  const msg = guildMessage({ guild: { name: 'My Server' } });
  assert.equal(discordAdmitted(account(cfg), msg), false);
  assert.equal(discordAdmitted(account({ ...cfg, dangerouslyAllowNameMatching: true }), msg), true);
});

test('group DMs are opt-in and enforce both channel and sender policy', () => {
  const msg = message({ channel: { type: 3, name: 'Friends' } });
  assert.equal(discordAdmitted(account({ allowFrom: [userId] }), msg), false);
  const a = account({ allowFrom: [userId], dm: { groupEnabled: true, groupChannels: [channelId] } });
  assert.equal(discordAdmitted(a, msg), true);
  assert.equal(discordAdmitted(a, { ...msg, channel_id: '777777777777777777' }), false);
  assert.equal(discordAdmitted(a, { ...msg, author: { id: '777777777777777777' } }), false);
});

test('bot admission matches current OpenClaw allowBots defaults but never accepts self', () => {
  const a = account({ guilds: { [guildId]: {} } }), msg = guildMessage({ author: { id: '777777777777777777', bot: true } });
  assert.equal(discordAdmitted(a, msg), true);
  assert.equal(discordAdmitted({ ...a, allowBots: false }, msg), false);
  assert.equal(discordAdmitted(a, { ...msg, author: { id: botId, bot: true } }), false);
  assert.equal(discordAdmitted({ ...a, allowBots: false }, { ...msg, author: { id: '777777777777777777' }, webhook_id: '888888888888888888' }), false);
});

test('allowBots=mentions requires active mention, excluding reply pings and code examples', () => {
  const a = account({ allowBots: 'mentions', guilds: { [guildId]: {} } }), msg = guildMessage({ author: { id: '777777777777777777', bot: true }, mentions: [{ id: botId }], referenced_message: { author: { id: botId } } });
  assert.equal(discordAdmitted(a, msg), false);
  assert.equal(discordAdmitted(a, { ...msg, content: `hello <@${botId}>` }), true);
  assert.equal(discordAdmitted(a, { ...msg, content: `\`<@${botId}>\`` }), false);
  assert.equal(discordAdmitted(a, { ...msg, content: `\`\`\`\n<@${botId}>\n\`\`\`` }), false);
});

test('guild mentions and reply-to-bot address the assistant, unmentioned messages do not', () => {
  const a = account({ guilds: { [guildId]: {} } });
  assert.equal(discordAddressed(a, guildMessage(), botId), false);
  assert.equal(discordAddressed(a, guildMessage({ mentions: [{ id: botId }] }), botId), true);
  assert.equal(discordAddressed(a, guildMessage({ content: `<@${botId}> hello` }), botId), true);
  assert.equal(discordAddressed(a, guildMessage({ referenced_message: { author: { id: botId } } }), botId), true);
  assert.equal(discordAddressed(a, message(), botId), true);
});

test('ignoreOtherMentions respects explicit bot mentions and drops other targets', () => {
  const a = account({ guilds: { [guildId]: { requireMention: false, ignoreOtherMentions: true } } });
  assert.equal(discordAddressed(a, guildMessage({ mentions: [{ id: '777777777777777777' }] }), botId), false);
  assert.equal(discordAddressed(a, guildMessage({ mention_roles: [roleId] }), botId), false);
  assert.equal(discordAddressed(a, guildMessage({ mentions: [{ id: botId }, { id: '777777777777777777' }] }), botId), true);
});

test('bot-created thread mention override checks ownership and explicit requirement', () => {
  const thread = guildMessage({ channel: { type: 11, parent_id: channelId, owner_id: botId } });
  const a = account({ guilds: { [guildId]: { requireMentionInBotThreads: false } } });
  assert.equal(discordAddressed(a, thread, botId), true);
  assert.equal(discordAddressed(a, { ...thread, channel: { ...thread.channel, owner_id: userId } }, botId), false);
  const strict = account({ guilds: { [guildId]: { requireMentionInBotThreads: true } } });
  assert.equal(discordAddressed(strict, { ...thread, mentions: [{ id: botId }], referenced_message: { author: { id: botId } } }, botId), false);
  assert.equal(discordAddressed(strict, { ...thread, content: `<@${botId}> hello` }, botId), true);
  const auto = account({ guilds: { [guildId]: { autoThread: true } } });
  assert.equal(discordAddressed(auto, thread, botId), true);
});

test('conversation and session IDs isolate accounts and DM channels', () => {
  assert.equal(discordConversation(message()), channelId);
  assert.equal(discordSessionKey('default', message()), `discord:default:dm:${channelId}`);
  assert.notEqual(discordSessionKey('default', message()), discordSessionKey('work', message()));
  assert.notEqual(discordSessionKey('default', message()), discordSessionKey('default', message({ channel_id: '777777777777777777' })));
  assert.equal(stripDiscordMentions(message({ content: `<@${botId}> hello <@${userId}>` }), botId), `hello <@${userId}>`);
});
