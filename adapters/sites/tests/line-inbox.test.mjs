import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import worker,{events} from '../worker/index.js';

const OWNER='U'+'1'.repeat(32),SECOND='U'+'2'.repeat(32),BOT='U'+'3'.repeat(32),UNKNOWN='U'+'4'.repeat(32),VERSION='2026-07-28';
const eventId=n=>'01LINEINBOXEVENT'+String(n).padStart(5,'0');
function setup(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(file=>file.endsWith('.sql')).sort())db.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
 const DB={prepare(sql){return {bind(...values){return {async run(){return {meta:{changes:Number(db.prepare(sql).run(...values).changes)}}},async first(){return db.prepare(sql).get(...values)||null},async all(){return {results:db.prepare(sql).all(...values)}}}}}}};
 const sent=[],callbacks=[];
 const env={DB,BRIDGE_RUNTIME:'cloud',BRIDGE_OWNER_SITE_ID:'owner',LINE_CHANNEL_SECRET:'fixture-secret',LINE_CHANNEL_ACCESS_TOKEN:'fixture-token',LINE_BOT_ID:BOT,LINE_ALLOWED_USER_IDS:OWNER,LINE_ENABLE_EVENTS:'true',LINE_ENABLE_REPLIES:'true',COMPANION_SHARED_KEY:Buffer.alloc(32,7).toString('base64'),CALLBACK_FETCH:async(_url,options)=>{const body=JSON.parse(options.body);if(body.type==='verification')return Response.json({challenge:body.challenge});callbacks.push(body);return Response.json({});},LINE_FETCH:async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});return Response.json({});}};
 return {db,env,sent,callbacks};
}
async function rpc(env,method,params={},owner='owner'){
 const response=await worker.fetch(new Request('https://site.example/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':owner,'MCP-Protocol-Version':VERSION,'Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':params.name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':VERSION,'io.modelcontextprotocol/clientCapabilities':{}}}})}),env);
 return {status:response.status,body:await response.json()};
}
async function tool(env,name,args={},owner){const result=await rpc(env,'tools/call',{name,arguments:args},owner);return {...result,value:result.body.result?.content?JSON.parse(result.body.result.content[0].text):null};}
async function intake(env,entries){
 const body=JSON.stringify({destination:BOT,events:entries.map(({id,user=OWNER,type='user'})=>({webhookEventId:id,type:'message',timestamp:Date.now(),source:{type,userId:user},message:{id:'message-'+id,type:'text',text:'private body '+id},replyToken:'private-reply-token-'+id}))});
 const response=await worker.fetch(new Request('https://site.example/webhooks/line',{method:'POST',headers:{'content-type':'application/json','x-line-signature':createHmac('sha256',env.LINE_CHANNEL_SECRET).update(body).digest('base64')},body}),env);
 assert.equal(response.status,200);
}
async function inbox(env,args={}){const response=await tool(env,'line_inbox_read',args);assert.equal(response.body.result.isError,false,JSON.stringify(response.body));return response.value;}

test('MCP lists read-only LINE inbox with the existing read authorization declaration and blocks anonymous or other users',async t=>{
 const s=setup(t);await intake(s.env,[{id:eventId(1)}]);
 const catalog=(await rpc(s.env,'tools/list')).body.result.tools,read=catalog.find(tool=>tool.name==='line_message_read'),listing=catalog.find(tool=>tool.name==='line_inbox_read');
 assert.ok(listing);assert.deepEqual(listing.securitySchemes,read.securitySchemes);assert.equal(listing.annotations.readOnlyHint,true);assert.equal(listing.inputSchema.properties.limit.maximum,20);assert.equal(listing.inputSchema.additionalProperties,false);
 for(const owner of ['', 'other']){const response=await tool(s.env,'line_inbox_read',{},owner);assert.ok([401,403].includes(response.status));assert.ok(!JSON.stringify(response.body).includes(eventId(1)));}
 assert.equal(s.sent.length,0);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM actions').get().n,0);
});

test('a callback-accepted event remains recoverable until a reply action exists and reveals identifiers only',async t=>{
 const s=setup(t);
 const subscription=await rpc(s.env,'events/subscribe',{name:'line.message.created',arguments:{},delivery:{mode:'webhook',url:'https://chatgpt.com/inbox-test',secret:'whsec_'+Buffer.alloc(32,9).toString('base64')}});assert.ok(subscription.body.result.id);
 await intake(s.env,[{id:eventId(1)}]);assert.equal((await events.drain(s.env)).delivered,1);
 assert.equal(s.db.prepare('SELECT status FROM event_outbox').get().status,'delivered');
 const result=await inbox(s.env);assert.deepEqual(result,{messages:[{event_id:eventId(1),timestamp:new Date(s.db.prepare('SELECT occurred_at FROM cloud_line_messages').get().occurred_at).toISOString()}],next_cursor:null,has_more:false});
 for(const secret of ['private body','private-reply-token','fixture-token',OWNER,BOT])assert.ok(!JSON.stringify(result).includes(secret));
 const read=await tool(s.env,'line_message_read',{event_id:result.messages[0].event_id});assert.equal(read.value.content,'private body '+eventId(1));
 assert.equal(s.sent.length,0);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM actions').get().n,0);
});

test('every existing reply action state is excluded while a message with no action remains available',async t=>{
 const s=setup(t),statuses=['reserved','retryable','unknown','completed','failed','future-state'];
 await intake(s.env,Array.from({length:statuses.length+1},(_,i)=>({id:eventId(i)})));
 for(const [index,status] of statuses.entries())s.db.prepare('INSERT INTO actions (action_key,kind,source_id,recipient_id,status,created_at) VALUES (?,?,?,?,?,?)').run('linereply:'+eventId(index),'linereply',eventId(index),OWNER,status,Date.now());
 assert.deepEqual((await inbox(s.env)).messages.map(message=>message.event_id),[eventId(statuses.length)]);
 assert.equal(s.sent.length,0);
});

test('bounded opaque cursor pages order timestamp ties without skipping or repeating messages and never acknowledge them',async t=>{
 const s=setup(t),ids=Array.from({length:45},(_,i)=>eventId(i));await intake(s.env,ids.map(id=>({id})));
 s.db.prepare('UPDATE cloud_line_messages SET created_at=?').run(1000);
 const seen=[];let cursor;
 do{
  const page=await inbox(s.env,{limit:7,...(cursor?{cursor}:{})});assert.ok(page.messages.length<=7);seen.push(...page.messages.map(message=>message.event_id));
  assert.equal(page.has_more,!!page.next_cursor);cursor=page.next_cursor;if(cursor){assert.ok(cursor.length<=1024);assert.ok(!cursor.includes(eventId(0)));assert.ok(!cursor.includes(OWNER));}
 }while(cursor);
 assert.deepEqual(seen,ids);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM actions').get().n,0);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM cloud_line_messages').get().n,45);
 assert.equal((await inbox(s.env)).messages.length,20);
});

test('unapproved, group and subsequently revoked senders cannot leak through listing or later reads',async t=>{
 const s=setup(t);s.env.LINE_ALLOWED_USER_IDS=OWNER+','+SECOND;
 await intake(s.env,[{id:eventId(1)},{id:eventId(2),user:SECOND},{id:eventId(3),user:UNKNOWN},{id:eventId(4),type:'group'}]);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM cloud_line_messages').get().n,2);
 s.env.LINE_ALLOWED_USER_IDS=OWNER;
 assert.deepEqual((await inbox(s.env)).messages.map(message=>message.event_id),[eventId(1)]);
 assert.equal((await tool(s.env,'line_message_read',{event_id:eventId(2)})).value.error,'LINE_SOURCE_NOT_ALLOWED');
 s.env.LINE_ALLOWED_USER_IDS=UNKNOWN;
 assert.deepEqual(await inbox(s.env),{messages:[],next_cursor:null,has_more:false});
 assert.equal((await tool(s.env,'line_message_read',{event_id:eventId(1)})).value.error,'LINE_SOURCE_NOT_ALLOWED');assert.equal(s.sent.length,0);
});

test('cursor tampering, cross-owner reuse and invalid page arguments fail without returning data',async t=>{
 const s=setup(t);await intake(s.env,[{id:eventId(1)},{id:eventId(2)}]);
 const first=await inbox(s.env,{limit:1});assert.ok(first.next_cursor);
 for(const args of [{limit:0},{limit:21},{limit:1.5},{limit:'2'},{limit:null},{cursor:''},{cursor:null},{cursor:'x'.repeat(1025)},{cursor:'not-a-sealed-cursor'},{cursor:first.next_cursor.slice(0,-4)+'AAAA'},{recipient_id:OWNER}]){
  const response=await tool(s.env,'line_inbox_read',args);assert.equal(response.body.result.isError,true);assert.ok(!JSON.stringify(response.value).includes(eventId(1)));assert.ok(!JSON.stringify(response.value).includes(OWNER));
 }
 s.env.BRIDGE_OWNER_SITE_ID='another-owner';
 const reused=await tool(s.env,'line_inbox_read',{cursor:first.next_cursor},'another-owner');assert.equal(reused.body.result.isError,true);assert.equal(reused.value.error,'INVALID_LINE_INBOX_CURSOR');
});

test('recovery and event tasks racing through actual MCP dispatch reserve the same reply key and send once',async t=>{
 const s=setup(t);await intake(s.env,[{id:eventId(1)}]);
 const candidate=(await inbox(s.env)).messages[0];assert.equal(candidate.event_id,eventId(1));
 // Expired reply tokens use push; the destination is still the stored sender.
 s.db.prepare('UPDATE cloud_line_messages SET created_at=0').run();
 let release,started;const ready=new Promise(resolve=>{started=resolve;});
 s.env.LINE_FETCH=async(url,options)=>{s.sent.push({url,body:JSON.parse(options.body)});started();await new Promise(resolve=>{release=resolve;});return Response.json({});};
 const recovery=tool(s.env,'line_reply',{event_id:candidate.event_id,content:'recovery task reply'});await ready;
 assert.deepEqual((await inbox(s.env)).messages,[]);
 const competing=await tool(s.env,'line_reply',{event_id:candidate.event_id,content:'event task reply'});assert.equal(competing.value.duplicate,true);assert.equal(competing.value.status,'reserved');
 release();assert.equal((await recovery).value.status,'completed');assert.equal(s.sent.length,1);assert.equal(s.sent[0].url,'https://api.line.me/v2/bot/message/push');assert.equal(s.sent[0].body.to,OWNER);assert.equal(s.sent[0].body.messages[0].text,'recovery task reply');
 assert.equal(s.db.prepare('SELECT action_key FROM actions').get().action_key,'linereply:'+candidate.event_id);assert.deepEqual((await inbox(s.env)).messages,[]);
});

test('listing reuses authenticated decryption and never returns an event backed by a corrupt sealed payload',async t=>{
 const s=setup(t);await intake(s.env,[{id:eventId(1)}]);s.db.prepare('UPDATE cloud_line_messages SET body_sealed=?').run('corrupt encrypted fixture');
 const response=await tool(s.env,'line_inbox_read',{});assert.equal(response.body.result.isError,true);assert.ok(!JSON.stringify(response.value).includes(eventId(1)));assert.equal(s.sent.length,0);
});
