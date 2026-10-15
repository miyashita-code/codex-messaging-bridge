import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import worker from '../worker/index.js';
import {maintainCloud,cloudRuntimeStatus} from '../worker/cloud-runtime.js';

const G='1'.repeat(18),BAD='2'.repeat(18),GOOD='3'.repeat(18),BOT='4'.repeat(18),OWNER='5'.repeat(18);
const LINE_OWNER='U'+'1'.repeat(32),LINE_BOT='U'+'2'.repeat(32),LINE_EVENT='01ISOLATIONLINEEVENT00001';
const PRIVATE='fixture-upstream-body-with-private-token-and-url';
function setup(){
 const raw=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
 const DB={raw,prepare(sql){return {bind(...values){return {async run(){return {meta:{changes:Number(raw.prepare(sql).run(...values).changes)}}},async first(){return raw.prepare(sql).get(...values)||null},async all(){return {results:raw.prepare(sql).all(...values)}}}}}}};
 const since=Date.now()-60000,messageId=String(BigInt(Date.now()-1420070400000)<<22n),previous=String(BigInt(messageId)-100n),callbacks=[],renewals=[];
 const message={id:messageId,channel_id:GOOD,author:{id:OWNER},content:'untrusted fixture content',mentions:[{id:BOT}],timestamp:new Date().toISOString()};
 const env={DB,BRIDGE_RUNTIME:'cloud',BRIDGE_OWNER_SITE_ID:'owner',COMPANION_SHARED_KEY:Buffer.alloc(32,1).toString('base64'),DISCORD_ENABLE_EVENTS:'true',DISCORD_CLOUD_SINCE:new Date(since).toISOString(),DISCORD_POLL_CHANNEL_IDS:BAD+','+GOOD,DISCORD_GUILD_ID:G,DISCORD_BOT_ID:BOT,DISCORD_BOT_TOKEN:'fixture-discord-token',DISCORD_ALLOWED_CHANNEL_IDS:GOOD,LINE_CHANNEL_SECRET:'fixture-secret',LINE_CHANNEL_ACCESS_TOKEN:'fixture-token',LINE_BOT_ID:LINE_BOT,LINE_ALLOWED_USER_IDS:LINE_OWNER,LINE_ENABLE_EVENTS:'true',LINE_ENABLE_REPLIES:'true',LINE_CHANNEL_ID:'fixture-channel',LINE_TOKEN_EXPIRES_AT:new Date(Date.now()+3600000).toISOString()};
 env.CALLBACK_FETCH=async(_url,options)=>{const event=JSON.parse(options.body);if(event.type==='verification')return Response.json({challenge:event.challenge});callbacks.push(event);return Response.json({});};
 env.LINE_TOKEN_FETCH=async url=>{const path=new URL(url).pathname;renewals.push(path);return Response.json(path==='/v2/oauth/accessToken'?{access_token:'fixture-renewed-token-with-length',expires_in:2592000}:path==='/v2/oauth/verify'?{client_id:env.LINE_CHANNEL_ID,expires_in:2592000}:{userId:LINE_BOT});};
 env.FETCH=async url=>{
  const path=new URL(url).pathname.replace(/^\/api\/v10/,'');
  if(path==='/channels/'+GOOD)return Response.json({id:GOOD,guild_id:G,type:0});
  if(path==='/channels/'+BAD)return Response.json({id:BAD,guild_id:G,type:0});
  if(path==='/channels/'+GOOD+'/messages')return Response.json([message]);
  if(path==='/channels/'+BAD+'/messages')return Response.json([]);
  if(path==='/channels/'+GOOD+'/messages/'+messageId)return Response.json(message);
  throw Error('Unexpected fixture request');
 };
 raw.prepare('INSERT INTO bridge_runtime VALUES (?,?,?)').run('cloud_cursor:'+BAD,previous,Date.now());
 return {env,raw,messageId,previous,callbacks,renewals};
}
async function rpc(env,method,params){
 const modern=method.startsWith('events/'),version='2026-07-28';
 const response=await worker.fetch(new Request('https://site.example/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':'owner',...(modern?{'MCP-Protocol-Version':version,'Mcp-Method':method}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,...(modern?{_meta:{'io.modelcontextprotocol/protocolVersion':version,'io.modelcontextprotocol/clientCapabilities':{}}}:{})}})}),env);
 return response.json();
}
async function queueLine(env){
 const subscribed=await rpc(env,'events/subscribe',{name:'line.message.created',arguments:{},delivery:{mode:'webhook',url:'https://chatgpt.com/line-isolation',secret:'whsec_'+Buffer.alloc(32,8).toString('base64')}});
 assert.ok(subscribed.result.id);
 const body=JSON.stringify({destination:LINE_BOT,events:[{webhookEventId:LINE_EVENT,type:'message',timestamp:Date.now(),source:{type:'user',userId:LINE_OWNER},message:{id:'fixture-message',type:'text',text:'private LINE content'},replyToken:'fixture-reply-token'}]});
 const response=await worker.fetch(new Request('https://site.example/webhooks/line',{method:'POST',headers:{'content-type':'application/json','x-line-signature':createHmac('sha256',env.LINE_CHANNEL_SECRET).update(body).digest('base64')},body}),env);
 assert.equal(response.status,200);
}
async function subscribeDiscord(env){
 const result=await rpc(env,'events/subscribe',{name:'discord.message.created',arguments:{guild_id:G,channel_ids:[GOOD]},delivery:{mode:'webhook',url:'https://chatgpt.com/discord-isolation',secret:'whsec_'+Buffer.alloc(32,9).toString('base64')}});
 assert.ok(result.result?.id,JSON.stringify(result));
}
const maintain=async env=>{const result=await rpc(env,'tools/call',{name:'bridge_maintain',arguments:{}});assert.equal(result.result.isError,false);return JSON.parse(result.result.content[0].text);};

for(const {status,stage,code} of [{status:403,stage:'channel',code:'DISCORD_403'},{status:429,stage:'messages',code:'DISCORD_RATE_LIMITED'}])test(`Discord ${status} at ${stage} preserves its cursor while another channel, LINE renewal and both notifications progress`,async()=>{
 const s=setup();await queueLine(s.env);await subscribeDiscord(s.env);
 const original=s.env.FETCH;
 s.env.FETCH=async url=>new URL(url).pathname.replace(/^\/api\/v10/,'')==='/channels/'+BAD+(stage==='messages'?'/messages':'')?Response.json({message:PRIVATE},{status}):original(url);
 const result=await maintain(s.env);
 assert.equal(result.observed,1);assert.equal(result.delivered,2);assert.equal(result.line_token.renewed,true);
 assert.deepEqual(result.failures,['DISCORD_CHANNEL_1:'+code]);assert.equal(result.degraded,true);assert.equal((await cloudRuntimeStatus(s.env)).healthy,false);
 assert.deepEqual(new Set(s.callbacks.map(e=>e.name)),new Set(['line.message.created','discord.message.created']));
 assert.equal(s.raw.prepare('SELECT value FROM bridge_runtime WHERE key=?').get('cloud_cursor:'+BAD).value,s.previous);
 assert.equal(s.raw.prepare('SELECT value FROM bridge_runtime WHERE key=?').get('cloud_cursor:'+GOOD).value,s.messageId);
 assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM event_outbox WHERE status='delivered'").get().n,2);
 assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM bridge_runtime WHERE key='cloud_lease'").get().n,0);
 for(const value of [PRIVATE,BAD,GOOD,'fixture-discord-token','fixture-reply-token'])assert.ok(!JSON.stringify(result).includes(value));
});

test('LINE token verification failure does not block Discord collection or persisted LINE callback delivery',async()=>{
 const s=setup();await queueLine(s.env);await subscribeDiscord(s.env);
 const original=s.env.LINE_TOKEN_FETCH;s.env.LINE_TOKEN_FETCH=async url=>new URL(url).pathname==='/v2/oauth/verify'?Response.json({message:PRIVATE},{status:429}):original(url);
 const result=await maintain(s.env);
 assert.equal(result.observed,1);assert.equal(result.delivered,2);assert.equal(result.line_token.renewed,false);assert.equal(result.line_token.requires_review,true);
 assert.deepEqual(result.failures,['LINE_TOKEN_HTTP_429']);assert.equal(result.degraded,true);assert.equal((await cloudRuntimeStatus(s.env)).healthy,false);
 assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM event_outbox WHERE status='delivered'").get().n,2);
 assert.ok(s.raw.prepare("SELECT value FROM bridge_runtime WHERE key='line_token_renewal'").get());
 assert.ok(!JSON.stringify(result).includes(PRIVATE));
});

test('failure on a later Discord history page does not skip a partially collected backlog',async()=>{
 const s=setup();await queueLine(s.env);await subscribeDiscord(s.env);
 const original=s.env.FETCH;
 s.env.FETCH=async url=>{
  const parsed=new URL(url);
  if(parsed.pathname.endsWith('/channels/'+BAD+'/messages'))return parsed.searchParams.has('before')?Response.json({message:PRIVATE},{status:429}):Response.json(Array.from({length:100},(_,index)=>({id:String(BigInt(s.messageId)+BigInt(index+1)),channel_id:BAD,author:{id:OWNER}})));
  return original(url);
 };
 const result=await maintain(s.env);
 assert.equal(result.observed,1);assert.equal(result.delivered,2);assert.deepEqual(result.failures,['DISCORD_CHANNEL_1:DISCORD_RATE_LIMITED']);
 assert.equal(s.raw.prepare('SELECT value FROM bridge_runtime WHERE key=?').get('cloud_cursor:'+BAD).value,s.previous);
 assert.equal(s.raw.prepare('SELECT value FROM bridge_runtime WHERE key=?').get('cloud_cursor:'+GOOD).value,s.messageId);
});

test('an ambiguous LINE token issuance is reported as degraded while callbacks are drained',async()=>{
 const s=setup();await queueLine(s.env);s.env.DISCORD_ENABLE_EVENTS='false';s.env.LINE_TOKEN_FETCH=async()=>{throw Error(PRIVATE);};
 const result=await maintain(s.env);
 assert.equal(result.delivered,1);assert.deepEqual(result.failures,['LINE_TOKEN_REVIEW_REQUIRED']);assert.equal(result.degraded,true);assert.equal(result.line_token.requires_review,true);
 assert.equal(s.raw.prepare("SELECT value FROM bridge_runtime WHERE key='line_token_renewal'").get().value,'unknown');assert.ok(!JSON.stringify(result).includes(PRIVATE));
});

test('unknown Discord transport details are replaced with a fixed channel failure label',async()=>{
 const s=setup();s.env.LINE_CHANNEL_ID='';
 const result=await maintainCloud(s.env,{configured:()=>true,discord:async()=>{throw Error(PRIVATE);},events:{drain:async()=>({delivered:1})}});
 assert.deepEqual(result.failures,['DISCORD_CHANNEL_1:DISCORD_UNAVAILABLE','DISCORD_CHANNEL_2:DISCORD_UNAVAILABLE']);assert.equal(result.delivered,1);assert.ok(!JSON.stringify(result).includes(PRIVATE));
});

test('a cursor persistence failure is fatal and still releases the maintenance lease',async()=>{
 const s=setup();s.env.LINE_CHANNEL_ID='';s.env.DISCORD_POLL_CHANNEL_IDS=GOOD;
 const prepare=s.env.DB.prepare;s.env.DB.prepare=sql=>{
  if(sql.startsWith('INSERT INTO bridge_runtime (key,value,updated_at) VALUES (?,?,?)'))return {bind:()=>({run:async()=>{throw Error('FIXTURE_PERSISTENCE_UNAVAILABLE');}})};
  return prepare(sql);
 };
 let drained=false;
 await assert.rejects(maintainCloud(s.env,{configured:()=>true,discord:async(_env,path)=>path==='/channels/'+GOOD?{id:GOOD,guild_id:G,type:0}:[{id:s.messageId,channel_id:GOOD,author:{id:OWNER}}],events:{enqueue:async()=>{},drain:async()=>{drained=true;return {delivered:0};}}}),/FIXTURE_PERSISTENCE_UNAVAILABLE/);
 assert.equal(drained,false);assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM bridge_runtime WHERE key='cloud_lease'").get().n,0);assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM bridge_runtime WHERE key='cloud_maintenance'").get().n,0);
});

test('invalid saved cursor and global start configuration remain fatal instead of becoming a healthy tick',async()=>{
 for(const problem of ['cursor','start']){
  const s=setup();s.env.DISCORD_POLL_CHANNEL_IDS=BAD;
  if(problem==='cursor')s.raw.prepare('UPDATE bridge_runtime SET value=? WHERE key=?').run('invalid','cloud_cursor:'+BAD);else s.env.DISCORD_CLOUD_SINCE='invalid';
  await assert.rejects(maintainCloud(s.env,{configured:()=>true,discord:async()=>({id:BAD,guild_id:G,type:0}),events:{drain:async()=>({delivered:0})}}),problem==='cursor'?/INVALID_CURSOR/:/DISCORD_START_TIME_REQUIRED/);
  assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM bridge_runtime WHERE key='cloud_lease'").get().n,0);assert.equal((await cloudRuntimeStatus(s.env)).healthy,false);
 }
});
