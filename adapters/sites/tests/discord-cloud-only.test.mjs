import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import worker,{events} from '../worker/index.js';

const V='2026-07-28',G='111111111111111111',C='222222222222222222',B='444444444444444444',U='555555555555555555';
const LINE_U='U'+'1'.repeat(32),LINE_B='U'+'2'.repeat(32),LINE_E='01TESTCLOUDCHANNEL00000001';
const SECRET='whsec_'+Buffer.alloc(32,9).toString('base64');
const sign=(key,value)=>createHmac('sha256',key).update(value).digest('base64');

function setup({line=false,discord=false}={}){
 const db=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
 const DB={raw:db,prepare(sql){return{bind(...values){return{
  async run(){return{meta:{changes:Number(db.prepare(sql).run(...values).changes)}};},
  async first(){return db.prepare(sql).get(...values)||null;},
  async all(){return{results:db.prepare(sql).all(...values)};}
 };}};}};
 const at=Date.now(),message={id:String(BigInt(at-1420070400000)<<22n),channel_id:C,author:{id:U},mentions:[{id:B}],content:'discord-only fixture',timestamp:new Date(at).toISOString()};
 const deliveries=[],env={BRIDGE_RUNTIME:'cloud',BRIDGE_OWNER_SITE_ID:'owner',DB,COMPANION_SHARED_KEY:Buffer.alloc(32,7).toString('base64')};
 if(line)Object.assign(env,{LINE_CHANNEL_SECRET:'line-fixture-secret',LINE_CHANNEL_ACCESS_TOKEN:'line-fixture-token',LINE_BOT_ID:LINE_B,LINE_ALLOWED_USER_IDS:LINE_U,LINE_ENABLE_EVENTS:'true'});
 if(discord)Object.assign(env,{DISCORD_GUILD_ID:G,DISCORD_BOT_ID:B,DISCORD_BOT_TOKEN:'discord-fixture-token',DISCORD_ALLOWED_CHANNEL_IDS:C,DISCORD_POLL_CHANNEL_IDS:C,DISCORD_CLOUD_SINCE:new Date(at-1000).toISOString(),DISCORD_ENABLE_EVENTS:'true'});
 env.FETCH=async url=>{
  const path=new URL(url).pathname;
  if(path===`/api/v10/channels/${C}`)return Response.json({id:C,guild_id:G,type:0});
  if(path===`/api/v10/channels/${C}/messages`)return Response.json([message]);
  if(path===`/api/v10/channels/${C}/messages/${message.id}`)return Response.json(message);
  throw Error('Unexpected Discord fixture endpoint');
 };
 env.CALLBACK_FETCH=async(url,options)=>{
  assert.equal(new URL(url).hostname,'chatgpt.com');assert.equal(options.redirect,'manual');
  const headers=options.headers;
  assert.equal(headers['webhook-signature'],'v1,'+sign(Buffer.from(SECRET.slice(6),'base64'),`${headers['webhook-id']}.${headers['webhook-timestamp']}.${options.body}`));
  const body=JSON.parse(options.body);
  if(body.type==='verification')return Response.json({challenge:body.challenge});
  deliveries.push(body);return Response.json({});
 };
 return{env,message,deliveries};
}
async function rpc(env,method,params,owner='owner'){
 const response=await worker.fetch(new Request('https://site.example/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':owner,'MCP-Protocol-Version':V,'Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':params.name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':V,'io.modelcontextprotocol/clientCapabilities':{}}}})}),env);
 return{response,body:await response.json()};
}
const subscribe=(env,name)=>rpc(env,'events/subscribe',{name,arguments:name==='line.message.created'?{}:{guild_id:G,channel_ids:[C],mentions_only:true},delivery:{mode:'webhook',url:'https://chatgpt.com/fixture-events',secret:SECRET}});
async function maintain(env){const result=await rpc(env,'tools/call',{name:'bridge_maintain',arguments:{}});assert.equal(result.body.result.isError,false);return JSON.parse(result.body.result.content[0].text);}
async function lineIntake(env){
 const body=JSON.stringify({destination:LINE_B,events:[{webhookEventId:LINE_E,type:'message',timestamp:Date.now(),source:{type:'user',userId:LINE_U},message:{id:'123',type:'text',text:'LINE-only fixture'},replyToken:'fixture-reply'}]});
 const response=await worker.fetch(new Request('https://site.example/webhooks/line',{method:'POST',headers:{'content-type':'application/json','x-line-signature':sign(env.LINE_CHANNEL_SECRET,body)},body}),env);
 assert.equal(response.status,200);
}
async function queuedBoth(){
 const s=setup({line:true,discord:true});
 for(const name of ['line.message.created','discord.message.created'])assert.ok((await subscribe(s.env,name)).body.result.id);
 await lineIntake(s.env);await events.enqueue(s.env,{guild_id:G,channel_id:C,message_id:s.message.id});return s;
}

test('Discord-only cloud uses actual MCP recovery, REST intake and signed callback without any LINE configuration',async()=>{
 const s=setup({discord:true});assert.equal(s.env.LINE_ENABLE_EVENTS,undefined);
 assert.ok((await subscribe(s.env,'discord.message.created')).body.result.id);
 const first=await maintain(s.env);assert.equal(first.observed,1);assert.equal(first.delivered,1);assert.equal(first.source,'mcp');
 assert.equal(s.deliveries.length,1);assert.equal(s.deliveries[0].eventId,'discord_message_'+s.message.id);assert.equal(s.deliveries[0].name,'discord.message.created');
 assert.equal(s.env.DB.raw.prepare('SELECT status FROM event_outbox').get().status,'delivered');
 assert.equal((await maintain(s.env)).observed,0);assert.equal(s.deliveries.length,1);
});
test('Discord-only owner DM is verified, subscribed and delivered through MCP recovery without LINE',async()=>{
 const s=setup({discord:true}),dm='666666666666666666',message={...s.message,channel_id:dm,mentions:[]};
 s.env.DISCORD_POLL_CHANNEL_IDS=dm;s.env.DISCORD_OWNER_USER_ID=U;
 s.env.FETCH=async url=>{
  const path=new URL(url).pathname;
  if(path===`/api/v10/channels/${dm}`)return Response.json({id:dm,type:1,recipients:[{id:U}]});
  if(path===`/api/v10/channels/${dm}/messages`)return Response.json([message]);
  if(path===`/api/v10/channels/${dm}/messages/${message.id}`)return Response.json(message);
  throw Error('Unexpected DM fixture endpoint');
 };
 assert.equal((await maintain(s.env)).observed,1);assert.equal(s.deliveries.length,0);
 const subscription=await rpc(s.env,'events/subscribe',{name:'discord.dm.message.created',arguments:{guild_id:G,channel_ids:[dm]},delivery:{mode:'webhook',url:'https://chatgpt.com/fixture-events',secret:SECRET}});
 assert.ok(subscription.body.result.id);
 assert.equal((await maintain(s.env)).delivered,1);
 assert.equal(s.deliveries[0].name,'discord.dm.message.created');assert.equal(s.deliveries[0].data.channel_id,dm);
 assert.ok(!JSON.stringify(s.deliveries).includes(message.content));
});
test('LINE-only cloud maintenance delivers a signed notification without Discord configuration',async()=>{
 const s=setup({line:true});assert.ok((await subscribe(s.env,'line.message.created')).body.result.id);await lineIntake(s.env);
 const result=await maintain(s.env);assert.equal(result.discord_configured,false);assert.equal(result.delivered,1);assert.equal(s.deliveries[0].name,'line.message.created');
});
test('cloud maintenance drains both enabled channels',async()=>{
 const s=await queuedBoth();assert.equal((await maintain(s.env)).delivered,2);
 assert.deepEqual(s.deliveries.map(x=>x.name).sort(),['discord.message.created','line.message.created']);
});
for(const disabled of ['LINE','DISCORD'])test(`another enabled channel never permits queued ${disabled} callbacks after disablement`,async()=>{
 const s=await queuedBoth();s.env[disabled+'_ENABLE_EVENTS']='false';
 const result=await maintain(s.env);assert.equal(result.delivered,1);
 assert.deepEqual(s.deliveries.map(x=>x.name),[disabled==='LINE'?'discord.message.created':'line.message.created']);
 const id=disabled==='LINE'?'line_'+LINE_E:'discord_message_'+s.message.id;
 assert.equal(s.env.DB.raw.prepare('SELECT status FROM event_outbox WHERE event_id=?').get(id).status,'cancelled');
 assert.equal((await subscribe(s.env,disabled==='LINE'?'line.message.created':'discord.message.created')).body.error.message,'EVENTS_DISABLED');
});
test('a misconfigured optional LINE channel does not block a healthy Discord channel',async()=>{
 const s=setup({discord:true});s.env.LINE_ENABLE_EVENTS='true';
 assert.ok((await subscribe(s.env,'discord.message.created')).body.result.id);
 assert.equal((await maintain(s.env)).delivered,1);assert.equal(s.deliveries[0].name,'discord.message.created');
});
test('neither disabled channels nor unauthenticated callers can deliver queued notifications',async()=>{
 const s=await queuedBoth();
 const denied=await rpc(s.env,'tools/call',{name:'bridge_maintain',arguments:{}},'');assert.equal(denied.response.status,401);
 s.env.LINE_ENABLE_EVENTS='false';s.env.DISCORD_ENABLE_EVENTS='false';
 await assert.rejects(events.drain(s.env),/EVENTS_DISABLED/);assert.equal(s.deliveries.length,0);
});
