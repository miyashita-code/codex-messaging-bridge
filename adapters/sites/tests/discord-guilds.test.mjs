import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {discordGuildProfiles,discordGuildProfile,discordGuildEnv,discordGuildScope,discordPrimaryGuildId,discordGuildActivation,discordChannelActivation,DISCORD_MAX_CHANNELS_PER_GUILD,DiscordGuildConfigError} from '../worker/discord-guilds.js';
const G1='100000000000000001',G2='100000000000000002',C1='200000000000000001',C2='200000000000000002',C3='200000000000000003';
const profile=(extra={})=>({guild_id:G2,label:'Team fixture',allowed_channel_ids:[C2],poll_channel_ids:[C2],since:'2026-10-15T00:00:00.000Z',...extra});
const setup=(extra={})=>({BRIDGE_OWNER_SITE_ID:'owner-fixture',DISCORD_GUILD_ID:G1,DISCORD_ALLOWED_CHANNEL_IDS:C1,DISCORD_POLL_CHANNEL_IDS:C1,DISCORD_CLOUD_SINCE:'2026-10-14T00:00:00.000Z',...extra});
function database(t,env){const raw=new DatabaseSync(':memory:');t.after(()=>raw.close());raw.exec('CREATE TABLE bridge_runtime(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)');env.DB={prepare(sql){return{bind(...values){return{async first(){return raw.prepare(sql).get(...values)||null;},async run(){return{meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};}};}};}};return raw;}
test('legacy primary retains its empty allowlist and original identities without an opt-in',()=>{
 const env=setup({DISCORD_ALLOWED_CHANNEL_IDS:''}),profiles=discordGuildProfiles(env);assert.equal(profiles.length,1);assert.deepEqual(profiles[0].allowed_channel_ids,[]);assert.equal(profiles[0].guild_id,G1);assert.equal(profiles[0].is_primary,true);
});
test('additional profiles normalize and scoped overlays preserve the original primary and parent env',()=>{
 const env=setup({DISCORD_GUILDS_JSON:JSON.stringify([profile()]),secret:'synthetic-unchanged'}),scoped=discordGuildEnv(env,G2);
 assert.equal(discordGuildProfiles(env).length,2);assert.equal(scoped.DISCORD_GUILD_ID,G2);assert.equal(scoped.DISCORD_ALLOWED_CHANNEL_IDS,C2);assert.equal(scoped.secret,env.secret);assert.equal(env.DISCORD_GUILD_ID,G1);
 assert.equal(discordPrimaryGuildId(scoped),G1);assert.equal(discordGuildScope(scoped),G2);assert.equal(discordGuildProfile(scoped,G1).is_primary,true);assert.equal(discordGuildProfiles(Object.create(scoped)).length,2);
 assert.throws(()=>discordGuildEnv(scoped,G1),e=>e.code==='GUILD_NOT_ALLOWED');
});
test('malformed, wildcard, duplicate, oversized and unknown profile configurations fail closed',()=>{
 const invalid=[null,{},'bad',Array(5).fill(profile()),[profile({guild_id:G1})],[profile({guild_id:123})],[profile({guild_id:Number(G2)})],[profile({allowed_channel_ids:[]})],[profile({poll_channel_ids:[]})],[profile({allowed_channel_ids:['*']})],[profile({allowed_channel_ids:[C2,C2]})],[profile({poll_channel_ids:[C3]})],[profile({allowed_channel_ids:[C1]})],[profile({extra:true})],[profile({enabled:'true'})],[profile({label:'x'.repeat(81)})],[profile({since:'2026-02-30T00:00:00Z'})],[profile({since:'2026-10-15'})],[profile(),profile()]];
 for(const value of invalid){const env=setup({DISCORD_GUILDS_JSON:typeof value==='string'?value:JSON.stringify(value)});assert.throws(()=>discordGuildProfiles(env),DiscordGuildConfigError,JSON.stringify(value));}
});
test('disabled profiles are still validated and grant no lookup or overlay access',()=>{
 const env=setup({DISCORD_GUILDS_JSON:JSON.stringify([profile({enabled:false})])});assert.equal(discordGuildProfiles(env).length,1);assert.equal(discordGuildProfile(env,G2),null);assert.throws(()=>discordGuildEnv(env,G2),e=>e.code==='GUILD_NOT_ALLOWED');
 env.DISCORD_GUILDS_JSON=JSON.stringify([profile({enabled:false,poll_channel_ids:[]})]);assert.throws(()=>discordGuildProfiles(env),DiscordGuildConfigError);
});
test('additional activation preserves the first explicit since, initial channels and a monotonic owner-scoped journal',async t=>{
 const env=setup({DISCORD_GUILDS_JSON:JSON.stringify([profile()])}),raw=database(t,env),first=await discordGuildActivation(env,G2);
 assert.equal(first.since_ms,Date.parse(profile().since));assert.deepEqual(first.initial_channel_ids,[C2]);
 env.DISCORD_GUILDS_JSON=JSON.stringify([profile({allowed_channel_ids:[C2,C3],poll_channel_ids:[C2,C3],since:'2026-10-16T00:00:00Z'})]);
 const advanced=await discordGuildActivation(env,G2);assert.equal(advanced.since_ms,Date.parse('2026-10-16T00:00:00Z'));assert.deepEqual(advanced.initial_channel_ids,[C2]);
 env.DISCORD_GUILDS_JSON=JSON.stringify([profile()]);assert.equal((await discordGuildActivation({...env},G2)).since_ms,advanced.since_ms);
 assert.equal((await discordGuildActivation(env,G1)).since_ms,Date.parse(env.DISCORD_CLOUD_SINCE));assert.equal(raw.prepare('SELECT COUNT(*) n FROM bridge_runtime').get().n,1);
 const other={...env,BRIDGE_OWNER_SITE_ID:'other-owner'};assert.equal((await discordGuildActivation(other,G2)).since_ms,first.since_ms);assert.equal(raw.prepare('SELECT COUNT(*) n FROM bridge_runtime').get().n,2);
});
test('concurrent initialization cannot lose the activation fence and corrupt journals fail closed',async t=>{
 const env=setup({DISCORD_GUILDS_JSON:JSON.stringify([profile()])}),raw=database(t,env);
 const all=await Promise.all(Array.from({length:6},()=>discordGuildActivation(env,G2)));assert.ok(all.every(value=>value.since_ms===all[0].since_ms));assert.equal(raw.prepare('SELECT COUNT(*) n FROM bridge_runtime').get().n,1);
 raw.prepare('UPDATE bridge_runtime SET value=?').run('{"version":1}');await assert.rejects(discordGuildActivation(env,G2),e=>e.code==='DISCORD_GUILD_STATE_UNAVAILABLE');
});

test('reviewed channel start maps accept only explicit polling channels and strict timestamps with a bounded channel set',()=>{
 const channels=Array.from({length:50},(_,n)=>String(BigInt(C2)+BigInt(n))),start='2026-10-15T01:00:00Z';
 const env=setup({DISCORD_GUILDS_JSON:JSON.stringify([profile({allowed_channel_ids:channels,poll_channel_ids:channels,channel_since:{[C2]:start}})])});
 assert.equal(DISCORD_MAX_CHANNELS_PER_GUILD,50);assert.equal(discordGuildProfile(env,G2).channel_since_ms[C2],Date.parse(start));
 const cases=[null,[],{[C3]:start},{[C2]:'2026-10-15'},{[C2]:'2026-02-30T00:00:00Z'},{[C2]:Date.parse(start)}];
 for(const channel_since of cases){env.DISCORD_GUILDS_JSON=JSON.stringify([profile({channel_since})]);assert.throws(()=>discordGuildProfiles(env),DiscordGuildConfigError);}
 channels.push(String(BigInt(C2)+50n));env.DISCORD_GUILDS_JSON=JSON.stringify([profile({allowed_channel_ids:channels,poll_channel_ids:channels})]);assert.throws(()=>discordGuildProfiles(env),DiscordGuildConfigError);
});

test('added channels and public children inherit reviewed starts without rewinding an activation journal',async t=>{
 const env=setup({DISCORD_GUILDS_JSON:JSON.stringify([profile()])});database(t,env);await discordGuildActivation(env,G2);
 const thread='200000000000000012',start='2026-10-15T01:00:00Z',later='2026-10-15T02:00:00Z';
 const added=extra=>profile({allowed_channel_ids:[C2,C3],poll_channel_ids:[C2,C3],channel_since:{[C3]:start},...extra});
 env.DISCORD_GUILDS_JSON=JSON.stringify([added()]);
 assert.equal((await discordChannelActivation(env,G2,C3)).since_ms,Date.parse(start));
 assert.equal((await discordChannelActivation(env,G2,thread,{parent_id:C3})).since_ms,Date.parse(start));
 env.DISCORD_GUILDS_JSON=JSON.stringify([added({channel_since:{[C3]:later}})]);
 assert.equal((await discordChannelActivation(env,G2,C3)).since_ms,Date.parse(later));assert.equal((await discordChannelActivation(env,G2,thread,{parent_id:C3})).since_ms,Date.parse(later));
 env.DISCORD_GUILDS_JSON=JSON.stringify([added()]);assert.equal((await discordChannelActivation(env,G2,C3)).since_ms,Date.parse(later));assert.equal((await discordChannelActivation(env,G2,thread,{parent_id:C3})).since_ms,Date.parse(later));
 env.DISCORD_GUILDS_JSON=JSON.stringify([profile()]);await assert.rejects(discordChannelActivation(env,G2,thread,{parent_id:C3}),e=>e.code==='CHANNEL_NOT_ALLOWED');
});

test('unreviewed new channels start at first observation while existing cursors retain their previous floor',async t=>{
 const env=setup({DISCORD_GUILDS_JSON:JSON.stringify([profile()])}),raw=database(t,env);await discordGuildActivation(env,G2);
 env.DISCORD_GUILDS_JSON=JSON.stringify([profile({allowed_channel_ids:[C2,C3],poll_channel_ids:[C2,C3]})]);
 const before=Date.now(),first=await discordChannelActivation(env,G2,C3),after=Date.now();assert.ok(first.since_ms>=before&&first.since_ms<=after);assert.equal((await discordChannelActivation({...env},G2,C3)).since_ms,first.since_ms);
 const child='200000000000000012';raw.prepare('INSERT INTO bridge_runtime VALUES(?,?,?)').run('cloud_cursor:'+G2+':'+child,'500000000000000001',Date.now());
 assert.equal((await discordChannelActivation(env,G2,child,{parent_id:C2})).since_ms,Date.parse(profile().since));assert.equal(raw.prepare('SELECT value FROM bridge_runtime WHERE key=?').get('cloud_cursor:'+G2+':'+child).value,'500000000000000001');
});

test('channel activation accepts early-epoch cursor sentinels but rejects corrupt or overflowing cursor state',async t=>{
 const env=setup({DISCORD_GUILDS_JSON:JSON.stringify([profile({since:'2015-01-01T00:00:00Z'})])}),raw=database(t,env);await discordGuildActivation(env,G2);
 env.DISCORD_GUILDS_JSON=JSON.stringify([profile({allowed_channel_ids:[C2,C3],poll_channel_ids:[C2,C3],since:'2015-01-01T00:00:00Z'})]);
 const key='cloud_cursor:'+G2+':'+C3;raw.prepare('INSERT INTO bridge_runtime VALUES(?,?,?)').run(key,'0',Date.now());assert.equal((await discordChannelActivation(env,G2,C3)).since_ms,1420070400000);
 raw.prepare("DELETE FROM bridge_runtime WHERE key LIKE 'cloud_channel_activation:%'").run();
 for(const value of ['-1','1.5','18446744073709551616','00']){raw.prepare('UPDATE bridge_runtime SET value=? WHERE key=?').run(value,key);await assert.rejects(discordChannelActivation(env,G2,C3),e=>e.code==='DISCORD_GUILD_STATE_UNAVAILABLE');}
 raw.prepare('UPDATE bridge_runtime SET value=? WHERE key=?').run('0',key);await discordChannelActivation(env,G2,C3);raw.prepare("UPDATE bridge_runtime SET value=? WHERE key LIKE 'cloud_channel_activation:%'").run('{"version":1}');await assert.rejects(discordChannelActivation(env,G2,C3),e=>e.code==='DISCORD_GUILD_STATE_UNAVAILABLE');
});
