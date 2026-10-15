import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveDiscordInvocation,DiscordInvocationError} from '../worker/discord-invocation.js';
const G='100000000000000001',C='200000000000000001',M='300000000000000001',B='400000000000000001',R='500000000000000001',OTHER='600000000000000001';
const setup=()=>({env:{DISCORD_GUILD_ID:G,DISCORD_BOT_ID:B},ch:{id:C,guild_id:G},m:{id:M,channel_id:C,mentions:[],mention_roles:[R],content:'<@&'+R+'> read this'}});
test('only a current managed role tagged for the exact Bot grants an explicit role invocation',async()=>{
 const {env,ch,m}=setup();let guild;
 assert.deepEqual(await resolveDiscordInvocation(env,ch,m,{readRoles:async(_env,id)=>{guild=id;return [{id:R,managed:true,tags:{bot_id:B}}];}}),{mentions_bot:true,mention_kind:'bot_role'});assert.equal(guild,G);
 for(const role of [{id:R,managed:false,tags:{bot_id:B}},{id:R,managed:true,tags:{bot_id:OTHER}},{id:R,managed:true,tags:{}},{id:R,name:'same Bot name',managed:false},{id:OTHER,managed:true,tags:{bot_id:B}}])assert.deepEqual(await resolveDiscordInvocation(env,ch,m,{readRoles:async()=>[role]}),{mentions_bot:false,mention_kind:null});
});
test('a direct user mention preserves the fast path without any role catalog request',async()=>{
 const {env,ch,m}=setup();m.mentions=[{id:B}];let calls=0;assert.deepEqual(await resolveDiscordInvocation(env,ch,m,{readRoles:async()=>{calls++;throw Error();}}),{mentions_bot:true,mention_kind:'user'});assert.equal(calls,0);
});
test('everyone, message text and caller-provided resolution flags are not invocation authority',async()=>{
 const {env,ch,m}=setup();m.mention_roles=[];m.mention_everyone=true;m.mentions_bot=true;m.mention_kind='bot_role';let calls=0;
 assert.deepEqual(await resolveDiscordInvocation(env,ch,m,{readRoles:async()=>{calls++;return [{id:R,managed:true,tags:{bot_id:B}}];}}),{mentions_bot:false,mention_kind:null});assert.equal(calls,0);
});
test('malformed role input or catalog responses fail unavailable instead of persisting a false classification',async()=>{
 const {env,ch,m}=setup();for(const roles of [null,{},[{id:123,managed:true,tags:{bot_id:B}}],Array(1001).fill({id:R})])await assert.rejects(resolveDiscordInvocation(env,ch,m,{readRoles:async()=>roles}),DiscordInvocationError);
 m.mention_roles=[123];await assert.rejects(resolveDiscordInvocation(env,ch,m,{readRoles:async()=>[]}),DiscordInvocationError);
});
test('role lookup failures preserve rate limit and transport failures for the collector retry path',async()=>{
 const {env,ch,m}=setup(),fault=Object.assign(new Error('fixed'),{code:'DISCORD_RATE_LIMITED',status:429,retryAfterMs:20000});await assert.rejects(resolveDiscordInvocation(env,ch,m,{readRoles:async()=>{throw fault;}}),error=>error===fault);
});
test('actual source guild and current profile are checked before and after the catalog await',async()=>{
 const {env,ch,m}=setup();await assert.rejects(resolveDiscordInvocation(env,{...ch,guild_id:OTHER},m,{readRoles:async()=>{throw Error('must not fetch');}}),error=>error.code==='DISCORD_INVOCATION_SOURCE_NOT_ALLOWED');
 await assert.rejects(resolveDiscordInvocation(env,ch,m,{readRoles:async()=>{env.DISCORD_GUILD_ID=OTHER;return [{id:R,managed:true,tags:{bot_id:B}}];}}),error=>error.code==='DISCORD_INVOCATION_SOURCE_NOT_ALLOWED');
});
test('missing or invalid Bot identity cannot match an untagged managed role',async()=>{
 for(const bot of [undefined,'','invalid',123]){const {env,ch,m}=setup();env.DISCORD_BOT_ID=bot;let calls=0;await assert.rejects(resolveDiscordInvocation(env,ch,m,{readRoles:async()=>{calls++;return [{id:R,managed:true}];}}),error=>error.code==='DISCORD_INVOCATION_BOT_NOT_CONFIGURED');assert.equal(calls,0);}
 const {env,ch,m}=setup();await assert.rejects(resolveDiscordInvocation(env,ch,m,{readRoles:async()=>{env.DISCORD_BOT_ID=OTHER;return [{id:R,managed:true,tags:{bot_id:OTHER}}];}}),error=>error.code==='DISCORD_INVOCATION_SOURCE_NOT_ALLOWED');
});
