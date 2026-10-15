import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {discordGuildProfiles,discordGuildProfile,discordGuildEnv,discordGuildScope,discordPrimaryGuildId,discordGuildActivation,DiscordGuildConfigError} from '../worker/discord-guilds.js';
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
