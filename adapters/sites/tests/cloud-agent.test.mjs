import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {cloudAgentTools,waitForMessage,replyToClaim,cloudAgentStatus,cloudAgentFencePrefix,CloudAgentError} from '../worker/cloud-agent.js';
const OWNER='owner-fixture';
const SOURCE='line:01TESTLINEEVENT000000000001';
function setup(){
 const db=new DatabaseSync(':memory:');
 for(const f of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(new URL('../drizzle/'+f,import.meta.url),'utf8'));
 const DB={prepare(sql){return{bind(...values){return{async first(){return db.prepare(sql).get(...values)||null;},async run(){return{meta:{changes:Number(db.prepare(sql).run(...values).changes)}};},async all(){return{results:db.prepare(sql).all(...values)};}};}};}};
 const env={DB,BRIDGE_OWNER_SITE_ID:OWNER,CLOUD_AGENT_ENABLED:'true',CLOUD_AGENT_AFTER:new Date(Date.now()-60000).toISOString()};
 const messages=[{source_key:SOURCE,source_id:'01TESTLINEEVENT000000000001',conversation_key:'line:owner',reply_kind:'line_reply',content:'approved private fixture',timestamp:new Date().toISOString(),replyToken:'never-return-this',botToken:'never-return-token'}];
 const done=new Set(),sends=[];let approved=true,collected=0;
 const adapters={async collectDiscord(){collected++;},async readCandidate(_env,{after_ms,source_key,exclude_source_keys=[]}){return approved?messages.find(m=>Date.parse(m.timestamp)>=after_ms&&!done.has(m.source_key)&&!exclude_source_keys.includes(m.source_key)&&(!source_key||m.source_key===source_key))||null:null;},async sendReply(_env,source,content){sends.push({source,content});done.add(source.source_key);return{status:'completed'};}};
 const state=()=>db.prepare("SELECT key,value FROM bridge_runtime WHERE key LIKE 'cloud_agent:v1:%' AND key NOT LIKE '%:source:%'").get();
 const edit=fn=>{const row=state();const value=JSON.parse(row.value);fn(value);db.prepare('UPDATE bridge_runtime SET value=? WHERE key=?').run(JSON.stringify(value),row.key);};
 return{env,db,adapters,messages,done,sends,state,edit,setApproved(value){approved=value;},get collected(){return collected;}};
}
const wait=(s,args={})=>waitForMessage(s.env,OWNER,{wait_ms:0,...args},s.adapters);
const reply=(s,claim,content='answer')=>replyToClaim(s.env,OWNER,{lease_id:claim.lease_id,claim_id:claim.claim_id,content},s.adapters);
test('cloud agent tools expose only bounded waits and opaque same-claim replies',()=>{
 const [w,r]=cloudAgentTools;assert.equal(w.annotations.readOnlyHint,false);assert.equal(w.annotations.openWorldHint,false);assert.equal(r.annotations.openWorldHint,false);
 assert.deepEqual(Object.keys(r.inputSchema.properties),['lease_id','claim_id','content']);assert.equal(w.inputSchema.properties.wait_ms.maximum,25000);
});
test('disabled, unconfigured activation and non-owner callers fail before reading or claiming',async()=>{
 const s=setup();s.env.CLOUD_AGENT_ENABLED='false';assert.equal((await cloudAgentStatus(s.env,OWNER)).enabled,false);
 await assert.rejects(wait(s),e=>e instanceof CloudAgentError&&e.code==='CLOUD_AGENT_DISABLED');s.env.CLOUD_AGENT_ENABLED='true';delete s.env.CLOUD_AGENT_AFTER;
 await assert.rejects(wait(s),e=>e.code==='CLOUD_AGENT_ACTIVATION_REQUIRED');
 await assert.rejects(waitForMessage(s.env,'other',{wait_ms:0},s.adapters),e=>e.code==='CLOUD_AGENT_OWNER_ONLY');
 assert.equal(s.collected,0);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM bridge_runtime').get().n,0);
});
test('claims project approved content only, never provider secrets or plaintext persisted bodies',async()=>{
 const s=setup();const result=await wait(s);assert.equal(result.status,'message');assert.equal(result.source_key,SOURCE);assert.equal(result.content,'approved private fixture');
 assert.ok(result.lease_id);assert.ok(result.claim_id);assert.equal('replyToken' in result,false);assert.equal('botToken' in result,false);
 const stored=JSON.stringify(s.db.prepare('SELECT * FROM bridge_runtime').all());assert.ok(!stored.includes('approved private fixture'));assert.ok(!stored.includes('never-return'));
 const status=await cloudAgentStatus(s.env,OWNER);assert.equal(status.lease_active,true);assert.equal(status.claim_pending,true);assert.equal('lease_id' in status,false);
});
test('concurrent new consumers receive a single global lease and one claim',async()=>{
 const s=setup();const results=await Promise.all(Array.from({length:8},()=>wait(s)));
 assert.equal(results.filter(r=>r.status==='message').length,1);assert.equal(results.filter(r=>r.status==='busy').length,7);
 assert.equal(JSON.parse(s.state().value).claim.source_key,SOURCE);assert.equal(s.sends.length,0);
});
test('same consumer rereads the same claim while another consumer cannot acquire the active lease',async()=>{
 const s=setup();const a=await wait(s),b=await wait(s,{lease_id:a.lease_id});assert.equal(b.claim_id,a.claim_id);assert.equal(b.lease_id,a.lease_id);assert.equal((await wait(s)).status,'busy');
 assert.equal((await wait(s,{lease_id:'not-a-real-lease-identifier'})).status,'lease_lost');
});
test('expired consumer is fenced from sending and fresh consumer reclaims an unsent message',async()=>{
 const s=setup(),a=await wait(s);s.edit(v=>{v.lease_until=Date.now()-1;});const b=await wait(s);
 assert.equal(b.status,'message');assert.notEqual(b.lease_id,a.lease_id);assert.notEqual(b.claim_id,a.claim_id);
 assert.equal((await reply(s,a)).status,'lease_lost');assert.equal(s.sends.length,0);assert.equal((await reply(s,b)).status,'completed');assert.equal(s.sends.length,1);
});
test('activation watermark never moves backwards and a newer epoch invalidates an old claim',async()=>{
 const s=setup(),a=await wait(s),initial=JSON.parse(s.state().value).after_ms;
 s.env.CLOUD_AGENT_AFTER=new Date(initial-86400000).toISOString();await wait(s,{lease_id:a.lease_id});assert.equal(JSON.parse(s.state().value).after_ms,initial);
 s.env.CLOUD_AGENT_AFTER=new Date(Date.now()+1000).toISOString();assert.equal((await reply(s,a)).status,'lease_lost');assert.equal((await wait(s)).status,'empty');assert.equal(s.sends.length,0);
});
test('policy is rechecked between discovery and claim, and again immediately before reply',async()=>{
 const s=setup(),original=s.adapters.readCandidate;let reads=0;s.adapters.readCandidate=async(...args)=>{reads++;if(reads===2)s.setApproved(false);return original(...args);};
 assert.equal((await wait(s)).status,'empty');assert.equal(JSON.parse(s.state().value).claim,null);
 s.setApproved(true);s.adapters.readCandidate=original;const claim=await wait(s,{lease_id:JSON.parse(s.state().value).lease_id});s.setApproved(false);
 assert.equal((await reply(s,claim)).status,'source_unavailable');assert.equal(s.sends.length,0);assert.equal(JSON.parse(s.state().value).claim,null);
});
test('source identity changes and arbitrary target arguments cannot redirect a claim',async()=>{
 const s=setup(),a=await wait(s);s.messages[0].conversation_key='another-conversation';
 await assert.rejects(reply(s,a),e=>e.code==='CLOUD_AGENT_SOURCE_CHANGED');
 await assert.rejects(replyToClaim(s.env,OWNER,{lease_id:a.lease_id,claim_id:a.claim_id,content:'x',target:'elsewhere'},s.adapters),e=>e.code==='CLOUD_AGENT_INVALID_ARGUMENTS');assert.equal(s.sends.length,0);
});
test('concurrent replies and a lost response never send twice; conflicting text is refused',async()=>{
 const s=setup(),a=await wait(s);const results=await Promise.all([reply(s,a),reply(s,a)]);
 assert.equal(s.sends.length,1);assert.ok(results.some(r=>r.status==='completed'));
 const replay=await reply(s,a);assert.equal(replay.status,'completed');assert.equal(replay.duplicate,true);assert.equal('content_hash' in replay,false);assert.equal(s.sends.length,1);
 await assert.rejects(reply(s,a,'different'),e=>e.code==='CLOUD_AGENT_CONTENT_CONFLICT');
 assert.equal(JSON.parse(s.state().value).claim,null);
});
test('unknown failed and reserved outcomes remain blocked even without an external action receipt',async()=>{
 for(const outcome of ['unknown','failed','reserved','throw']){
  const s=setup();s.adapters.sendReply=async()=>{s.sends.push({});if(outcome==='throw')throw Error('sensitive transport detail');return{status:outcome};};
  const a=await wait(s),result=await reply(s,a);assert.equal(result.status,outcome==='throw'?'unknown':outcome);assert.equal(result.requires_review,true);
  assert.equal((await reply(s,a)).duplicate,true);s.edit(v=>{v.lease_until=0;v.last_result=null;});assert.equal((await wait(s)).status,'empty');assert.equal(s.sends.length,1);
  assert.ok(!JSON.stringify(result).includes('sensitive'));
 }
});
test('a crashed sending claim is fenced permanently when another consumer acquires its expired lease',async()=>{
 const s=setup(),a=await wait(s);s.edit(v=>{v.claim.state='sending';v.claim.content_hash='fixture-hash';v.lease_until=0;});
 const next=await wait(s);assert.equal(next.status,'empty');assert.equal((await reply(s,a)).status,'lease_lost');assert.equal(s.sends.length,0);
 s.edit(v=>{v.lease_until=0;});assert.equal((await wait(s)).status,'empty');
 const fences=s.db.prepare("SELECT value FROM bridge_runtime WHERE key LIKE '%:source:%'").all();assert.equal(fences.length,1);assert.equal(JSON.parse(fences[0].value).status,'unknown');assert.equal(JSON.parse(fences[0].value).source_key,SOURCE);
});
test('forty legacy fences are enriched during the bounded scan so the next wait reaches new input',async()=>{
 const s=setup(),template=s.messages[0],prefix=await cloudAgentFencePrefix(OWNER);s.messages.length=0;
 for(let n=0;n<41;n++)s.messages.push({...template,source_key:'line:fixture-source-'+n,source_id:'fixture-source-'+n});
 for(const message of s.messages.slice(0,40))s.db.prepare('INSERT INTO bridge_runtime VALUES (?,?,?)').run(prefix+createHash('sha256').update(message.source_key).digest('hex'),JSON.stringify({status:'unknown',claim_id:'legacy-claim-'+message.source_id}),Date.now());
 // Model the adapter's owner-scoped SQL fence exclusion. Legacy hash-only
 // records become visible to this predicate only after an exact match.
 const original=s.adapters.readCandidate;s.adapters.readCandidate=async(env,args)=>{
  const blocked=s.db.prepare('SELECT value FROM bridge_runtime WHERE key GLOB ?').all(prefix+'*').map(row=>JSON.parse(row.value).source_key).filter(Boolean);
  return original(env,{...args,exclude_source_keys:[...args.exclude_source_keys,...blocked]});
 };
 const first=await wait(s);assert.equal(first.status,'empty');assert.equal(first.requires_review,true);
 assert.equal(s.db.prepare('SELECT value FROM bridge_runtime WHERE key GLOB ?').all(prefix+'*').filter(row=>JSON.parse(row.value).source_key).length,40);
 const next=await wait(s,{lease_id:first.lease_id});assert.equal(next.status,'message');assert.equal(next.source_id,'fixture-source-40');assert.equal(s.sends.length,0);
});
test('an in-flight stale completion cannot clear a newer consumer claim',async()=>{
 const s=setup(),a=await wait(s);let started,release;const ready=new Promise(r=>{started=r;});s.adapters.sendReply=async()=>{started();await new Promise(r=>{release=r;});return{status:'completed'};};
 const pending=reply(s,a);await ready;s.edit(v=>{v.lease_until=0;});s.messages.push({...s.messages[0],source_key:'line:next-source',source_id:'next-source',timestamp:new Date().toISOString()});
 const b=await wait(s);assert.equal(b.status,'message');assert.equal(b.source_id,'next-source');release();assert.equal((await pending).status,'completed');
 assert.equal(JSON.parse(s.state().value).claim.id,b.claim_id);assert.equal(JSON.parse(s.state().value).lease_id,b.lease_id);
});
test('lease expiry after reserving a send fence still prevents entering the platform send adapter',async()=>{
 const s=setup(),a=await wait(s),prepare=s.env.DB.prepare.bind(s.env.DB);
 s.env.DB.prepare=sql=>({bind(...values){const statement=prepare(sql).bind(...values);return {...statement,async run(){const result=await statement.run();if(sql.startsWith('INSERT OR IGNORE')&&String(values[0]).includes(':source:'))s.edit(v=>{v.lease_until=0;});return result;}};}});
 assert.equal((await reply(s,a)).status,'cancelled');assert.equal(s.sends.length,0);
 const value=s.db.prepare("SELECT value FROM bridge_runtime WHERE key LIKE '%:source:%'").get().value;assert.equal(JSON.parse(value).status,'cancelled');
});
test('deactivation during the final source read prevents reserving or sending a reply',async()=>{
 const s=setup(),a=await wait(s),read=s.adapters.readCandidate;s.adapters.readCandidate=async(...args)=>{const value=await read(...args);s.env.CLOUD_AGENT_ENABLED='false';return value;};
 await assert.rejects(reply(s,a),e=>e.code==='CLOUD_AGENT_DISABLED');assert.equal(s.sends.length,0);assert.equal(s.db.prepare("SELECT COUNT(*) n FROM bridge_runtime WHERE key LIKE '%:source:%'").get().n,0);
});
test('empty and busy long polls are bounded and invalid durations cannot start collection',async()=>{
 const s=setup();s.messages.length=0;const start=Date.now(),a=await wait(s,{wait_ms:15});assert.equal(a.status,'empty');assert.ok(Date.now()-start<500);
 const begin=Date.now();assert.equal((await wait(s,{wait_ms:15})).status,'busy');assert.ok(Date.now()-begin<500);
 const collected=s.collected;for(const wait_ms of [-1,25001,1.5,'25'])await assert.rejects(wait(s,{wait_ms}),e=>e.code==='CLOUD_AGENT_INVALID_ARGUMENTS');assert.equal(s.collected,collected);
});
test('a stalled adapter cannot extend a bounded long poll or claim after its deadline',async()=>{
 const s=setup();s.messages.length=0;s.adapters.collection_background_supported=true;s.adapters.collectDiscord=async()=>new Promise(()=>{});const start=Date.now();assert.equal((await wait(s,{wait_ms:15})).status,'empty');assert.ok(Date.now()-start<500);assert.equal(JSON.parse(s.state().value).claim,null);
});
test('persisted LINE input is claimed before a slow unrelated Discord collector',async()=>{
 const s=setup();s.adapters.collectDiscord=async()=>{throw Error('must not wait for Discord');};const result=await wait(s);assert.equal(result.status,'message');assert.equal(result.source_key,SOURCE);
});
test('LINE arriving during a lifetime-owned Discord collection is claimed within the next poll without a duplicate collector',async()=>{
 const s=setup(),message=s.messages.pop();let release,started;let count=0;
 const ready=new Promise(resolve=>{started=resolve;});s.adapters.collection_background_supported=true;s.adapters.collectDiscord=async()=>{count++;started();await new Promise(resolve=>{release=resolve;});};
 const pending=wait(s,{wait_ms:3000});await ready;await new Promise(resolve=>setTimeout(resolve,20));const arrived=Date.now();s.messages.push(message);
 try{const result=await pending;assert.equal(result.status,'message');assert.equal(result.source_key,SOURCE);assert.ok(Date.now()-arrived<1500);assert.equal(count,1);}
 finally{release();}
});
test('existing reply state is excluded by the adapter and a completed source is never rediscovered',async()=>{
 const s=setup();s.done.add(SOURCE);assert.equal((await wait(s)).status,'empty');const lease=JSON.parse(s.state().value).lease_id;s.done.clear();const a=await wait(s,{lease_id:lease});await reply(s,a);assert.equal((await wait(s,{lease_id:lease})).status,'empty');assert.equal(s.sends.length,1);
});
test('reply length follows the fixed platform kind before any send reservation',async()=>{
 for(const [reply_kind,max] of [['discord_reply_dm',1800],['discord_reply_to_mention',500]]){const s=setup();s.messages[0].reply_kind=reply_kind;const a=await wait(s);await assert.rejects(reply(s,a,'x'.repeat(max+1)),e=>e.code==='CLOUD_AGENT_INVALID_ARGUMENTS');assert.equal(s.sends.length,0);assert.equal(JSON.parse(s.state().value).claim.state,'claimed');}
});
