import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {eventCryptoForTest as codec} from '../worker/events.js';
import {collectCloudDiscord} from '../worker/cloud-runtime.js';
import {readConversationContext,recordConversationReply,ConversationContextError} from '../worker/conversation-context.js';
import {recordDeliveryTiming,discordDiagnosticSource,deliveryDiagnostics} from '../worker/delivery-diagnostics.js';
import {discordGuildEnv} from '../worker/discord-guilds.js';

const G1='1'.repeat(18),G2='2'.repeat(18),G3='3'.repeat(18),C1='4'.repeat(18),C2='5'.repeat(18),C3='6'.repeat(18),DM='7'.repeat(18),BOT='8'.repeat(18),HUMAN='9'.repeat(18);
const snowflake=(at,n=1)=>String((BigInt(at-1420070400000)<<22n)+BigInt(n));
function setup(t){
 const raw=new DatabaseSync(':memory:');t.after(()=>raw.close());
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
 const DB={prepare(sql){return{bind(...values){return{async first(){return raw.prepare(sql).get(...values)||null;},async all(){return{results:raw.prepare(sql).all(...values)};},async run(){return{meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};}};}};}};
 const now=Date.now(),env={DB,BRIDGE_RUNTIME:'cloud',BRIDGE_OWNER_SITE_ID:'owner',COMPANION_SHARED_KEY:Buffer.alloc(32,3).toString('base64'),DISCORD_GUILD_ID:G1,DISCORD_BOT_ID:BOT,DISCORD_OWNER_USER_ID:HUMAN,DISCORD_ENABLE_EVENTS:'true',DISCORD_ALLOWED_CHANNEL_IDS:C1,DISCORD_POLL_CHANNEL_IDS:C1,DISCORD_CLOUD_SINCE:new Date(now-60000).toISOString()};
 const profiles=[{guild_id:G2,label:'private profile label',allowed_channel_ids:[C2],poll_channel_ids:[C2],since:new Date(now-30000).toISOString()}];
 const save=()=>{env.DISCORD_GUILDS_JSON=JSON.stringify(profiles);};save();
 const channels=new Map([[C1,{id:C1,guild_id:G1,type:0}],[C2,{id:C2,guild_id:G2,type:0}],[C3,{id:C3,guild_id:G3,type:0}],[DM,{id:DM,type:1,recipients:[{id:HUMAN}]}]]),messages=new Map(),reads=[],queued=[];
 const deps={configured:()=>true,discord:async(scoped,path)=>{reads.push({guild:scoped.DISCORD_GUILD_ID,path});const parsed=/^\/channels\/([0-9]+)(\/messages)?/.exec(path);if(!parsed)throw Error('unexpected path');return parsed[2]?(messages.get(parsed[1])||[]):channels.get(parsed[1]);},events:{enqueue:async(scoped,input)=>{queued.push({guild:scoped.DISCORD_GUILD_ID,input});}}};
 const message=(channel,at,n=1)=>({id:snowflake(at,n),channel_id:channel,author:{id:HUMAN},content:'untrusted body',timestamp:new Date(at).toISOString()});
 const context=(channel=C1,guild=G1,at=now-10000,n=1)=>({source_key:`discord_guild:${channel}:${snowflake(at,n)}`,source_id:snowflake(at,n),conversation_key:guild===G1?'discord_guild:'+channel:`discord_guild:${guild}:${channel}`,reply_kind:'discord_reply_to_mention',content:'private input '+guild,timestamp:new Date(at).toISOString()});
 return{raw,env,profiles,save,now,channels,messages,reads,queued,deps,message,context};
}

test('each guild honors its explicit activation from the first poll and persists an independent cursor',async t=>{
 const s=setup(t);s.messages.set(C1,[s.message(C1,s.now-1000)]);s.messages.set(C2,[s.message(C2,s.now-1000,2),s.message(C2,s.now-40000,2)]);
 const result=await collectCloudDiscord(s.env,s.deps);assert.equal(result.observed,2);assert.deepEqual(result.failures,[]);assert.deepEqual(new Set(s.queued.map(item=>item.guild)),new Set([G1,G2]));
 assert.equal(s.raw.prepare('SELECT value FROM bridge_runtime WHERE key=?').get('cloud_cursor:'+C1).value,snowflake(s.now-1000));assert.equal(s.raw.prepare('SELECT value FROM bridge_runtime WHERE key=?').get(`cloud_cursor:${G2}:${C2}`).value,snowflake(s.now-1000,2));
 assert.ok(s.queued.every(item=>item.input.guild_id===item.guild));assert.equal(s.queued.some(item=>item.input.message_id===snowflake(s.now-40000,2)),false);
 s.profiles[0].since=new Date(s.now-3600000).toISOString();s.save();assert.equal((await collectCloudDiscord(s.env,s.deps)).observed,0);
 for(const secret of [G1,G2,C1,C2,'private profile label','untrusted body'])assert.equal(JSON.stringify(result).includes(secret),false);
});

test('a channel added to an old profile starts at its own first-seen baseline rather than replaying old messages',async t=>{
 const s=setup(t);await collectCloudDiscord(s.env,s.deps);s.channels.set(C3,{id:C3,guild_id:G2,type:0});s.profiles[0].allowed_channel_ids.push(C3);s.profiles[0].poll_channel_ids.push(C3);s.save();s.messages.set(C3,[s.message(C3,s.now-1000)]);
 assert.equal((await collectCloudDiscord(s.env,s.deps)).observed,0);const baseline=s.raw.prepare('SELECT value FROM bridge_runtime WHERE key=?').get(`cloud_cursor:${G2}:${C3}`).value;assert.ok(BigInt(baseline)>BigInt(snowflake(s.now-1000)));
 const fresh=s.message(C3,Date.now()+1);s.messages.set(C3,[fresh,...s.messages.get(C3)]);assert.equal((await collectCloudDiscord(s.env,s.deps)).observed,1);assert.equal(s.queued.at(-1).input.message_id,fresh.id);
});

test('current channel revocation is enforced before any message-body fetch on primary and additional guilds',async t=>{
 for(const additional of [false,true]){
  const s=setup(t),original=s.deps.discord,target=additional?C2:C1;
  s.deps.discord=async(env,path)=>{const result=await original(env,path);if(path==='/channels/'+target){if(additional){s.profiles[0].allowed_channel_ids=[C3];s.profiles[0].poll_channel_ids=[C3];s.save();}else s.env.DISCORD_ALLOWED_CHANNEL_IDS=DM;}return result;};
  const result=await collectCloudDiscord(s.env,s.deps);assert.equal(result.observed,0);assert.ok(result.failures.some(code=>code.endsWith(':CHANNEL_NOT_ALLOWED')));assert.equal(s.reads.some(item=>item.path.startsWith('/channels/'+target+'/messages')),false);assert.equal(s.queued.length,0);
 }
});

test('a failed guild cannot prevent another guild from collecting and an exhausted budget rotates the next first channel',async t=>{
 const s=setup(t),original=s.deps.discord;let now=s.now; t.mock.method(Date,'now',()=>now);
 s.messages.set(C2,[s.message(C2,s.now-1000)]);let stalled=true;
 s.deps.discord=async(env,path)=>{if(path==='/channels/'+C1&&stalled){now+=21000;return s.channels.get(C1);}return original(env,path);};
 const first=await collectCloudDiscord(s.env,s.deps);assert.equal(first.observed,0);assert.ok(first.failures.some(code=>code.endsWith(':RECOVERY_CONTINUES_NEXT_TICK')));
 s.reads.length=0;stalled=false;const second=await collectCloudDiscord(s.env,s.deps);assert.equal(s.reads[0].path,'/channels/'+C2);assert.equal(second.observed,1);assert.equal(s.queued[0].guild,G2);
 s.profiles.push({guild_id:G3,allowed_channel_ids:[C3],poll_channel_ids:[C3],since:new Date(s.now-30000).toISOString()});s.save();s.messages.set(C3,[s.message(C3,s.now-1000)]);
 s.deps.discord=async(env,path)=>{if(path==='/channels/'+C1)throw Object.assign(Error('private upstream body'),{code:'DISCORD_403'});return original(env,path);};
 const third=await collectCloudDiscord(s.env,s.deps);assert.equal(third.observed,1);assert.ok(third.failures.some(code=>code.endsWith(':DISCORD_403')));assert.equal(s.queued.at(-1).guild,G3);assert.equal(JSON.stringify(third).includes('private upstream body'),false);
});

test('additional profiles cannot seed DMs and existing primary owner DM authorization is preserved',async t=>{
 const s=setup(t);s.env.DISCORD_POLL_CHANNEL_IDS=DM;s.env.DISCORD_ALLOWED_CHANNEL_IDS=C1;
 s.channels.set(C2,{id:C2,type:1,recipients:[{id:HUMAN}]});const authorized=s.now-60000;
 s.raw.prepare("INSERT INTO dm_contacts(channel_id,user_id,guild_id,owner_site_id,source_channel_id,source_message_id,delivery_status,authorized_at,updated_at) VALUES (?,?,?,?,?,?,'sent',?,?)").run(DM,HUMAN,G1,'owner',C1,'legacy-source',authorized,authorized);
 const before=s.raw.prepare('SELECT * FROM dm_contacts').get(),result=await collectCloudDiscord(s.env,s.deps);
 assert.ok(result.failures.some(code=>code.endsWith(':DM_CHANNEL_NOT_ALLOWED')));assert.equal(s.reads.some(item=>item.path.startsWith('/channels/'+C2+'/messages')),false);assert.deepEqual(s.raw.prepare('SELECT * FROM dm_contacts').get(),before);assert.equal(s.raw.prepare('SELECT COUNT(*) n FROM dm_contacts').get().n,1);
});

test('malformed opt-in configuration fails closed before network reads and still releases the shared lease',async t=>{
 const s=setup(t);s.env.DISCORD_GUILDS_JSON='[{"guild_id":"bad"}]';await assert.rejects(collectCloudDiscord(s.env,s.deps),/DISCORD_GUILDS_INVALID/);assert.equal(s.reads.length,0);assert.equal(s.queued.length,0);assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM bridge_runtime WHERE key='cloud_lease'").get().n,0);
});

test('primary guild and DM keep their original encrypted history scope when additional profiles are enabled',async t=>{
 const s=setup(t);delete s.env.DISCORD_GUILDS_JSON;
 const primary=s.context(),dm={...s.context(DM),source_key:`discord_dm:${DM}:${snowflake(s.now-10000)}`,conversation_key:'discord_dm:'+DM,reply_kind:'discord_reply_dm'};
 // Build pre-multi-guild ciphertext using the original scope/key formula,
 // independently of the new location function used by record/read operations.
 const hash=value=>createHash('sha256').update(value).digest('hex');
 for(const [message,reply] of [[primary,'legacy primary answer'],[dm,'legacy DM answer']]){
  const scope=JSON.stringify(['owner',message.reply_kind,BOT,G1,message.conversation_key]),key='cloud_context:v1:'+hash('owner')+':'+hash(scope);
  const value=await codec.seal(s.env,{version:1,scope,turns:[{source_key:message.source_key,source_id:message.source_id,input:message.content,reply,at:Date.parse(message.timestamp),confirmed_at:s.now-5000}],truncated:false},key);s.raw.prepare('INSERT INTO bridge_runtime VALUES (?,?,?)').run(key,value,s.now-5000);
 }
 const keys=s.raw.prepare("SELECT key FROM bridge_runtime WHERE key GLOB 'cloud_context:v1:*' ORDER BY key").all();s.save();
 const next=s.context(C1,G1,s.now),nextDm={...dm,source_key:`discord_dm:${DM}:${snowflake(s.now)}`,source_id:snowflake(s.now),timestamp:new Date(s.now).toISOString()};
 assert.equal((await readConversationContext(s.env,'owner',next)).messages[1].content,'legacy primary answer');assert.equal((await readConversationContext(s.env,'owner',nextDm)).messages[1].content,'legacy DM answer');assert.deepEqual(s.raw.prepare("SELECT key FROM bridge_runtime WHERE key GLOB 'cloud_context:v1:*' ORDER BY key").all(),keys);
 await assert.rejects(readConversationContext(discordGuildEnv(s.env,G2),'owner',nextDm),ConversationContextError);
});

test('additional guild context uses its actual guild and canonical source-bound conversation without leaking primary or DM text',async t=>{
 const s=setup(t),primary=s.context(),extra=s.context(C2,G2);await recordConversationReply(s.env,'owner',primary,{content:'private primary answer',status:'completed'});await recordConversationReply(s.env,'owner',extra,{content:'private extra answer',status:'completed'});
 assert.deepEqual((await readConversationContext(s.env,'owner',s.context(C2,G2,s.now))).messages.map(message=>message.content),[extra.content,'private extra answer']);assert.deepEqual((await readConversationContext(s.env,'owner',s.context(C1,G1,s.now))).messages.map(message=>message.content),[primary.content,'private primary answer']);
 // A legacy key always names the primary scope, never the additional scope.
 assert.deepEqual((await readConversationContext(s.env,'owner',{...extra,conversation_key:'discord_guild:'+C2})).messages,[]);
 for(const message of [{...extra,conversation_key:`discord_guild:${G1}:${C2}`},{...extra,conversation_key:`discord_guild:${G2}:${C1}`}])await assert.rejects(readConversationContext(s.env,'owner',message),ConversationContextError);
 await assert.rejects(readConversationContext(discordGuildEnv(s.env,G2),'owner',s.context(C1,G1,s.now)),ConversationContextError);
 s.profiles[0].enabled=false;s.save();await assert.rejects(readConversationContext(s.env,'owner',s.context(C2,G2,s.now)),ConversationContextError);
 const stored=JSON.stringify(s.raw.prepare("SELECT key,value FROM bridge_runtime WHERE key GLOB 'cloud_context:v1:*'").all());for(const secret of [G1,G2,C1,C2,'private primary answer','private extra answer'])assert.equal(stored.includes(secret),false);
});

test('diagnostic metadata uses the actual guild and hides disabled or currently revoked profiles',async t=>{
 const s=setup(t),m1=s.context(),m2=s.context(C2,G2,s.now-10000,2);
 await recordDeliveryTiming(s.env,discordDiagnosticSource(s.env,'guild',s.channels.get(C1),{id:m1.source_id,channel_id:C1}),'read_tool');await recordDeliveryTiming(s.env,discordDiagnosticSource(s.env,'guild',s.channels.get(C2),{id:m2.source_id,channel_id:C2}),'read_tool');
 let status=await deliveryDiagnostics(s.env,'owner');assert.equal(status.messages.length,2);const traces=s.raw.prepare("SELECT value FROM bridge_runtime WHERE key GLOB 'delivery_diag:v1:*'").all().map(row=>JSON.parse(row.value));assert.deepEqual(new Set(traces.map(trace=>trace.guild_id)),new Set([G1,G2]));
 s.profiles[0].enabled=false;s.save();status=await deliveryDiagnostics(s.env,'owner');assert.equal(status.messages.length,1);assert.equal(status.messages[0].event_id,'discord_message_'+m1.source_id);
 s.profiles[0].enabled=true;s.profiles[0].allowed_channel_ids=[C3];s.profiles[0].poll_channel_ids=[C3];s.save();assert.equal((await deliveryDiagnostics(s.env,'owner')).messages.length,1);assert.equal(await deliveryDiagnostics(s.env,'other'),null);
});

test('additional thread diagnostics authorize the current parent in the same guild and DM diagnostics remain primary',async t=>{
 const s=setup(t),thread='10'.repeat(9),extra=s.context(thread,G2),seen=[];
 await recordDeliveryTiming(s.env,discordDiagnosticSource(s.env,'guild',{id:thread,guild_id:G2,parent_id:C2},{id:extra.source_id,channel_id:thread}),'read_tool');
 const channel=async(env,id)=>{seen.push({guild:env.DISCORD_GUILD_ID,id});return{id,guild_id:G2,parent_id:C2};};assert.equal((await deliveryDiagnostics(s.env,'owner',{channel})).messages.length,1);assert.deepEqual(seen,[{guild:G2,id:thread}]);
 const dmSource=discordDiagnosticSource(discordGuildEnv(s.env,G2),'dm',{id:DM},{id:snowflake(s.now,2),channel_id:DM});assert.equal(dmSource.guild_id,G1);
 assert.equal((await deliveryDiagnostics(s.env,'owner',{channel:async()=>({id:thread,guild_id:G1,parent_id:C2})})).messages.length,0);
});
