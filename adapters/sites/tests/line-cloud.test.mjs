import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import worker,{events} from '../worker/index.js';
import {maintainCloud,cloudRuntimeStatus} from '../worker/cloud-runtime.js';
import {renewCloudLineToken,currentLineToken} from '../worker/line-token.js';
const U='U'+'1'.repeat(32),B='U'+'2'.repeat(32),E='01TESTLINEEVENT000000000001';
function setup(){
 const d=new DatabaseSync(':memory:');for(const f of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())d.exec(readFileSync(new URL('../drizzle/'+f,import.meta.url),'utf8'));
 const DB={raw:d,prepare(sql){return {bind(...v){return {async run(){return {meta:{changes:Number(d.prepare(sql).run(...v).changes)}}},async first(){return d.prepare(sql).get(...v)||null},async all(){return {results:d.prepare(sql).all(...v)}}}}}}};
 const callbacks=[],sent=[];
 const env={BRIDGE_RUNTIME:'cloud',BRIDGE_OWNER_SITE_ID:'owner',DB,LINE_CHANNEL_SECRET:'fixture-secret',LINE_CHANNEL_ACCESS_TOKEN:'fixture-token',LINE_BOT_ID:B,LINE_ALLOWED_USER_IDS:U,LINE_ENABLE_EVENTS:'true',LINE_ENABLE_REPLIES:'true',COMPANION_SHARED_KEY:Buffer.alloc(32,1).toString('base64'),CALLBACK_FETCH:async(url,opts)=>{assert.equal(new URL(url).hostname,'chatgpt.com');assert.equal(opts.redirect,'manual');const b=JSON.parse(opts.body);callbacks.push(b);return Response.json(b.type==='verification'?{challenge:b.challenge}:{});},LINE_FETCH:async(url,opts)=>{sent.push({url,opts});return Response.json({});}};
 return {env,callbacks,sent};
}
async function rpc(env,method,params,owner='owner'){
 const modern=method.startsWith('events/');const body={jsonrpc:'2.0',id:1,method,params:{...params,...(modern?{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}:{})}};
 const r=await worker.fetch(new Request('https://site.example/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':owner,...(modern?{'MCP-Protocol-Version':'2026-07-28','Mcp-Method':method}:{})},body:JSON.stringify(body)}),env);
 return {r,b:await r.json()};
}
const sub={name:'line.message.created',arguments:{},delivery:{mode:'webhook',url:'https://chatgpt.com/fixture-callback',secret:'whsec_'+Buffer.alloc(32,9).toString('base64')}};
function envelope(){return {destination:B,events:[{webhookEventId:E,type:'message',timestamp:Date.now(),source:{type:'user',userId:U},message:{id:'123',type:'text',text:'private LINE fixture'},replyToken:'fixture-reply'}]};}
async function webhook(env,body=envelope(),signature){const raw=JSON.stringify(body);return worker.fetch(new Request('https://site.example/webhooks/line',{method:'POST',headers:{'content-type':'application/json','x-line-signature':signature??createHmac('sha256',env.LINE_CHANNEL_SECRET).update(raw).digest('base64')},body:raw}),env);}
const tool=(env,name,args,owner)=>rpc(env,'tools/call',{name,arguments:args},owner);
test('LINE is serverless: signed intake, encrypted persistence, authenticated MCP, direct verified event callback and same-conversation reply',async()=>{
 const s=setup();assert.ok((await rpc(s.env,'events/subscribe',sub)).b.result.id);
 const body=envelope();assert.equal((await webhook(s.env,body)).status,200);assert.equal((await webhook(s.env,body)).status,200);
 const row=s.env.DB.raw.prepare('SELECT * FROM cloud_line_messages').get();assert.ok(!row.body_sealed.includes('private LINE'));assert.ok(!row.body_sealed.includes('fixture-reply'));
 assert.equal(s.env.DB.raw.prepare('SELECT count(*) n FROM event_outbox').get().n,1);
 assert.equal((await events.drain(s.env)).delivered,1);assert.deepEqual(s.callbacks.at(-1).data,{event_id:E});
 const read=await tool(s.env,'line_message_read',{event_id:E});assert.equal(JSON.parse(read.b.result.content[0].text).content,'private LINE fixture');
 const responses=await Promise.all([tool(s.env,'line_reply',{event_id:E,content:'reply from dot'}),tool(s.env,'line_reply',{event_id:E,content:'reply from dot'})]);assert.equal(s.sent.length,1);assert.equal(JSON.parse(s.sent[0].opts.body).replyToken,'fixture-reply');assert.equal(s.sent[0].url,'https://api.line.me/v2/bot/message/reply');assert.equal(responses.every(r=>!r.b.result.isError),true);
});
test('anonymous or different users cannot read or send through a public Site',async()=>{const s=setup();await webhook(s.env);for(const owner of ['', 'other'])for(const name of ['line_message_read','line_reply']){const r=await tool(s.env,name,{event_id:E,...(name==='line_reply'?{content:'bad'}:{})},owner);assert.ok([401,403].includes(r.r.status));}assert.equal(s.sent.length,0);});
test('forged signature and foreign destination never enter persistent storage',async()=>{const s=setup();assert.equal((await webhook(s.env,envelope(),'x'.repeat(43)+'=')).status,401);assert.equal((await webhook(s.env,{...envelope(),destination:U})).status,400);assert.equal(s.env.DB.raw.prepare('SELECT count(*) n FROM cloud_line_messages').get().n,0);});
test('unknown senders and groups are ignored even with a genuine platform signature',async()=>{const s=setup();for(const source of [{type:'user',userId:'U'+'3'.repeat(32)},{type:'group',userId:U,groupId:'C'+'4'.repeat(32)}]){const b=envelope();b.events[0].source=source;assert.equal((await webhook(s.env,b)).status,200);}assert.equal(s.env.DB.raw.prepare('SELECT count(*) n FROM cloud_line_messages').get().n,0);});
test('empty Verify request is accepted without waking dot',async()=>{const s=setup();assert.equal((await webhook(s.env,{destination:B,events:[]})).status,200);assert.equal(s.callbacks.length,0);});
test('direct callback rejects private, lookalike and arbitrary hosts without any fetch',async()=>{for(const url of ['https://127.0.0.1/','https://chatgpt.com.evil.test/','https://evil.test/']){const s=setup();const r=await rpc(s.env,'events/subscribe',{...sub,delivery:{...sub.delivery,url}});assert.ok(r.b.error);assert.equal(s.callbacks.length,0);}});
test('direct callback rejects redirects and leaves no active subscription',async()=>{const s=setup();s.env.CALLBACK_FETCH=async()=>new Response(null,{status:302,headers:{location:'https://evil.test'}});const r=await rpc(s.env,'events/subscribe',sub);assert.equal(r.b.error.message,'CALLBACK_TRANSPORT_REDIRECT_DENIED');assert.equal(s.env.DB.raw.prepare('SELECT count(*) n FROM event_subscriptions WHERE active=1').get().n,0);});
test('unknown LINE write stays unknown, retry does not duplicate',async()=>{const s=setup();await webhook(s.env);let n=0;s.env.LINE_FETCH=async()=>{n++;throw Error('timeout')};assert.equal((await tool(s.env,'line_reply',{event_id:E,content:'reply'})).b.result.isError,true);const next=await tool(s.env,'line_reply',{event_id:E,content:'reply'});assert.equal(JSON.parse(next.b.result.content[0].text).status,'unknown');assert.equal(n,1);});
test('expired reply uses push with a retry key and recipient bound to stored sender',async()=>{const s=setup();await webhook(s.env);s.env.DB.raw.exec('UPDATE cloud_line_messages SET created_at=0');await tool(s.env,'line_reply',{event_id:E,content:'reply'});assert.ok(s.sent[0].url.endsWith('/push'));assert.equal(JSON.parse(s.sent[0].opts.body).to,U);assert.match(s.sent[0].opts.headers['X-Line-Retry-Key'],/^[0-9a-f-]{36}$/);});
test('cloud maintenance recovers persisted LINE notifications after a failed first callback',async()=>{
 const s=setup();await rpc(s.env,'events/subscribe',sub);await webhook(s.env);
 const original=s.env.CALLBACK_FETCH;s.env.CALLBACK_FETCH=async()=>new Response('',{status:503});
 await events.drain(s.env);s.env.DB.raw.exec('UPDATE event_outbox SET next_attempt_at=0');s.env.CALLBACK_FETCH=original;
 const result=await maintainCloud(s.env,{discord:()=>{},events,configured:()=>false});assert.equal(result.delivered,1);assert.equal((await cloudRuntimeStatus(s.env)).healthy,true);
});
test('cloud recovery tick cannot be triggered anonymously or cross-origin',async()=>{const s=setup();for(const headers of [{origin:'https://site.example'},{origin:'https://evil.test','oai-authenticated-user-id':'owner'}]){const r=await worker.fetch(new Request('https://site.example/runtime/tick',{method:'POST',headers}),s.env);assert.ok([401,403].includes(r.status));}});
test('Discord recovery persists cursor, filters bot loops and resumes from the same database',async()=>{
 const s=setup(),C='222222222222222222',G='333333333333333333',D='444444444444444444',H='555555555555555555';
 Object.assign(s.env,{DISCORD_ENABLE_EVENTS:'true',DISCORD_CLOUD_SINCE:new Date(Date.now()-1000).toISOString(),DISCORD_POLL_CHANNEL_IDS:C,DISCORD_GUILD_ID:G,DISCORD_BOT_ID:D});
 const id=String(BigInt(Date.now()-1420070400000)<<22n),next=String(BigInt(id)+1n),seen=[];
 let rows=[{id:next,channel_id:C,author:{id:D,bot:true}},{id,channel_id:C,author:{id:H}}];
 const deps={configured:()=>true,discord:async (_env,path)=>path==='/channels/'+C?{id:C,guild_id:G,type:0}:rows,events:{enqueue:async(_e,m)=>seen.push(m.message_id),drain:async()=>({delivered:0})}};
 await maintainCloud(s.env,deps);await maintainCloud({...s.env},deps);assert.deepEqual(seen,[id]);
 rows=[{id:String(BigInt(next)+1n),channel_id:C,author:{id:H}}];await maintainCloud(s.env,deps);assert.equal(seen.length,2);
});
test('a live maintenance lease excludes another worker and a stale lease is recoverable',async()=>{const s=setup();s.env.DB.raw.prepare("INSERT INTO bridge_runtime VALUES ('cloud_lease','other',?)").run(Date.now());const deps={configured:()=>false,events:{drain:async()=>({delivered:0})}};assert.equal((await maintainCloud(s.env,deps)).busy,true);s.env.DB.raw.exec("UPDATE bridge_runtime SET updated_at=0 WHERE key='cloud_lease'");assert.equal((await maintainCloud(s.env,deps)).busy,undefined);});
test('LINE renewal is skipped while existing token is healthy',async()=>{const s=setup();s.env.LINE_CHANNEL_ID='12345';s.env.LINE_TOKEN_EXPIRES_AT=new Date(Date.now()+30*86400000).toISOString();s.env.LINE_TOKEN_FETCH=()=>{throw Error('must not request')};assert.equal((await renewCloudLineToken(s.env)).renewed,false);assert.equal(await currentLineToken(s.env),'fixture-token');});
test('LINE renewal verifies channel and bot before atomically using encrypted new token',async()=>{const s=setup();s.env.LINE_CHANNEL_ID='12345';s.env.LINE_TOKEN_EXPIRES_AT=new Date(Date.now()+3600000).toISOString();const secret='renewed-fixture-token-value';const paths=[];s.env.LINE_TOKEN_FETCH=async(url,opts)=>{assert.equal(opts.redirect,'manual');const p=new URL(url).pathname;paths.push(p);return Response.json(p==='/v2/oauth/accessToken'?{access_token:secret,expires_in:2592000}:p==='/v2/oauth/verify'?{client_id:'12345',expires_in:2592000}:{userId:B});};assert.equal((await renewCloudLineToken(s.env)).renewed,true);assert.equal(await currentLineToken(s.env),secret);assert.ok(!JSON.stringify(s.env.DB.raw.prepare('SELECT * FROM bridge_runtime').all()).includes(secret));await renewCloudLineToken(s.env);assert.equal(paths.length,3);});
test('ambiguous token issuance is journaled and never creates more tokens on retry',async()=>{const s=setup();s.env.LINE_CHANNEL_ID='12345';s.env.LINE_TOKEN_EXPIRES_AT=new Date(Date.now()+3600000).toISOString();let n=0;s.env.LINE_TOKEN_FETCH=async()=>{n++;throw Error('timeout')};assert.equal((await renewCloudLineToken(s.env)).requires_review,true);assert.equal((await renewCloudLineToken(s.env)).requires_review,true);assert.equal(n,1);assert.equal(await currentLineToken(s.env),'fixture-token');});
