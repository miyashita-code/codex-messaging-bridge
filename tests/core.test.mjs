import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../src/config.mjs';
import { admitted,addressed,groupConfig,stripMentions } from '../src/policy.mjs';
import { Store } from '../src/store.mjs';
import { Bridge } from '../src/bridge.mjs';
import { startServer } from '../src/server.mjs';
import { configureLine,saveEnvValues } from '../src/onboarding.mjs';

function fixture({backend='dot',line={}}={}) {
  const dir=mkdtempSync(join(tmpdir(),'line-core-'));
  const config=normalizeConfig({backend,port:0,dataDir:dir,publicUrl:'https://bridge.example.com',ownerSecret:'test-owner-long-secret',mcp:{token:'test-local-token'},channels:{line:{channelAccessToken:'test-channel-token',channelSecret:'test-channel-secret',dmPolicy:'allowlist',allowFrom:['U1'],groupPolicy:'allowlist',groupAllowFrom:[],...line}}},{base:dir,env:{}});
  const store=new Store(':memory:'),sent=[],clients=new Map([['default',{reply:async(token,messages)=>{sent.push({mode:'reply',token,messages});return {sentMessages:[{id:randomUUID()}]};},push:async(to,messages,key)=>{sent.push({mode:'push',to,messages,key});return {sentMessages:[{id:randomUUID()}]};},loading:async()=>{}}]]);
  const bridge=new Bridge({config,store,clients,mcp:{publish:async()=>{}},logger:()=>{}});
  const cleanup=()=>{store.close();rmSync(dir,{recursive:true,force:true});};
  return {dir,config,store,sent,clients,bridge,cleanup};
}
const event=(text='hello',userId='U1',extra={})=>({type:'message',webhookEventId:randomUUID(),timestamp:Date.now(),replyToken:'test-reply',source:{type:'user',userId},message:{type:'text',id:randomUUID(),text},...extra});
const waitUntil=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('condition did not become true');};

test('OpenClaw policies keep DM and group permissions independent with wildcard inheritance',()=>{
  const a={dmPolicy:'open',allowFrom:['*'],groupPolicy:'allowlist',groupAllowFrom:[],groups:{'*':{enabled:false,allowFrom:['U1'],requireMention:true},G1:{enabled:true}}};
  assert.equal(admitted(a,{type:'user',userId:'U2'},false),true);
  assert.equal(admitted(a,{type:'group',groupId:'G1',userId:'U1'},false),true);
  assert.equal(admitted(a,{type:'group',groupId:'G1',userId:'U2'},false),false);
  assert.equal(admitted(a,{type:'group',groupId:'G2',userId:'U1'},false),false);
  assert.deepEqual(groupConfig(a,'G1'),{enabled:true,allowFrom:['U1'],requireMention:true});
  assert.equal(admitted(a,{type:'user'},true),false);
});
test('group mentions use isSelf/all and quoted bot rules; removal preserves UTF16 neighboring text',()=>{
  const a={groups:{}},e=event('前@Bot後','U1',{source:{type:'group',groupId:'G1',userId:'U1'}});
  assert.equal(addressed(a,e),false);assert.equal(addressed(a,e,true),true);assert.equal(addressed(a,e,true,false),false);
  e.message.mention={mentionees:[{index:1,length:4,isSelf:true}]};assert.equal(addressed(a,e),true);assert.equal(stripMentions(e.message),'前 後');
  e.message.mention={mentionees:[{index:1,length:4,type:'all'}]};assert.equal(addressed(a,e),true);
});
test('config rejects unsafe policy, duplicate routes and credential symlinks',()=>{
  const f=fixture();try{
    assert.throws(()=>normalizeConfig({channels:{line:{dmPolicy:'open'}}},{env:{}}),/requires/);
    assert.throws(()=>normalizeConfig({channels:{line:{accounts:{a:{webhookPath:'/same'},b:{webhookPath:'/same'}}}}},{env:{}}),/unique/);
    assert.throws(()=>normalizeConfig({codex:{sandbox:'danger-full-access'},channels:{line:{}}},{env:{}}),/sandbox/);
    assert.throws(()=>normalizeConfig({publicUrl:'https://owner:password@example.com',channels:{line:{}}},{env:{}}),/origin/);
    assert.throws(()=>normalizeConfig({publicUrl:'https://example.com/with-path',channels:{line:{}}},{env:{}}),/origin/);
    writeFileSync(join(f.dir,'secret'),'private');symlinkSync(join(f.dir,'secret'),join(f.dir,'link'));
    assert.throws(()=>normalizeConfig({channels:{line:{secretFile:'link'}}},{base:f.dir,env:{}}),/symlink/);
  }finally{f.cleanup();}
});
test('named accounts never inherit channel credentials and per-group allowlists narrow open groups',()=>{
  const c=normalizeConfig({channels:{line:{channelAccessToken:'default-token',channelSecret:'default-secret',mediaMaxMb:5,accounts:{default:{},marketing:{webhookPath:'/line/marketing'}}}}},{env:{}});
  assert.equal(c.accounts[0].channelAccessToken,'default-token');assert.equal(c.accounts[1].channelAccessToken,'');assert.equal(c.accounts[1].channelSecret,'');assert.equal(c.accounts[1].mediaMaxMb,5);
  const a={groupPolicy:'open',groups:{G1:{allowFrom:['U1']}}};assert.equal(admitted(a,{type:'group',groupId:'G1',userId:'U2'},false),false);assert.equal(admitted(a,{type:'group',groupId:'G2',userId:'U2'},false),true);
});
test('standard channel onboarding stores secrets privately without printing or replacing other settings',async()=>{
  const f=fixture();try{
    const path=join(f.dir,'.env');writeFileSync(path,'LINE_BRIDGE_OWNER_SECRET=existing-owner\nLINE_CHANNEL_SECRET=old\n',{mode:0o644});
    const answers=['fake-channel-token','fake-channel-secret'],output=[];await configureLine({envPath:path,ask:async(label,options)=>{assert.equal(options.secret,true);return answers.shift();},write:s=>output.push(s)});
    assert.ok(readFileSync(path,'utf8').includes('existing-owner'));assert.ok(readFileSync(path,'utf8').includes('fake-channel-token'));assert.equal(statSync(path).mode&0o777,0o600);
    assert.ok(!output.join('\n').includes('fake-channel'));assert.ok(output.join('\n').includes('pairing approve line'));
    assert.throws(()=>saveEnvValues(path,{LINE_CHANNEL_SECRET:'x\nINJECT=bad'}),/Invalid/);
  }finally{f.cleanup();}
});
test('pairing creates one eight-character challenge, caps pending, expires and revokes',()=>{
  const s=new Store(':memory:');try{
    const p=s.pairing('default','U1');assert.match(p.code,/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);assert.equal(p.created,true);
    assert.equal(s.pairing('default','U1').created,false);s.pairing('default','U2');s.pairing('default','U3');assert.equal(s.pairing('default','U4').code,undefined);
    assert.ok(s.approve(p.code));assert.equal(s.paired('default','U1'),true);assert.equal(s.revoke('default','U1'),true);assert.equal(s.paired('default','U1'),false);
    s.db.prepare('UPDATE pairings SET expires=0').run();assert.equal(s.approve(s.db.prepare('SELECT code FROM pairings LIMIT 1').get().code),undefined);
  }finally{s.close();}
});
test('durable queue deduplicates and preserves conversation order while controls beat a large backlog',()=>{
  const s=new Store(':memory:');try{
    const e=event();assert.equal(s.enqueue('default','same',e,'one'),true);assert.equal(s.enqueue('default','same',e,'one'),false);s.enqueue('default','same',e,'two');
    for(let i=0;i<100;i++)s.enqueue('default',`backlog-${i}`,e,`backlog-${i}`);
    s.enqueue('default','same:control',e,'control');assert.equal(s.pending(1)[0].id,'control');
    s.finish('control');assert.equal(s.pending(1)[0].id,'one');s.claim('one');assert.ok(!s.pending(200).some(j=>j.id==='two'));
    s.finish('one');assert.ok(s.pending(200).some(j=>j.id==='two'));
  }finally{s.close();}
});
test('admission precedes media downloads and model work; stale permission blocks read and reply',async()=>{
  const f=fixture();let published=0;f.bridge.mcp={publish:async()=>published++};try{
    const denied=event('hello','U2');f.bridge.ingest(f.config.accounts[0],denied);await f.bridge.process(f.store.pending()[0]);assert.equal(published,0);assert.equal(f.bridge.listInbox().length,0);
    const allowed=event();f.bridge.ingest(f.config.accounts[0],allowed);await f.bridge.process(f.store.pending().find(j=>j.id.endsWith(allowed.message.id)));
    assert.equal(published,1);const id=`default:message:${allowed.message.id}`;assert.equal(f.bridge.readMessage(id).text,'hello');assert.equal(f.bridge.readMessage(id).replyToken,undefined);
    f.config.accounts[0].allowFrom=[];assert.throws(()=>f.bridge.readMessage(id),/available/);await assert.rejects(f.bridge.sendReply({messageId:id,text:'secret',idempotencyKey:'key'}),/available/);
  }finally{f.cleanup();}
});
test('outbound commits each batch, rejects conflicting keys, and retries push with the same key',async()=>{
  const f=fixture();try{
    f.store.saveSession('default:user:U1','default',{type:'user',userId:'U1'});
    f.store.saveMessage('default:user:U1',{id:'m',accountId:'default',conversationId:'U1',userId:'U1',type:'text',timestamp:new Date(0).toISOString(),text:'x'});
    let attempts=0,key;f.clients.get('default').push=async(to,messages,k)=>{assert.equal(k,key || k);key=k;if(!attempts++)throw Object.assign(new Error('rate'),{status:429,retryable:true});return {sentMessages:[{id:'sent'}]};};
    await assert.rejects(f.bridge.sendReply({messageId:'m',text:'answer',idempotencyKey:'stable'}));
    const r=await f.bridge.sendReply({messageId:'m',text:'answer',idempotencyKey:'stable'});assert.equal(r.accepted,true);assert.equal(attempts,2);
    assert.equal((await f.bridge.sendReply({messageId:'m',text:'answer',idempotencyKey:'stable'})).duplicate,true);assert.equal(attempts,2);
    await assert.rejects(f.bridge.sendReply({messageId:'m',text:'different',idempotencyKey:'stable'}),/conflict/);
  }finally{f.cleanup();}
});
test('uncertain reply receipt cannot be replayed, and concurrent differing payloads conflict',async()=>{
  const f=fixture();try{
    f.store.saveSession('s','default',{type:'user',userId:'U1'});f.store.saveMessage('s',{id:'m',accountId:'default',conversationId:'U1',userId:'U1',timestamp:new Date().toISOString(),replyToken:'r',text:'x'});
    let release;f.clients.get('default').reply=async()=>{await new Promise(r=>release=r);return {uncertain:true};};
    const first=f.bridge.sendReply({messageId:'m',text:'a',idempotencyKey:'k'});
    await assert.rejects(f.bridge.sendReply({messageId:'m',text:'b',idempotencyKey:'k'}),/conflict/);release();await assert.rejects(first,/uncertain/);
    await assert.rejects(f.bridge.sendReply({messageId:'m',text:'a',idempotencyKey:'k'}),/uncertain/);assert.equal(f.sent.length,0);
  }finally{f.cleanup();}
});
test('approval answers are bound to account, conversation and original sender',async()=>{
  const f=fixture({backend:'codex'});const answers=[];f.bridge.backend={answer:(id,r)=>{answers.push([id,r]);return true;}};try{
    const e=event();await f.bridge.request(f.config.accounts[0],e,'key',{requestId:'req',method:'item/commandExecution/requestApproval',params:{command:'touch example'}});
    const code=[...f.bridge.requests.keys()][0];await f.bridge.answer(f.config.accounts[0],event('','U2'),`/approve ${code}`);assert.equal(answers.length,0);
    await f.bridge.answer(f.config.accounts[0],e,`/approve ${code}`);assert.deepEqual(answers,[['req',{decision:'accept'}]]);
    await f.bridge.answer(f.config.accounts[0],e,`/approve ${code}`);assert.equal(answers.length,1);
  }finally{f.cleanup();}
});
test('approval controls progress while every normal worker slot is waiting and backlog is larger than the scan limit',async()=>{
  const f=fixture({backend:'codex'});f.config.concurrency=1;let resolveRun;
  f.bridge.backend={run:async r=>{await r.onThread('thread');await r.onRequest({requestId:'req',method:'item/commandExecution/requestApproval',params:{command:'safe-test'}});return new Promise(resolve=>resolveRun=()=>resolve({threadId:'thread',text:'finished'}));},answer:()=>{resolveRun();return true;},close:async()=>{},interrupt:async()=>{}};
  try{
    f.bridge.ingest(f.config.accounts[0],event());f.bridge.start();await waitUntil(()=>f.bridge.requests.size===1 && !!resolveRun);
    for(let i=0;i<20;i++)f.bridge.ingest(f.config.accounts[0],event('backlog',`U-other-${i}`));
    const code=[...f.bridge.requests.keys()][0];f.bridge.ingest(f.config.accounts[0],event(`/approve ${code}`));
    await waitUntil(()=>f.bridge.requests.size===0);await waitUntil(()=>f.sent.some(s=>s.messages.some(m=>m.text==='finished')));
  }finally{await f.bridge.close();f.cleanup();}
});
test('image sets picked out of order reach the agent in LINE index order as one turn',async()=>{
  const f=fixture();const published=[];f.bridge.mcp={publish:async m=>published.push(m)};
  f.clients.get('default').download=async(id,path)=>{writeFileSync(path,Buffer.from(id));return {path,contentType:'image/png',size:id.length};};
  try{
    const first=event('', 'U1'),second=event('','U1');first.message={type:'image',id:'image-two',imageSet:{id:'set',index:2,total:2}};second.message={type:'image',id:'image-one',imageSet:{id:'set',index:1,total:2}};
    f.bridge.ingest(f.config.accounts[0],first);f.bridge.ingest(f.config.accounts[0],second);f.bridge.start();await waitUntil(()=>published.length===1);
    assert.deepEqual(published[0].media.items.map(i=>i.messageId),['default:message:image-one','default:message:image-two']);
    assert.equal(f.bridge.readMedia(published[0].id).length,2);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='done'").get().n,2);
  }finally{await f.bridge.close();f.cleanup();}
});
test('crash recovery requeues unadopted or completed work but never replays an unfinished agent',()=>{
  const s=new Store(':memory:');try{
    for(const id of ['before','unfinished','finished']){s.enqueue('default',id,event(),id);s.claim(id);}
    s.db.prepare('INSERT INTO runs(id,finished,text) VALUES(?,?,?)').run('unfinished',0,null);s.db.prepare('INSERT INTO runs(id,finished,text) VALUES(?,?,?)').run('finished',1,'done');s.recoverProcessing();
    assert.equal(s.db.prepare('SELECT status FROM jobs WHERE id=?').get('before').status,'pending');assert.equal(s.db.prepare('SELECT status FROM jobs WHERE id=?').get('finished').status,'pending');assert.equal(s.db.prepare('SELECT status FROM jobs WHERE id=?').get('unfinished').status,'dead');
  }finally{s.close();}
});
test('HTTP LINE to Your dot event and idempotent LINE reply form one complete mock integration',async()=>{
  const f=fixture(),notifications=[];const app=await startServer(f.config,{store:f.store,clients:f.clients,logger:()=>{},acquireLock:false,webhookFetch:async(url,options)=>{const b=JSON.parse(options.body);if(b.type==='verification')return {ok:true,status:200,json:async()=>({challenge:b.challenge})};notifications.push(b);return {ok:true,status:202};}});
  const url=`http://127.0.0.1:${app.server.address().port}`;
  const rpc=async(method,params={})=>(await fetch(`${url}/mcp`,{method:'POST',headers:{authorization:'Bearer test-local-token'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();
  const inbound=async e=>{const b=JSON.stringify({events:[e]});return fetch(`${url}/line/webhook`,{method:'POST',body:b,headers:{'x-line-signature':createHmac('sha256','test-channel-secret').update(b).digest('base64')}});};
  try{
    await inbound(event());await waitUntil(()=>f.bridge.listConversations().length===1);
    const sub=await rpc('events/subscribe',{name:'line.message.created',arguments:{account_id:'default',conversation_id:'U1'},delivery:{mode:'webhook',url:'https://callback.example.com/events',secret:'whsec_'+Buffer.alloc(32,1).toString('base64')}});assert.ok(sub.result.id);
    await inbound(event('new request'));await waitUntil(()=>notifications.length===1);
    const id=notifications[0].data.message_id,read=await rpc('tools/call',{name:'line_read_message',arguments:{message_id:id}});assert.equal(read.result.structuredContent.message.text,'new request');
    const reply={name:'line_reply',arguments:{message_id:id,text:'completed',idempotency_key:'stable-answer'}};assert.equal((await rpc('tools/call',reply)).result.structuredContent.delivery.accepted,true);await rpc('tools/call',reply);assert.equal(f.sent.length,1);
    assert.equal((await rpc('bad-method')).error.code,-32601);
    const malformed=await fetch(`${url}/mcp`,{method:'POST',headers:{authorization:'Bearer test-local-token'},body:'null'});assert.equal((await malformed.json()).error.code,-32600);
  }finally{await app.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('real HTTP verifies raw LINE webhook bytes, durably acknowledges, rejects large input and authenticates MCP',async()=>{
  const f=fixture();const app=await startServer(f.config,{store:f.store,clients:f.clients,logger:()=>{},acquireLock:false});
  const url=`http://127.0.0.1:${app.server.address().port}`;try{
    const body=JSON.stringify({events:[event('hello')]}),signature=createHmac('sha256','test-channel-secret').update(body).digest('base64');
    assert.equal((await fetch(`${url}/line/webhook`,{method:'POST',body,headers:{'x-line-signature':'wrong'}})).status,401);
    assert.equal((await fetch(`${url}/line/webhook`,{method:'POST',body,headers:{'x-line-signature':signature}})).status,200);
    assert.equal((await fetch(`${url}/line/webhook`,{method:'POST',body,headers:{'x-line-signature':signature}})).status,200);
    await waitUntil(()=>f.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='done'").get().n===1);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,1);
    assert.equal((await fetch(`${url}/line/webhook`,{method:'POST',body:'x'.repeat(65537)})).status,413);
    assert.equal((await fetch(`${url}/mcp`,{method:'POST',body:'{}'})).status,401);
    const response=await fetch(`${url}/mcp`,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server/discover'}),headers:{authorization:'Bearer test-local-token'}});
    assert.equal(response.status,200);assert.ok((await response.json()).result.capabilities.events);
    assert.equal((await fetch(`${url}/line/webhook`,{method:'POST',body:JSON.stringify({events:[]}),headers:{'x-line-signature':createHmac('sha256','test-channel-secret').update(JSON.stringify({events:[]})).digest('base64')}})).status,200);
  }finally{await app.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('OAuth PKCE consent, single-use code, scopes, rotating refresh and revocation work over HTTP',async()=>{
  const f=fixture();const app=await startServer(f.config,{store:f.store,clients:f.clients,logger:()=>{},acquireLock:false});
  const url=`http://127.0.0.1:${app.server.address().port}`;const post=(path,body)=>fetch(url+path,{method:'POST',body:new URLSearchParams(body),redirect:'manual'});try{
    const client=await (await fetch(`${url}/oauth/register`,{method:'POST',body:JSON.stringify({redirect_uris:['https://chat.example.com/callback']})})).json();
    const verifier='v'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url');
    const query=new URLSearchParams({client_id:client.client_id,redirect_uri:'https://chat.example.com/callback',response_type:'code',code_challenge_method:'S256',code_challenge:challenge,state:'opaque-state',scope:'line:read'});
    const consent=await fetch(`${url}/oauth/authorize?${query}`),html=await consent.text(),cookie=consent.headers.get('set-cookie').split(';')[0],csrf=/name="csrf" value="([^"]+)"/.exec(html)[1];
    const approved=await fetch(`${url}/oauth/consent`,{method:'POST',body:new URLSearchParams({csrf,owner_secret:'test-owner-long-secret',decision:'accept'}),headers:{cookie},redirect:'manual'});
    assert.equal(approved.status,302);const redirect=new URL(approved.headers.get('location'));assert.equal(redirect.searchParams.get('state'),'opaque-state');
    const tokenArgs={grant_type:'authorization_code',client_id:client.client_id,redirect_uri:'https://chat.example.com/callback',code:redirect.searchParams.get('code'),code_verifier:verifier};
    const tokens=await (await post('/oauth/token',tokenArgs)).json();assert.ok(tokens.access_token);assert.equal((await post('/oauth/token',tokenArgs)).status,400);
    const rpc={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'line_reply',arguments:{}}};
    assert.equal((await fetch(`${url}/mcp`,{method:'POST',headers:{authorization:`Bearer ${tokens.access_token}`},body:JSON.stringify(rpc)})).status,403);
    const rotated=await (await post('/oauth/token',{grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token})).json();assert.ok(rotated.access_token);
    assert.equal((await post('/oauth/token',{grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token})).status,400);
    await post('/oauth/revoke',{token:rotated.access_token,client_id:client.client_id});
    assert.equal(app.oauth.authenticate({headers:{authorization:`Bearer ${rotated.access_token}`}}),null);
    assert.equal((await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)).status,200);
  }finally{await app.close();rmSync(f.dir,{recursive:true,force:true});}
});
