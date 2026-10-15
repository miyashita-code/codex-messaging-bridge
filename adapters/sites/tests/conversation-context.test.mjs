import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {eventCryptoForTest as codec} from '../worker/events.js';
import {readConversationContext,recordConversationReply,ConversationContextError} from '../worker/conversation-context.js';
const OWNER='synthetic-owner',USER='U'+'1'.repeat(32),BOT='U'+'2'.repeat(32);
function setup(t){
 const raw=new DatabaseSync(':memory:');t.after(()=>raw.close());
 for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'));
 const DB={prepare(sql){return {bind(...values){return {
  async first(){return raw.prepare(sql).get(...values)||null;},
  async run(){return {meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};},
 };}};}};
 const env={DB,BRIDGE_RUNTIME:'cloud',BRIDGE_OWNER_SITE_ID:OWNER,LINE_BOT_ID:BOT,DISCORD_BOT_ID:'4'.repeat(18),DISCORD_GUILD_ID:'5'.repeat(18),COMPANION_SHARED_KEY:Buffer.alloc(32,7).toString('base64')};
 const message=(n=0,extra={})=>({source_key:'line:fixture-source-'+n,source_id:'fixture-source-'+n,conversation_key:'line:'+USER,reply_kind:'line_reply',content:'private input '+n,timestamp:new Date(Date.now()-100000+n).toISOString(),...extra});
 return {raw,env,message};
}
const record=(s,message,content='private confirmed answer')=>recordConversationReply(s.env,OWNER,message,{content,status:'completed'});
const read=(s,message,options)=>readConversationContext(s.env,OWNER,message,options);

test('confirmed pairs survive fresh module calls and only ciphertext and hashed scopes persist',async t=>{
 const s=setup(t),input=s.message();await record(s,input);
 const stored=JSON.stringify(s.raw.prepare('SELECT key,value FROM bridge_runtime').all());
 for(const secret of [input.content,'private confirmed answer',USER,BOT,OWNER,input.source_key])assert.equal(stored.includes(secret),false);
 const result=await read(s,s.message(1));
 assert.deepEqual(result.messages.map(message=>[message.role,message.content]),[['user',input.content],['assistant','private confirmed answer']]);
 assert.deepEqual(Object.keys(result.messages[0]).sort(),['content','role','timestamp']);assert.equal(result.truncated,false);
 const restarted={...s,env:{...s.env}};assert.deepEqual(await read(restarted,s.message(1)),result);
});

test('owner, bot, guild, channel and private/public conversation namespaces never share text',async t=>{
 const s=setup(t);await record(s,s.message());
 for(const extra of [{conversation_key:'line:other'},{reply_kind:'discord_reply_dm',conversation_key:'discord_dm:channel'},{reply_kind:'discord_reply_to_mention',conversation_key:'discord_guild:'+'6'.repeat(18),source_key:'discord_guild:'+'6'.repeat(18)+':'+'7'.repeat(18),source_id:'7'.repeat(18)}])assert.deepEqual((await read(s,s.message(1,extra))).messages,[]);
 const bot=s.env.LINE_BOT_ID;s.env.LINE_BOT_ID='U'+'9'.repeat(32);assert.deepEqual((await read(s,s.message(1))).messages,[]);s.env.LINE_BOT_ID=bot;
 await assert.rejects(readConversationContext(s.env,'other-owner',s.message(1)),ConversationContextError);
 const second={...s.env,BRIDGE_OWNER_SITE_ID:'other-owner'};assert.deepEqual((await readConversationContext(second,'other-owner',s.message(1))).messages,[]);
 const dm=s.message(2,{source_key:'discord_dm:channel:source',source_id:'source',reply_kind:'discord_reply_dm',conversation_key:'discord_dm:channel'});await record(s,dm);
 s.env.DISCORD_GUILD_ID='8'.repeat(18);assert.deepEqual((await read(s,{...dm,source_key:'new-source',timestamp:new Date().toISOString()})).messages,[]);
});

test('ciphertext copied to another conversation key fails authenticated decryption',async t=>{
 const s=setup(t);await record(s,s.message());
 const first=s.raw.prepare('SELECT key,value FROM bridge_runtime').get();
 const other=s.message(1,{conversation_key:'line:other'});await record(s,other);
 const second=s.raw.prepare('SELECT key FROM bridge_runtime WHERE key!=?').get(first.key);
 s.raw.prepare('UPDATE bridge_runtime SET value=? WHERE key=?').run(first.value,second.key);
 await assert.rejects(read(s,{...other,source_key:'new-source'}),ConversationContextError);
});

test('only completed replies are stored and source replays are idempotent or conflicting',async t=>{
 const s=setup(t),message=s.message();
 for(const status of ['unknown','failed','reserved','retryable',undefined])await assert.rejects(recordConversationReply(s.env,OWNER,message,{content:'not confirmed',status}),ConversationContextError);
 assert.equal(s.raw.prepare('SELECT COUNT(*) n FROM bridge_runtime').get().n,0);
 await Promise.all(Array.from({length:6},()=>record(s,message)));
 assert.equal((await read(s,s.message(1))).messages.length,2);
 await assert.rejects(record(s,message,'different answer'),ConversationContextError);
 assert.equal((await read(s,message)).messages.length,0);
});

test('concurrent distinct replies use CAS without losing another committed pair',async t=>{
 const s=setup(t),messages=Array.from({length:6},(_,n)=>s.message(n));
 await Promise.all(messages.map((message,n)=>record(s,message,'answer '+n)));
 const result=await read(s,s.message(20));assert.equal(result.messages.length,12);
 assert.deepEqual(result.messages.filter(message=>message.role==='user').map(message=>message.content),messages.map(message=>message.content));
});

test('context remains bounded by complete pairs, characters and caller lower limits',async t=>{
 const s=setup(t);
 for(let n=0;n<9;n++)await record(s,s.message(n),'answer '+n);
 let result=await read(s,s.message(20));assert.equal(result.messages.length,12);assert.equal(result.truncated,true);assert.equal(result.messages[0].content,'private input 3');
 result=await read(s,s.message(20),{limit:3,max_chars:24000});assert.equal(result.messages.length,2);
 result=await read(s,s.message(20),{limit:100,max_chars:1});assert.equal(result.messages.length,0);
 const large=setup(t);for(let n=0;n<3;n++)await record(large,large.message(n,{content:String(n).repeat(10000)}),'a'.repeat(5000));
 result=await read(large,large.message(20));assert.equal(result.messages.length,2);assert.ok(result.messages.reduce((n,message)=>n+message.content.length,0)<=24000);assert.equal(result.truncated,true);
});

test('expired context is excluded and successful writes prune expired owned ciphertext only',async t=>{
 const s=setup(t),message=s.message();await record(s,message);
 const row=s.raw.prepare('SELECT key,value FROM bridge_runtime').get(),value=await codec.unseal(s.env,row.value,row.key),expired=Date.now()-31*24*3600e3;
 value.turns[0].confirmed_at=expired;
 s.raw.prepare('UPDATE bridge_runtime SET value=?,updated_at=? WHERE key=?').run(await codec.seal(s.env,value,row.key),expired,row.key);
 assert.deepEqual((await read(s,s.message(2))).messages,[]);
 s.raw.prepare('INSERT INTO bridge_runtime VALUES (?,?,?)').run('unrelated-record','preserve',expired);
 await record(s,s.message(3,{conversation_key:'line:second'}));
 assert.equal(s.raw.prepare('SELECT key FROM bridge_runtime WHERE key=?').get(row.key),undefined);
 assert.equal(s.raw.prepare('SELECT value FROM bridge_runtime WHERE key=?').get('unrelated-record').value,'preserve');
});
