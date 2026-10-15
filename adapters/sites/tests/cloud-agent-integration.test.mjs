import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHmac,createHash} from 'node:crypto';
import worker,{events} from '../worker/index.js';
import {cloudAgentFencePrefix} from '../worker/cloud-agent.js';

const USER='U'+'1'.repeat(32),LINE_BOT='U'+'2'.repeat(32),EVENT='01CLOUDAGENTLINE000000001';
const GUILD='1'.repeat(18),CHANNEL='2'.repeat(18),BOT='4'.repeat(18),AUTHOR='5'.repeat(18),DM='6'.repeat(18);
const WAIT='bridge_wait_for_message',REPLY='bridge_reply_to_claim';

function setup(t,{enabled=true,discord=false}={}){
 const raw=new DatabaseSync(':memory:');t.after(()=>raw.close());
 for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'));
 const DB={raw,prepare(sql){return {bind(...values){return {
  async run(){return {meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};},
  async first(){return raw.prepare(sql).get(...values)||null;},
  async all(){return {results:raw.prepare(sql).all(...values)};},
 };}};}};
 const now=Date.now(),sent=[],messages=new Map(),env={
  DB,BRIDGE_RUNTIME:'cloud',BRIDGE_OWNER_SITE_ID:'owner',COMPANION_SHARED_KEY:Buffer.alloc(32,7).toString('base64'),
  CLOUD_AGENT_AFTER:new Date(now-60000).toISOString(),...(enabled?{CLOUD_AGENT_ENABLED:'true'}:{}),
  LINE_CHANNEL_SECRET:'synthetic-channel-secret',LINE_CHANNEL_ACCESS_TOKEN:'synthetic-channel-access-token',LINE_BOT_ID:LINE_BOT,
  LINE_ALLOWED_USER_IDS:USER,LINE_ENABLE_EVENTS:'true',LINE_ENABLE_REPLIES:'true',
  LINE_FETCH:async(url,options)=>{sent.push({platform:'line',url,body:JSON.parse(options.body)});return Response.json({});},
 };
 if(discord)Object.assign(env,{
  DISCORD_GUILD_ID:GUILD,DISCORD_BOT_ID:BOT,DISCORD_BOT_TOKEN:'synthetic-discord-token',DISCORD_OWNER_USER_ID:AUTHOR,
  DISCORD_ENABLE_EVENTS:'true',DISCORD_ENABLE_REPLIES:'true',DISCORD_ALLOWED_CHANNEL_IDS:CHANNEL,
  DISCORD_POLL_CHANNEL_IDS:CHANNEL+','+DM,DISCORD_CLOUD_SINCE:new Date(now-60000).toISOString(),
 });
 env.FETCH=async(url,options={})=>{
  const path=new URL(url).pathname.replace(/^\/api\/v10/,'');
  if(path==='/guilds/'+GUILD+'/threads/active')return Response.json({threads:[]});
  if(path==='/channels/'+CHANNEL)return Response.json({id:CHANNEL,guild_id:GUILD,type:0});
  if(path==='/channels/'+DM)return Response.json({id:DM,type:1,recipients:[{id:AUTHOR}]});
  const route=/^\/channels\/(\d+)\/messages(?:\/(\d+))?$/.exec(path);
  if(route&&options.method==='POST'){
   const body=JSON.parse(options.body);sent.push({platform:'discord',channel:route[1],body});
   return Response.json({id:'9'.repeat(18),channel_id:route[1]});
  }
  if(route&&route[2])return Response.json(messages.get(route[1]+':'+route[2])||{}, {status:messages.has(route[1]+':'+route[2])?200:404});
  if(route)return Response.json([...messages.values()].filter(message=>message.channel_id===route[1]));
  throw Error('Unexpected synthetic Discord route');
 };
 return {env,raw,sent,messages,now};
}
async function rpc(env,method,params={},owner='owner',ctx){
 const response=await worker.fetch(new Request('https://site.example/mcp',{
  method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':owner},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
 }),env,ctx);
 const body=await response.json();
 return {response,body,value:body.result?.content?.[0]?.text?JSON.parse(body.result.content[0].text):null};
}
const tool=(env,name,args={},owner,ctx)=>rpc(env,'tools/call',{name,arguments:args},owner,ctx);
async function lineIntake(s,{token='synthetic-reply-token',content='untrusted LINE fixture',eventId=EVENT,userId=USER}={}){
 const body=JSON.stringify({destination:LINE_BOT,events:[{webhookEventId:eventId,type:'message',timestamp:Date.now(),source:{type:'user',userId},message:{id:'fixture-platform-message',type:'text',text:content},...(token?{replyToken:token}:{})}]});
 const signature=createHmac('sha256',s.env.LINE_CHANNEL_SECRET).update(body).digest('base64');
 const response=await worker.fetch(new Request('https://site.example/webhooks/line',{method:'POST',headers:{'content-type':'application/json','x-line-signature':signature},body}),s.env);
 assert.equal(response.status,200);
}
async function discordIntake(s,scope='dm',content='untrusted Discord fixture'){
 const id=String((BigInt(s.now-1420070400000)<<22n)+(scope==='dm'?1n:2n));
 const channel=scope==='dm'?DM:CHANNEL;
 const message={id,channel_id:channel,author:{id:AUTHOR,bot:false},mentions:scope==='dm'?[]:[{id:BOT}],content,timestamp:new Date(s.now).toISOString()};
 s.messages.set(channel+':'+id,message);
 if(scope==='dm')s.raw.prepare("INSERT OR IGNORE INTO dm_contacts (channel_id,user_id,guild_id,owner_site_id,source_channel_id,source_message_id,delivery_status,authorized_at,updated_at) VALUES (?,?,?,?,?,?,'sent',?,?)").run(DM,AUTHOR,GUILD,'owner',CHANNEL,'7'.repeat(18),s.now-60000,s.now-60000);
 await events.enqueue(s.env,{guild_id:GUILD,channel_id:channel,message_id:id,...(scope==='dm'?{scope:'dm'}:{})});
 return message;
}
function replyArgs(claim,content='Cloud Codex reply'){return {lease_id:claim.lease_id,claim_id:claim.claim_id,content};}

test('static tool catalog is unchanged by activation and keeps private caching',async t=>{
 const s=setup(t,{enabled:false});
 const before=await rpc(s.env,'tools/list');s.env.CLOUD_AGENT_ENABLED='true';const after=await rpc(s.env,'tools/list');
 assert.deepEqual(before.body.result.tools,after.body.result.tools);
 for(const name of [WAIT,REPLY])assert.equal(before.body.result.tools.some(tool=>tool.name===name),true);
 const version='2026-07-28',response=await worker.fetch(new Request('https://site.example/mcp',{
  method:'POST',headers:{'content-type':'application/json','MCP-Protocol-Version':version,'Mcp-Method':'tools/list'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:{'io.modelcontextprotocol/protocolVersion':version,'io.modelcontextprotocol/clientCapabilities':{}}}}),
 }),s.env);
 const body=await response.json();assert.equal(body.result.cacheScope,'private');assert.equal(body.result.resultType,'complete');
});

test('cloud tools preserve owner authentication and remain disabled by default',async t=>{
 const s=setup(t,{enabled:false});await lineIntake(s);
 for(const owner of ['', 'other'])for(const name of [WAIT,REPLY]){
  const result=await tool(s.env,name,name===WAIT?{wait_ms:0}:{lease_id:'x'.repeat(32),claim_id:'y'.repeat(32),content:'not allowed'},owner);
  assert.equal(result.response.status,owner?403:401);
 }
 const disabled=await tool(s.env,WAIT,{wait_ms:0});assert.equal(disabled.body.result.isError,true);assert.equal(disabled.value.error,'CLOUD_AGENT_DISABLED');
 assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM bridge_runtime WHERE key LIKE 'cloud_agent:%'").get().n,0);
 assert.equal(s.sent.length,0);
});

test('LINE wait claims one source without reply tokens, and replies once through the fixed recipient path',async t=>{
 const s=setup(t);await lineIntake(s,{token:null});
 const waiting=await tool(s.env,WAIT,{wait_ms:0});assert.equal(waiting.body.result.isError,false);
 const claim=waiting.value;assert.equal(claim.status,'message');assert.equal(claim.content,'untrusted LINE fixture');assert.equal(claim.reply_kind,'line_reply');
 for(const secret of ['synthetic-channel-access-token','synthetic-channel-secret','synthetic-reply-token'])assert.equal(JSON.stringify(waiting.body).includes(secret),false);
 const first=await tool(s.env,REPLY,replyArgs(claim));assert.equal(first.value.status,'completed');
 const duplicate=await tool(s.env,REPLY,replyArgs(claim));assert.equal(duplicate.value.duplicate,true);
 assert.equal(s.sent.length,1);assert.equal(s.sent[0].url,'https://api.line.me/v2/bot/message/push');assert.equal(s.sent[0].body.to,USER);
 assert.equal(s.sent[0].body.messages[0].text,'Cloud Codex reply');
});

test('fresh LINE claims recover only encrypted confirmed context from the same approved conversation',async t=>{
 const s=setup(t);await lineIntake(s,{content:'Remember the synthetic code PEACH-42'});
 const first=(await tool(s.env,WAIT,{wait_ms:0})).value;assert.deepEqual(first.conversation_context.messages,[]);
 const sent=await tool(s.env,REPLY,replyArgs(first,'I will remember PEACH-42'));assert.equal(sent.value.status,'completed');
 const memory=s.raw.prepare("SELECT key,value FROM bridge_runtime WHERE key LIKE 'cloud_context:v1:%'").get();assert.ok(memory);
 assert.equal(memory.value.includes('PEACH-42'),false);assert.equal(memory.key.includes(USER),false);
 await lineIntake(s,{eventId:EVENT+'NEXT',content:'What code did I give you?'});
 const next=(await tool({...s.env},WAIT,{wait_ms:0,lease_id:first.lease_id})).value;assert.equal(next.status,'message');
 assert.deepEqual(next.conversation_context.messages.map(message=>[message.role,message.content]),[['user','Remember the synthetic code PEACH-42'],['assistant','I will remember PEACH-42']]);
 const other='U'+'8'.repeat(32);s.env.LINE_ALLOWED_USER_IDS=USER+','+other;
 await tool(s.env,REPLY,replyArgs(next,'PEACH-42'));
 await lineIntake(s,{eventId:EVENT+'OTHER',content:'What private code?',userId:other});
 const different=(await tool(s.env,WAIT,{wait_ms:0,lease_id:first.lease_id})).value;
 assert.equal(different.status,'message');assert.deepEqual(different.conversation_context.messages,[]);
 assert.equal(JSON.stringify(different).includes('PEACH-42'),false);
});

test('failed and ambiguous LINE sends never enter successful conversation context',async t=>{
 for(const status of [400,500]){
  const s=setup(t);s.env.LINE_FETCH=async()=>Response.json({message:'synthetic rejection'},{status});
  await lineIntake(s,{content:'unconfirmed private input'});const claim=(await tool(s.env,WAIT,{wait_ms:0})).value;
  const result=(await tool(s.env,REPLY,replyArgs(claim,'unconfirmed private answer'))).value;assert.notEqual(result.status,'completed');
  assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM bridge_runtime WHERE key LIKE 'cloud_context:v1:%'").get().n,0);
 }
});

test('context read rechecks current LINE sender authorization after a claim is reserved',async t=>{
 const s=setup(t);await lineIntake(s);const first=(await tool(s.env,WAIT,{wait_ms:0})).value;
 await tool(s.env,REPLY,replyArgs(first,'private authorized context'));
 await lineIntake(s,{eventId:EVENT+'REVOKE'});
 const prepare=s.env.DB.prepare.bind(s.env.DB);let revoked=false;
 s.env.DB.prepare=sql=>({bind(...values){const statement=prepare(sql).bind(...values);return {...statement,async run(){const result=await statement.run();if(!revoked&&sql.startsWith('UPDATE bridge_runtime SET value=')&&String(values[0]).includes('"state":"claimed"')){revoked=true;s.env.LINE_ALLOWED_USER_IDS='U'+'9'.repeat(32);}return result;}};}});
 const result=await tool(s.env,WAIT,{wait_ms:0,lease_id:first.lease_id});assert.equal(revoked,true);
 assert.equal(result.value.status==='message',false);assert.equal(JSON.stringify(result.body).includes('private authorized context'),false);
});

test('claim and lease mismatches and arbitrary recipient arguments never send',async t=>{
 const s=setup(t);await lineIntake(s);const claim=(await tool(s.env,WAIT,{wait_ms:0})).value;
 const lostLease=await tool(s.env,REPLY,{...replyArgs(claim),lease_id:'x'.repeat(32)});assert.equal(lostLease.value.status,'lease_lost');
 const lostClaim=await tool(s.env,REPLY,{...replyArgs(claim),claim_id:'y'.repeat(32)});assert.equal(lostClaim.value.status,'claim_lost');
 const arbitrary=await tool(s.env,REPLY,{...replyArgs(claim),recipient_id:'U'+'9'.repeat(32)});assert.equal(arbitrary.value.error,'UNKNOWN_ARGUMENT');
 assert.equal(s.sent.length,0);
});

test('LINE sender authorization is rechecked between claim and reply',async t=>{
 const s=setup(t);await lineIntake(s);const claim=(await tool(s.env,WAIT,{wait_ms:0})).value;
 s.env.LINE_ALLOWED_USER_IDS='U'+'9'.repeat(32);
 const result=await tool(s.env,REPLY,replyArgs(claim));assert.equal(result.value.status,'source_unavailable');assert.equal(s.sent.length,0);
 assert.equal(s.raw.prepare('SELECT COUNT(*) n FROM actions').get().n,0);
});

test('every existing LINE action state is excluded instead of reopening an uncertain send',async t=>{
 for(const status of ['reserved','retryable','unknown','failed','completed']){
  const s=setup(t);await lineIntake(s);
  s.raw.prepare('INSERT INTO actions (action_key,kind,source_id,recipient_id,status,created_at) VALUES (?,?,?,?,?,?)').run('linereply:'+EVENT,'linereply',EVENT,USER,status,Date.now());
  const result=await tool(s.env,WAIT,{wait_ms:0});assert.equal(result.value.status,'empty',status);assert.equal(s.sent.length,0);
 }
});

test('a full timestamp-tied page of deleted Discord sources cannot starve the next approved Discord event',async t=>{
 const s=setup(t,{discord:true});const message=await discordIntake(s,'guild');
 const createdAt=s.raw.prepare('SELECT created_at FROM event_records WHERE id=?').get('discord_message_'+message.id).created_at;
 const insert=s.raw.prepare('INSERT INTO event_records (id,data_json,occurred_at,created_at) VALUES (?,?,?,?)');
 for(let index=0;index<100;index++){
  const id=String(BigInt(message.id)-200n+BigInt(index));
  insert.run('discord_message_'+id,JSON.stringify({guild_id:GUILD,channel_id:CHANNEL,message_id:id,author_id:AUTHOR,mentions_bot:true}),new Date(s.now).toISOString(),createdAt);
 }
 const result=await tool(s.env,WAIT,{wait_ms:0});
 assert.equal(result.body.result.isError,false);assert.equal(result.value.status,'message');assert.equal(result.value.source_key,'discord_guild:'+CHANNEL+':'+message.id);assert.equal(result.value.content,'untrusted Discord fixture');
 assert.equal(s.sent.length,0);
});

test('fresh LINE input returns while an earlier Discord collection is pending and its lifetime remains tracked',async t=>{
 const s=setup(t,{discord:true}),lifetime=[];let release,started;
 const gate=new Promise(resolve=>{release=resolve;}),begin=new Promise(resolve=>{started=resolve;});
 t.after(()=>release());const fetch=s.env.FETCH;let blocked=false,completed=false;
 s.env.FETCH=async(url,options)=>{
  if(!blocked&&new URL(url).pathname==='/api/v10/channels/'+CHANNEL){blocked=true;started();await gate;completed=true;}
  return fetch(url,options);
 };
 const pending=tool(s.env,WAIT,{wait_ms:2000},'owner',{waitUntil:task=>lifetime.push(task)});
 await begin;await lineIntake(s);
 const result=await pending;assert.equal(result.value.status,'message');assert.equal(result.value.source_key,'line:'+EVENT);
 assert.equal(completed,false);assert.ok(lifetime.length>0);assert.equal(s.sent.length,0);
 release();await Promise.all(lifetime);assert.equal(completed,true);
});

test('a currently revoked LINE backlog cannot hide the next approved sender',async t=>{
 const s=setup(t);await lineIntake(s);
 const row=s.raw.prepare('SELECT occurred_at,created_at FROM cloud_line_messages WHERE event_id=?').get(EVENT),insert=s.raw.prepare('INSERT INTO cloud_line_messages VALUES (?,?,?,?,?)');
 for(let index=0;index<100;index++)insert.run('00REVOKEDLINE'+String(index).padStart(8,'0'),'U'+'9'.repeat(32),'unreadable-revoked-payload',row.occurred_at,row.created_at);
 const result=await tool(s.env,WAIT,{wait_ms:0});assert.equal(result.value.status,'message');assert.equal(result.value.source_key,'line:'+EVENT);
});

test('forty unknown send fences without action receipts cannot starve the forty-first source or cross owner namespaces',async t=>{
 const s=setup(t),prefix=await cloudAgentFencePrefix('owner'),insert=s.raw.prepare('INSERT INTO bridge_runtime (key,value,updated_at) VALUES (?,?,?)');
 const sourceHash=source=>createHash('sha256').update(source).digest('hex');
 for(let index=0;index<40;index++){
  const eventId='00FENCEDLINE'+String(index).padStart(8,'0');await lineIntake(s,{eventId,content:'previously attempted fixture '+index});
  const source='line:'+eventId;
  insert.run(prefix+sourceHash(source),JSON.stringify({source_key:source,claim_id:'old-claim-'+index,status:'unknown',content_hash:'fixture-hash'}),Date.now());
 }
 await lineIntake(s);const available='line:'+EVENT;
 // A previous owner's tombstone must not suppress the current owner's source.
 insert.run(await cloudAgentFencePrefix('another-owner')+sourceHash(available),JSON.stringify({source_key:available,claim_id:'foreign-claim',status:'unknown'}),Date.now());
 assert.equal(s.raw.prepare('SELECT COUNT(*) n FROM actions').get().n,0);
 const result=await tool(s.env,WAIT,{wait_ms:0});assert.equal(result.body.result.isError,false);assert.equal(result.value.status,'message');assert.equal(result.value.source_key,available);
 assert.equal(s.sent.length,0);
});

test('Discord DM claims reuse the current contact authorization and fixed-channel reply path',async t=>{
 const s=setup(t,{discord:true});const message=await discordIntake(s);
 const claim=(await tool(s.env,WAIT,{wait_ms:0})).value;assert.equal(claim.status,'message');assert.equal(claim.reply_kind,'discord_reply_dm');
 const result=await tool(s.env,REPLY,replyArgs(claim));assert.equal(result.value.status,'completed');
 assert.equal(s.sent.length,1);assert.equal(s.sent[0].platform,'discord');assert.equal(s.sent[0].channel,DM);
 assert.deepEqual(s.sent[0].body.allowed_mentions,{parse:[],replied_user:false});assert.equal(s.sent[0].body.enforce_nonce,true);
 assert.equal(s.raw.prepare('SELECT status FROM actions WHERE action_key=?').get('dmreply:'+message.id).status,'completed');
});

test('Discord continuation recalls the same DM but never copies its context to a guild claim',async t=>{
 const s=setup(t,{discord:true});await discordIntake(s,'dm','private DM code PEAR-17');
 const first=(await tool(s.env,WAIT,{wait_ms:0})).value;assert.deepEqual(first.conversation_context.messages,[]);
 const result=(await tool(s.env,REPLY,replyArgs(first,'I remember PEAR-17'))).value;assert.equal(result.status,'completed');assert.equal(result.context_recorded,true);
 s.now+=1;await discordIntake(s,'dm','What was my code?');
 const next=(await tool(s.env,WAIT,{wait_ms:0,lease_id:first.lease_id})).value;assert.equal(next.reply_kind,'discord_reply_dm');
 assert.deepEqual(next.conversation_context.messages.map(message=>message.content),['private DM code PEAR-17','I remember PEAR-17']);
 await tool(s.env,REPLY,replyArgs(next,'PEAR-17'));
 s.now+=1;await discordIntake(s,'guild','What private DM code?');
 const guild=(await tool(s.env,WAIT,{wait_ms:0,lease_id:first.lease_id})).value;assert.equal(guild.reply_kind,'discord_reply_to_mention');
 assert.deepEqual(guild.conversation_context.messages,[]);assert.equal(JSON.stringify(guild).includes('PEAR-17'),false);
});

test('a current Discord channel policy withdrawal blocks retained context before claim delivery',async t=>{
 const s=setup(t,{discord:true});await discordIntake(s,'guild','private authorized guild context');
 const first=(await tool(s.env,WAIT,{wait_ms:0})).value;await tool(s.env,REPLY,replyArgs(first,'authorized guild answer'));
 s.now+=1;await discordIntake(s,'guild','followup');
 const prepare=s.env.DB.prepare.bind(s.env.DB);let revoked=false;
 s.env.DB.prepare=sql=>({bind(...values){const statement=prepare(sql).bind(...values);return {...statement,async run(){const result=await statement.run();if(!revoked&&sql.startsWith('UPDATE bridge_runtime SET value=')&&String(values[0]).includes('"state":"claimed"')){revoked=true;s.env.DISCORD_ALLOWED_CHANNEL_IDS='8'.repeat(18);}return result;}};}});
 const result=await tool(s.env,WAIT,{wait_ms:0,lease_id:first.lease_id});assert.equal(revoked,true);
 assert.equal(result.value.status==='message',false);assert.equal(JSON.stringify(result.body).includes('authorized guild answer'),false);
});

test('Discord stop requests observed after claiming are never answered',async t=>{
 const s=setup(t,{discord:true});const message=await discordIntake(s);
 const claim=(await tool(s.env,WAIT,{wait_ms:0})).value;assert.equal(claim.status,'message');
 message.content='stop';const result=await tool(s.env,REPLY,replyArgs(claim));
 assert.equal(result.value.status,'source_unavailable');assert.equal(s.sent.length,0);
 assert.equal(s.raw.prepare('SELECT blocked FROM dm_preferences WHERE user_id=?').get(AUTHOR).blocked,1);
});

test('guild replies require a current explicit bot mention and use the claimed message reference',async t=>{
 const s=setup(t,{discord:true});const message=await discordIntake(s,'guild');
 const claim=(await tool(s.env,WAIT,{wait_ms:0})).value;assert.equal(claim.status,'message');assert.equal(claim.reply_kind,'discord_reply_to_mention');
 const result=await tool(s.env,REPLY,replyArgs(claim,'short public reply'));assert.equal(result.value.status,'completed');
 assert.equal(s.sent.length,1);assert.equal(s.sent[0].channel,CHANNEL);assert.equal(s.sent[0].body.message_reference.message_id,message.id);
});

test('guild permissions revoked after claim prevent the fixed reply',async t=>{
 const s=setup(t,{discord:true});await discordIntake(s,'guild');
 const claim=(await tool(s.env,WAIT,{wait_ms:0})).value;s.env.DISCORD_ALLOWED_CHANNEL_IDS='8'.repeat(18);
 assert.equal((await tool(s.env,REPLY,replyArgs(claim))).value.status,'source_unavailable');assert.equal(s.sent.length,0);
});

test('bridge status exposes safe agent state without lease, claim, body or bot credentials',async t=>{
 const s=setup(t);await lineIntake(s);const claim=(await tool(s.env,WAIT,{wait_ms:0})).value;
 const result=await tool(s.env,'bridge_status',{}),status=result.value.cloud_agent;assert.equal(status.enabled,true);assert.equal(status.lease_active,true);assert.equal(status.claim_pending,true);
 for(const value of [claim.lease_id,claim.claim_id,claim.content,'synthetic-channel-access-token','synthetic-channel-secret'])assert.equal(JSON.stringify(status).includes(value),false);
 assert.equal(status.lease_id,undefined);assert.equal(status.claim_id,undefined);
});

test('wait telemetry records only a returned message and keeps the original read observation meaning',async t=>{
 const s=setup(t);await lineIntake(s);
 assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM bridge_runtime WHERE key LIKE 'delivery_diag:%'").get().n,0);
 const before=Date.now(),claim=(await tool(s.env,WAIT,{wait_ms:0})).value,after=Date.now();assert.equal(claim.status,'message');
 const status=(await tool(s.env,'bridge_status',{})).value.delivery_diagnostics;
 assert.equal(status.read_observation,'successful_read_tool_entry_not_model_start');
 const trace=status.messages.find(message=>message.event_id==='line_'+EVENT);assert.ok(trace);
 assert.ok(Date.parse(trace.first_read_tool_at)>=before);assert.ok(Date.parse(trace.first_read_tool_at)<=after);
 assert.equal(trace.confirmed_completed_at,null);
});

test('active cloud agent makes the browser receiver standby without collecting, sending or weakening auth',async t=>{
 const s=setup(t,{discord:true});let requests=0;s.env.FETCH=async()=>{requests++;throw Error('must not collect');};
 const request=owner=>new Request('https://site.example/runtime/tick',{method:'POST',headers:{'content-type':'application/json',origin:'https://site.example','oai-authenticated-user-id':owner},body:'{}'});
 const denied=await worker.fetch(request('other'),s.env);assert.equal(denied.status,403);
 const response=await worker.fetch(request('owner'),s.env);assert.equal(response.status,200);assert.equal((await response.json()).mode,'standby');
 assert.equal(requests,0);assert.equal(s.sent.length,0);assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM bridge_runtime WHERE key='cloud_maintenance'").get().n,0);
});

test('disabled cloud agent retains browser maintenance and enabled agent retains explicit MCP maintenance',async t=>{
 const s=setup(t,{enabled:false});
 const response=await worker.fetch(new Request('https://site.example/runtime/tick',{method:'POST',headers:{'content-type':'application/json',origin:'https://site.example','oai-authenticated-user-id':'owner'},body:'{}'}),s.env);
 assert.equal(response.status,200);assert.equal((await response.json()).mode,'cloud_polling');
 s.env.CLOUD_AGENT_ENABLED='true';const result=await tool(s.env,'bridge_maintain',{});assert.equal(result.body.result.isError,false);assert.equal(result.value.source,'mcp');
});
