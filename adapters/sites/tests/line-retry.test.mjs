import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {lineCall,retryCloudLineReplies} from '../worker/line.js';
import {eventCryptoForTest as codec} from '../worker/events.js';
const E='01LINE429RECOVERYTEST',U='U'+'1'.repeat(32),B='U'+'2'.repeat(32);
async function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const f of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(new URL('../drizzle/'+f,import.meta.url),'utf8'));
 const DB={prepare(sql){return {bind(...v){return {async run(){return {meta:{changes:Number(db.prepare(sql).run(...v).changes)}}},async first(){return db.prepare(sql).get(...v)||null},async all(){return {results:db.prepare(sql).all(...v)}}}}}}};
 const env={BRIDGE_RUNTIME:'cloud',DB,BRIDGE_OWNER_SITE_ID:'owner',LINE_CHANNEL_SECRET:'fixture-secret',LINE_CHANNEL_ACCESS_TOKEN:'fixture-token',LINE_BOT_ID:B,LINE_ALLOWED_USER_IDS:U,LINE_ENABLE_REPLIES:'true',COMPANION_SHARED_KEY:Buffer.alloc(32,7).toString('base64')};
 db.prepare('INSERT INTO cloud_line_messages VALUES (?,?,?,?,?)').run(E,U,await codec.seal(env,{text:'fixture',replyToken:'fixture-reply'},'line:'+E),Date.now(),0);
 return {env,db};
}
async function due(s){
 const key='line_reply_retry:'+E,row=s.db.prepare('SELECT value FROM bridge_runtime WHERE key=?').get(key),pending=await codec.unseal(s.env,row.value,key);
 pending.nextAttemptAt=0;s.db.prepare('UPDATE bridge_runtime SET value=? WHERE key=?').run(await codec.seal(s.env,pending,key),key);
}
test('a rejected 429 survives restart and recovers with the original recipient, content and push retry key',async t=>{
 const s=await fixture(t),requests=[];
 s.env.LINE_FETCH=async(url,opts)=>{requests.push({url,opts});return requests.length===1?new Response(null,{status:429,headers:{'retry-after':'60'}}):Response.json({});};
 await assert.rejects(lineCall('line_reply',{event_id:E,content:'private approved response'},s.env),{code:'LINE_HTTP_429'});
 assert.equal(s.db.prepare('SELECT status FROM actions').get().status,'retryable');
 assert(!s.db.prepare('SELECT value FROM bridge_runtime WHERE key=?').get('line_reply_retry:'+E).value.includes('private approved response'));
 assert.equal((await retryCloudLineReplies(s.env)).retried,0);
 await assert.rejects(lineCall('line_reply',{event_id:E,content:'changed response'},s.env),{code:'LINE_REPLY_CONTENT_CONFLICT'});
 await due(s);
 assert.deepEqual(await retryCloudLineReplies({...s.env}),{retried:1,completed:1});
 assert.equal(requests.length,2);
 assert.equal(requests[0].opts.headers['X-Line-Retry-Key'],requests[1].opts.headers['X-Line-Retry-Key']);
 assert.equal(requests[1].url,'https://api.line.me/v2/bot/message/push');
 assert.deepEqual(JSON.parse(requests[1].opts.body),{to:U,messages:[{type:'text',text:'private approved response'}]});
 await lineCall('line_reply',{event_id:E,content:'private approved response'},s.env);assert.equal(requests.length,2);
 assert.equal(s.db.prepare("SELECT count(*) n FROM bridge_runtime WHERE key GLOB 'line_reply_retry:*'").get().n,0);
});
test('concurrent due retry attempts send only once',async t=>{
 const s=await fixture(t);s.env.LINE_FETCH=async()=>new Response(null,{status:429});
 await assert.rejects(lineCall('line_reply',{event_id:E,content:'response'},s.env));await due(s);
 let calls=0;s.env.LINE_FETCH=async()=>{calls++;return Response.json({});};
 await Promise.all([lineCall('line_reply',{event_id:E,content:'response'},s.env),lineCall('line_reply',{event_id:E,content:'response'},s.env)]);
 assert.equal(calls,1);
});
test('unknown and permanent writes are never automatically retried, and revoked senders remain blocked',async t=>{
 for(const status of [500,403]){
  const s=await fixture(t);let calls=0;s.env.LINE_FETCH=async()=>{calls++;return new Response(null,{status});};
  await assert.rejects(lineCall('line_reply',{event_id:E,content:'response'},s.env));
  assert.equal((await retryCloudLineReplies(s.env)).retried,0);assert.equal(calls,1);
 }
 const s=await fixture(t);let calls=0;s.env.LINE_FETCH=async()=>{calls++;return new Response(null,{status:429});};
 await assert.rejects(lineCall('line_reply',{event_id:E,content:'response'},s.env));await due(s);
 s.env.LINE_ALLOWED_USER_IDS='U'+'3'.repeat(32);
 const result=await retryCloudLineReplies(s.env);assert.deepEqual(result.failures,['LINE_SOURCE_NOT_ALLOWED']);assert.equal(calls,1);
});
test('repeated explicit throttling stops after eight total attempts',async t=>{
 const s=await fixture(t);let calls=0;s.env.LINE_FETCH=async()=>{calls++;return new Response(null,{status:429});};
 await assert.rejects(lineCall('line_reply',{event_id:E,content:'response'},s.env));
 for(let i=0;i<10;i++){await due(s);await retryCloudLineReplies(s.env);}
 assert.equal(calls,8);assert.equal(s.db.prepare('SELECT status FROM actions').get().status,'failed');
});
