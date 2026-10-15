import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import worker,{events,source,dmSource} from '../worker/index.js';
import {lineSource} from '../worker/line.js';
import {recordDeliveryTiming,lineDiagnosticSource,deliveryDiagnostics,pruneDeliveryDiagnostics} from '../worker/delivery-diagnostics.js';

const G='111111111111111111',C='222222222222222222',M='333333333333333333',B='444444444444444444',U='555555555555555555',DM='666666666666666666',THREAD='777777777777777777';
const LINE_U='U'+'1'.repeat(32),LINE_B='U'+'2'.repeat(32),E='01DIAGNOSTICLINEEVENT00001';
const PREFIX='delivery_diag:v1:',BODY='private fixture message body',TOKEN='private-fixture-access-token',REPLY_TOKEN='private-fixture-reply-token';
function setup(){
 const raw=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(file=>file.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
 const s={raw,posts:[],onLineRead:null,onDiscordFetch:null,threadParent:C};
 const DB={raw,prepare(sql){return{bind(...values){return{
  async run(){return{meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};},
  async first(){if(sql==='SELECT * FROM cloud_line_messages WHERE event_id = ?')s.onLineRead?.();return raw.prepare(sql).get(...values)||null;},
  async all(){return{results:raw.prepare(sql).all(...values)};}
 };}};}};
 const message={id:M,channel_id:C,author:{id:U},content:BODY,mentions:[{id:B}],timestamp:new Date(Date.now()).toISOString()};
 const env={BRIDGE_RUNTIME:'cloud',BRIDGE_OWNER_SITE_ID:'owner',DB,COMPANION_SHARED_KEY:Buffer.alloc(32,7).toString('base64'),LINE_CHANNEL_SECRET:'fixture-signing-secret',LINE_CHANNEL_ACCESS_TOKEN:TOKEN,LINE_BOT_ID:LINE_B,LINE_ALLOWED_USER_IDS:LINE_U,LINE_ENABLE_EVENTS:'true',LINE_ENABLE_REPLIES:'true',DISCORD_GUILD_ID:G,DISCORD_BOT_ID:B,DISCORD_BOT_TOKEN:TOKEN,DISCORD_ALLOWED_CHANNEL_IDS:C,DISCORD_ENABLE_EVENTS:'true',DISCORD_ENABLE_REPLIES:'true'};
 env.LINE_FETCH=async(url,options)=>{s.posts.push({url,options});return Response.json({});};
 env.FETCH=async(url,options)=>{
  s.onDiscordFetch?.();const path=new URL(url).pathname;
  if(path===`/api/v10/channels/${C}`)return Response.json({id:C,guild_id:G,type:0});
  if(path===`/api/v10/channels/${THREAD}`)return Response.json({id:THREAD,guild_id:G,type:11,parent_id:s.threadParent});
  if(path===`/api/v10/channels/${DM}`)return Response.json({id:DM,type:1,recipients:[{id:U}]});
  if(path===`/api/v10/channels/${C}/messages/${M}`)return Response.json(message);
  if(path===`/api/v10/channels/${THREAD}/messages/${M}`)return Response.json({...message,channel_id:THREAD});
  if(path===`/api/v10/channels/${DM}/messages/${M}`)return Response.json({...message,channel_id:DM,mentions:[]});
  if(options.method==='POST'&&path.endsWith('/messages')){s.posts.push({url,options});return Response.json({id:'888888888888888888',channel_id:path.split('/')[4]});}
  throw Error('Unexpected fixture endpoint');
 };
 env.CALLBACK_FETCH=async(_url,options)=>{const body=JSON.parse(options.body);return Response.json(body.type==='verification'?{challenge:body.challenge}:{});};
 return Object.assign(s,{env,message});
}
async function rpc(env,name,args={},owner='owner'){
 const response=await worker.fetch(new Request('https://site.example/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':owner},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),env);
 const body=await response.json();return{response,body,value:body.result?.content?.[0]?.text?JSON.parse(body.result.content[0].text):body};
}
async function intake(env,eventId=E){
 const body=JSON.stringify({destination:LINE_B,events:[{webhookEventId:eventId,type:'message',timestamp:Date.now(),source:{type:'user',userId:LINE_U},message:{id:'123',type:'text',text:BODY},replyToken:REPLY_TOKEN}]});
 const signature=createHmac('sha256',env.LINE_CHANNEL_SECRET).update(body).digest('base64');
 const response=await worker.fetch(new Request('https://site.example/webhooks/line',{method:'POST',headers:{'content-type':'application/json','x-line-signature':signature},body}),env);assert.equal(response.status,200);
}
function admitDm(s){s.raw.prepare("INSERT INTO dm_contacts (channel_id,user_id,guild_id,owner_site_id,source_channel_id,source_message_id,authorized_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(DM,U,G,'owner',C,M,Date.now()-1000,Date.now()-1000);}
const observations=s=>s.raw.prepare('SELECT key,value,updated_at FROM bridge_runtime WHERE key GLOB ?').all(PREFIX+'*');
async function diagnostics(s){return(await rpc(s.env,'bridge_status')).value.delivery_diagnostics;}
async function subscribe(s,name='line.message.created',args={}){
 return events.subscribed('events/subscribe',{name,arguments:args,delivery:{mode:'webhook',url:'https://chatgpt.com/fixture-events',secret:'whsec_'+Buffer.alloc(32,9).toString('base64')}},new Request('https://site.example/mcp',{headers:{'oai-authenticated-user-id':'owner'}}),s.env);
}

test('owner status includes pending and callback-delivered LINE events that never reached a read tool',async()=>{
 const s=setup();await subscribe(s);await intake(s.env);
 let record=(await diagnostics(s)).messages[0];assert.equal(record.event_id,'line_'+E);assert.deepEqual(record.notification_statuses,['pending']);assert.equal(record.first_read_tool_at,null);assert.equal(record.callback_delivery_updated_at,null);
 await events.drain(s.env);assert.equal(observations(s).length,0);
 record=(await diagnostics(s)).messages[0];assert.deepEqual(record.notification_statuses,['delivered']);assert.ok(record.callback_delivery_updated_at);
 for(const field of ['first_read_tool_at','last_read_tool_at','reply_reserved_at','first_send_attempt_at','confirmed_completed_at'])assert.equal(record[field],null);
});

test('unread notification candidates enforce owner, source ID, seven-day window and current LINE approval',async()=>{
 const s=setup();await subscribe(s);await intake(s.env);assert.equal((await diagnostics(s)).messages.length,1);
 s.raw.prepare("UPDATE event_subscriptions SET principal='other'").run();assert.deepEqual((await diagnostics(s)).messages,[]);
 s.raw.prepare("UPDATE event_subscriptions SET principal='owner'").run();s.env.LINE_ALLOWED_USER_IDS='';assert.deepEqual((await diagnostics(s)).messages,[]);s.env.LINE_ALLOWED_USER_IDS=LINE_U;
 s.raw.prepare('UPDATE event_records SET data_json=?').run(JSON.stringify({event_id:'01DIFFERENTVALIDLINEEVENT'}));assert.deepEqual((await diagnostics(s)).messages,[]);
 s.raw.prepare('UPDATE event_records SET data_json=?,created_at=?').run(JSON.stringify({event_id:E}),Date.now()-8*86400000);assert.deepEqual((await diagnostics(s)).messages,[]);
});

for(const scope of ['guild','dm'])test(`unread Discord ${scope} notification appears without a trace and honors current channel/contact policy`,async()=>{
 const s=setup();if(scope==='dm')admitDm(s);const channelId=scope==='dm'?DM:C;
 await subscribe(s,scope==='dm'?'discord.dm.message.created':'discord.message.created',{guild_id:G,channel_ids:[channelId]});
 s.message.timestamp=new Date(Date.now()).toISOString();await events.enqueue(s.env,{guild_id:G,channel_id:channelId,message_id:M,...(scope==='dm'?{scope:'dm'}:{})});
 const record=(await diagnostics(s)).messages[0];assert.equal(record.channel,scope==='dm'?'discord_dm':'discord_guild');assert.equal(record.first_read_tool_at,null);assert.deepEqual(record.notification_statuses,['pending']);
 assert.equal(observations(s).length,0);
 if(scope==='dm')s.raw.prepare('DELETE FROM dm_contacts').run();else s.env.DISCORD_ALLOWED_CHANNEL_IDS=DM;
 assert.deepEqual((await diagnostics(s)).messages,[]);
});

test('unread thread notifications honor a live parent allowlist and stale trace parents never override revocation',async()=>{
 const s=setup();await subscribe(s,'discord.message.created',{guild_id:G,channel_ids:[THREAD]});
 s.message.timestamp=new Date(Date.now()).toISOString();await events.enqueue(s.env,{guild_id:G,channel_id:THREAD,message_id:M});
 assert.equal(observations(s).length,0);
 let record=(await diagnostics(s)).messages[0];assert.equal(record.event_id,'discord_message_'+M);assert.equal(record.first_read_tool_at,null);
 assert.equal((await rpc(s.env,'discord_message_read',{channel_id:THREAD,message_id:M})).value.content,BODY);
 assert.equal((await diagnostics(s)).messages.length,1);s.threadParent=DM;
 assert.deepEqual((await diagnostics(s)).messages,[]);
});

test('LINE timings distinguish delivered outbox update, captured successful tool entry, reservation and confirmed completion',async t=>{
 const base=Date.now();let now=base;t.mock.method(Date,'now',()=>now);
 const s=setup();
 await subscribe(s);
 await intake(s.env);now=base+3000;await events.drain(s.env);assert.equal(observations(s).length,0);
 now=base+60000;s.onLineRead=()=>{now+=3000;};
 assert.equal((await rpc(s.env,'line_message_read',{event_id:E})).value.content,BODY);s.onLineRead=null;
 now=base+65000;s.env.LINE_FETCH=async(url,options)=>{s.posts.push({url,options});now+=2000;return Response.json({});};
 assert.equal((await rpc(s.env,'line_reply',{event_id:E,content:'reply fixture'})).value.status,'completed');
 const result=await diagnostics(s),record=result.messages[0];
 assert.equal(result.read_observation,'successful_read_tool_entry_not_model_start');assert.equal(result.callback_observation,'earliest_delivered_outbox_updated_at');assert.equal(result.trigger_origin,'not_observed');
 assert.equal(Date.parse(record.source_recorded_at),base);assert.equal(Date.parse(record.callback_delivery_updated_at),base+3000);
 assert.equal(Date.parse(record.first_read_tool_at),base+60000);assert.equal(Date.parse(record.reply_reserved_at),base+65000);
 assert.equal(Date.parse(record.first_send_attempt_at),base+65000);assert.equal(Date.parse(record.confirmed_completed_at),base+67000);
 assert.deepEqual(record.interval_ms,{occurred_to_recorded:0,recorded_to_callback:3000,callback_to_first_read_tool:57000,first_read_tool_to_reply_reserved:5000,reply_reserved_to_confirmed_completed:2000,first_send_attempt_to_confirmed_completed:2000});
 const stored=JSON.stringify(observations(s)),status=JSON.stringify(result);
 for(const secret of [BODY,TOKEN,REPLY_TOKEN,s.env.LINE_CHANNEL_SECRET,'fixture-events']){assert.ok(!stored.includes(secret));assert.ok(!status.includes(secret));}
});

test('internal source checks and inbox listing do not masquerade as explicit LINE or Discord read tools',async()=>{
 const s=setup();await intake(s.env);admitDm(s);
 await lineSource(s.env,{event_id:E});await events.enqueueLine(s.env,E);await rpc(s.env,'line_inbox_read');
 await source(s.env,{channel_id:C,message_id:M});await dmSource(s.env,{channel_id:DM,message_id:M});
 assert.equal(observations(s).length,0);
});

for(const scope of ['guild','dm'])test(`Discord ${scope} read captures entry before REST checks and reply records only the CAS winner`,async t=>{
 const base=Date.now();let now=base;t.mock.method(Date,'now',()=>now);
 const s=setup();if(scope==='dm')admitDm(s);
 s.onDiscordFetch=()=>{now+=1000;};const channelId=scope==='dm'?DM:C;
 const readTool=scope==='dm'?'discord_dm_message_read':'discord_message_read',replyTool=scope==='dm'?'discord_reply_dm':'discord_reply_to_mention';
 assert.equal((await rpc(s.env,readTool,{channel_id:channelId,message_id:M})).value.content,BODY);
 const before=await diagnostics(s);assert.equal(Date.parse(before.messages[0].first_read_tool_at),base);assert.equal(before.messages[0].confirmed_completed_at,null);
 const replies=await Promise.all([rpc(s.env,replyTool,{channel_id:channelId,message_id:M,content:'reply fixture'}),rpc(s.env,replyTool,{channel_id:channelId,message_id:M,content:'reply fixture'})]);
 assert.ok(replies.every(result=>!result.body.result.isError));assert.equal(s.posts.length,1);
 const record=(await diagnostics(s)).messages[0];assert.equal(record.reply_status,'completed');assert.ok(record.first_send_attempt_at);assert.ok(record.confirmed_completed_at);assert.equal(record.callback_delivery_updated_at,null);
 assert.equal(record.channel,scope==='dm'?'discord_dm':'discord_guild');assert.equal(s.posts[0].url,`https://discord.com/api/v10/channels/${channelId}/messages`);
});

test('concurrent out-of-order reads preserve earliest entry and latest entry without body metadata',async()=>{
 const s=setup();await intake(s.env);const now=Date.now(),input={...lineDiagnosticSource(E),content:BODY,authorization:TOKEN};
 await Promise.all([recordDeliveryTiming(s.env,input,'read_tool',now+30),recordDeliveryTiming(s.env,input,'read_tool',now+10),recordDeliveryTiming(s.env,input,'read_tool',now+20)]);
 const record=(await diagnostics(s)).messages[0];assert.equal(Date.parse(record.first_read_tool_at),now+10);assert.equal(Date.parse(record.last_read_tool_at),now+30);
 assert.ok(!JSON.stringify(observations(s)).includes(BODY));assert.ok(!JSON.stringify(observations(s)).includes(TOKEN));
});

test('anonymous, other-owner, pre-owner setup and changed-owner status never expose retained timings',async()=>{
 const s=setup();await intake(s.env);await rpc(s.env,'line_message_read',{event_id:E});
 for(const owner of ['', 'other'])assert.ok([401,403].includes((await rpc(s.env,'bridge_status',{},owner)).response.status));
 s.env.BRIDGE_OWNER_SITE_ID='';assert.equal((await rpc(s.env,'bridge_status',{},'other')).value.delivery_diagnostics,undefined);
 s.env.BRIDGE_OWNER_SITE_ID='other';assert.deepEqual((await rpc(s.env,'bridge_status',{},'other')).value.delivery_diagnostics.messages,[]);
 assert.equal(await deliveryDiagnostics(s.env,'owner'),null);
});

test('failed or unauthorized read never creates a read timing and revoked LINE approval hides previous metadata',async()=>{
 const s=setup();await intake(s.env);
 for(const owner of ['', 'other'])await rpc(s.env,'line_message_read',{event_id:E},owner);
 await rpc(s.env,'line_message_read',{event_id:'01UNKNOWNLINEEVENT0000001'});assert.equal(observations(s).length,0);
 await rpc(s.env,'line_message_read',{event_id:E});s.env.LINE_ALLOWED_USER_IDS='U'+'9'.repeat(32);
 assert.deepEqual((await diagnostics(s)).messages,[]);
});

test('diagnostic persistence failures never change successful read, reply completion, or duplicate-send protection',async()=>{
 const s=setup();await intake(s.env);const original=s.env.DB;
 s.env.DB={raw:s.raw,prepare(sql){const statement=original.prepare(sql);return{bind(...values){if(values.some(value=>typeof value==='string'&&value.startsWith(PREFIX)))throw Error('private telemetry fault '+TOKEN);return statement.bind(...values);}};}};
 assert.equal((await rpc(s.env,'line_message_read',{event_id:E})).value.content,BODY);
 assert.equal((await rpc(s.env,'line_reply',{event_id:E,content:'reply fixture'})).value.status,'completed');
 assert.equal((await rpc(s.env,'line_reply',{event_id:E,content:'reply fixture'})).value.duplicate,true);assert.equal(s.posts.length,1);
 assert.equal(s.raw.prepare('SELECT status FROM actions').get().status,'completed');
 const status=await diagnostics(s);assert.equal(status.available,false);assert.equal(status.reason,'DIAGNOSTICS_UNAVAILABLE');assert.ok(!JSON.stringify(status).includes(TOKEN));
});

for(const channel of ['line','discord'])test(`${channel} ambiguous send stays unknown and duplicate calls cannot add confirmed completion`,async()=>{
 const s=setup();await intake(s.env);let writes=0;
 let name,args;
 if(channel==='line'){s.env.LINE_FETCH=async()=>{writes++;throw Error('private transport '+TOKEN);};name='line_reply';args={event_id:E,content:'reply fixture'};}
 else{const original=s.env.FETCH;s.env.FETCH=async(url,options)=>{if(options.method==='POST'){writes++;throw Error('private transport '+TOKEN);}return original(url,options);};name='discord_reply_to_mention';args={channel_id:C,message_id:M,content:'reply fixture'};}
 assert.equal((await rpc(s.env,name,args)).body.result.isError,true);assert.equal((await rpc(s.env,name,args)).value.status,'unknown');assert.equal(writes,1);
 const record=(await diagnostics(s)).messages[0];assert.equal(record.reply_status,'unknown');assert.ok(record.first_send_attempt_at);assert.equal(record.confirmed_completed_at,null);assert.equal(record.first_read_tool_at,null);
});

test('status is bounded, absent observations remain null, and TTL deletes only the diagnostic namespace',async()=>{
 const s=setup();
 for(let i=0;i<12;i++){const id='01DIAGNOSTICBOUNDEVENT'+String(i).padStart(3,'0');await intake(s.env,id);await recordDeliveryTiming(s.env,lineDiagnosticSource(id),'read_tool');}
 let result=await diagnostics(s);assert.equal(result.messages.length,10);assert.equal(result.limit,10);assert.equal(result.messages[0].callback_delivery_updated_at,null);assert.equal(result.messages[0].reply_reserved_at,null);
 s.raw.prepare('UPDATE bridge_runtime SET updated_at=? WHERE key GLOB ?').run(0,PREFIX+'*');
 for(const key of ['cloud_maintenance','line_reply_retry:fixture','cloud_cursor:fixture'])s.raw.prepare('INSERT INTO bridge_runtime (key,value,updated_at) VALUES (?,?,?)').run(key,'keep',0);
 await pruneDeliveryDiagnostics(s.env);assert.equal(observations(s).length,0);
 for(const key of ['cloud_maintenance','line_reply_retry:fixture','cloud_cursor:fixture'])assert.equal(s.raw.prepare('SELECT value FROM bridge_runtime WHERE key=?').get(key).value,'keep');
});

test('LINE occurrence comes from the platform event row and separates ingress delay from stored-to-read delay',async t=>{
 const base=Date.now();t.mock.method(Date,'now',()=>base);const s=setup();await subscribe(s);await intake(s.env);
 s.raw.prepare('UPDATE cloud_line_messages SET occurred_at=? WHERE event_id=?').run(base-62640,E);
 // The LINE event row is authoritative even if the notification copy differs.
 s.raw.prepare('UPDATE event_records SET occurred_at=?').run(new Date(base-1000).toISOString());
 const result=await diagnostics(s),record=result.messages[0];assert.equal(record.source_occurred_at,new Date(base-62640).toISOString());assert.equal(record.source_recorded_at,new Date(base).toISOString());assert.equal(record.interval_ms.occurred_to_recorded,62640);assert.equal(record.first_read_tool_at,null);assert.equal(record.timing_order_warning,false);
 assert.equal(result.source_occurrence_observation,'platform_event_timestamp_not_message_composition_or_model_start');assert.equal(result.trigger_origin,'not_observed');assert.equal(s.posts.length,0);assert.equal(observations(s).length,0);
 for(const secret of [BODY,TOKEN,REPLY_TOKEN,LINE_U,LINE_B])assert.equal(JSON.stringify(result).includes(secret),false);
});

for(const scope of ['guild','dm'])test(`Discord ${scope} occurrence parses its existing event ISO timestamp without a network read`,async t=>{
 const base=Date.now();t.mock.method(Date,'now',()=>base);const s=setup();if(scope==='dm')admitDm(s);const channelId=scope==='dm'?DM:C;
 await events.enqueue(s.env,{guild_id:G,channel_id:channelId,message_id:M,...(scope==='dm'?{scope:'dm'}:{})});
 await recordDeliveryTiming(s.env,{channel:scope==='dm'?'discord_dm':'discord_guild',source_id:M,channel_id:channelId,guild_id:G},'read_tool');
 s.raw.prepare('UPDATE event_records SET occurred_at=?').run(new Date(base-12345).toISOString());let requests=0;s.onDiscordFetch=()=>{requests++;};
 const result=await diagnostics(s),record=result.messages[0];assert.equal(record.source_occurred_at,new Date(base-12345).toISOString());assert.equal(record.source_recorded_at,new Date(base).toISOString());assert.equal(record.interval_ms.occurred_to_recorded,12345);assert.equal(record.timing_order_warning,false);assert.equal(requests,0);
 for(const secret of [BODY,TOKEN,REPLY_TOKEN,U,C,DM])assert.equal(JSON.stringify(result).includes(secret),false);
});

test('missing and invalid occurrence metadata stay null instead of becoming an epoch or a misleading duration',async()=>{
 const s=setup();await intake(s.env);await recordDeliveryTiming(s.env,lineDiagnosticSource(E),'read_tool');
 for(const value of ['not-a-time',-1,1.5,8640000000000001]){
  s.raw.prepare('UPDATE cloud_line_messages SET occurred_at=? WHERE event_id=?').run(value,E);
  const record=(await diagnostics(s)).messages[0];assert.equal(record.source_occurred_at,null);assert.equal(record.interval_ms.occurred_to_recorded,null);assert.equal(record.timing_order_warning,false);
 }
 const d=setup();await recordDeliveryTiming(d.env,{channel:'discord_guild',source_id:M,channel_id:C,guild_id:G},'read_tool');
 let record=(await diagnostics(d)).messages[0];assert.equal(record.source_occurred_at,null);assert.equal(record.source_recorded_at,null);assert.equal(record.interval_ms.occurred_to_recorded,null);
 await events.enqueue(d.env,{guild_id:G,channel_id:C,message_id:M});
 for(const value of ['','invalid-time','0','2026-99-99T99:99:99.000Z','2026-02-30T00:00:00.000Z']){
  d.raw.prepare('UPDATE event_records SET occurred_at=?').run(value);record=(await diagnostics(d)).messages[0];assert.equal(record.source_occurred_at,null);assert.equal(record.interval_ms.occurred_to_recorded,null);assert.equal(record.timing_order_warning,false);
 }
});

test('negative occurred-to-recorded delays raise the existing timing warning for both platforms',async t=>{
 const base=Date.now();t.mock.method(Date,'now',()=>base);
 for(const platform of ['line','discord']){
  const s=setup();
  if(platform==='line'){await intake(s.env);await recordDeliveryTiming(s.env,lineDiagnosticSource(E),'read_tool');s.raw.prepare('UPDATE cloud_line_messages SET occurred_at=?').run(base+1000);}
  else{await events.enqueue(s.env,{guild_id:G,channel_id:C,message_id:M});await recordDeliveryTiming(s.env,{channel:'discord_guild',source_id:M,channel_id:C,guild_id:G},'read_tool');s.raw.prepare('UPDATE event_records SET occurred_at=?').run(new Date(base+1000).toISOString());}
  const record=(await diagnostics(s)).messages[0];assert.equal(record.source_occurred_at,new Date(base+1000).toISOString());assert.equal(record.interval_ms.occurred_to_recorded,-1000);assert.equal(record.timing_order_warning,true);
 }
});

test('source occurrence fields keep owner and current source authorization boundaries',async()=>{
 const s=setup();await intake(s.env);await recordDeliveryTiming(s.env,lineDiagnosticSource(E),'read_tool');assert.ok((await diagnostics(s)).messages[0].source_occurred_at);
 for(const principal of [null,'','other'])assert.equal(await deliveryDiagnostics(s.env,principal),null);
 s.env.LINE_ALLOWED_USER_IDS='';assert.deepEqual((await diagnostics(s)).messages,[]);
 const d=setup();admitDm(d);await events.enqueue(d.env,{guild_id:G,channel_id:DM,message_id:M,scope:'dm'});await recordDeliveryTiming(d.env,{channel:'discord_dm',source_id:M,channel_id:DM,guild_id:G},'read_tool');assert.ok((await diagnostics(d)).messages[0].source_occurred_at);
 d.raw.prepare('DELETE FROM dm_contacts').run();assert.deepEqual((await diagnostics(d)).messages,[]);
});
