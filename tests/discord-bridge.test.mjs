import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync,writeFileSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { DiscordBridge,splitDiscordText } from '../src/discord-bridge.mjs';
import { Bridge } from '../src/bridge.mjs';
import { startServer } from '../src/server.mjs';
import { configureDiscord } from '../src/onboarding.mjs';
import { DiscordClient } from '../src/discord.mjs';

const USER='111111111111111111',BOT='222222222222222222',CHANNEL='333333333333333333',GUILD='444444444444444444';
let sequence=100000000000000000n;
const incoming=(content='hello',extra={})=>({id:String(++sequence),channel_id:CHANNEL,author:{id:USER},content,timestamp:new Date().toISOString(),channel:{id:CHANNEL,type:1},bot_id:BOT,...extra});
function fixture({backend='inbox',transport='headless',discord={},withLine=false}={}) {
  const dir=mkdtempSync(join(tmpdir(),'discord-bridge-'));
  const raw={backend,transport,port:0,dataDir:dir,publicUrl:transport==='http'?'https://bridge.example.com':'',ownerSecret:'test-owner-secret',mcp:{token:'test-mcp-token'},channels:{line:withLine?{enabled:true,channelAccessToken:'line-token',channelSecret:'line-secret',dmPolicy:'allowlist',allowFrom:['U1']}:{enabled:false},discord:{enabled:true,token:'fake-discord-bot-token',dmPolicy:'allowlist',allowFrom:[USER],...discord}}};
  const config=normalizeConfig(raw,{env:{}}),store=new Store(':memory:'),sent=[];config.discordAccounts[0].botId=BOT;
  const client={botInfo:async()=>({id:BOT,username:'assistant'}),channelInfo:async id=>({id,type:1}),typing:async()=>{},send:async(channel,messages,nonce)=>{const result={accepted:true,receiptComplete:true,messageIds:[String(++sequence)],sentMessages:[{id:String(sequence)}]};sent.push({channel,messages,nonce});return result;},interactionCallback:async(id,token,body)=>{sent.push({interaction:id,body});},editInteractionResponse:async()=>{},download:async(a,path)=>{writeFileSync(path,a.filename || 'content');return {path,contentType:a.content_type || 'image/png',size:(a.filename || 'content').length};}};
  const clients=new Map([['default',client]]),bridge=new DiscordBridge({config,store,clients,logger:()=>{}});bridge.mcp={publish:async()=>{}};
  return {dir,raw,config,store,sent,client,clients,bridge,cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
const wait=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('condition not reached');};
async function processOne(f,m) {f.bridge.ingest(f.config.discordAccounts[0],m);const job=f.store.pending(100,{channel:'discord'}).find(j=>j.id.endsWith(m.id));assert.ok(job);await f.bridge.process(job);f.store.finish(job.id);return job.id;}

test('Discord-only headless config needs no LINE settings, public URL, HTTP listener or API key',async()=>{
  const f=fixture();const app=await startServer(f.config,{store:f.store,discordClients:f.clients,enableDiscordGateway:false,acquireLock:false,logger:()=>{}});try{assert.equal(app.server.listening,false);assert.equal(app.server.address(),null);assert.equal(f.config.accounts.length,0);assert.equal(f.config.publicUrl,'');assert.equal(f.config.backend,'inbox');}finally{await app.close();rmSync(f.dir,{recursive:true,force:true});}
  assert.throws(()=>normalizeConfig({transport:'headless',channels:{line:{enabled:true}}},{env:{}}),/HTTP webhook/);
});
test('headless runtime accepts Gateway callbacks into a durable inbox without starting a public server',async()=>{
  const f=fixture();let callback;
  class FakeGateway {constructor(account,options){callback=options.onMessage;}async start(){}async close(){}status(){return {ready:true};}}
  const app=await startServer(f.config,{store:f.store,discordClients:f.clients,GatewayImpl:FakeGateway,acquireLock:false,logger:()=>{}});try{const m=incoming('cloud request');await callback(m);await wait(()=>app.discordBridge.listInbox().length===1);assert.equal(app.server.listening,false);assert.equal(app.discordBridge.listInbox()[0].text,'cloud request');assert.equal(f.sent.length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,1);}finally{await app.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('Discord pairing is namespaced and group DM or missing channel metadata never receives a challenge',async()=>{
  const f=fixture({discord:{dmPolicy:'pairing',allowFrom:[]}});try{
    await processOne(f,incoming('unknown'));assert.equal(f.sent.length,1);assert.equal(f.bridge.listInbox().length,0);const code=f.store.db.prepare('SELECT * FROM pairings').get();assert.equal(code.account_id,'discord:default');assert.match(f.sent[0].messages[0].content,/pairing approve discord/);
    await processOne(f,incoming('repeat'));assert.equal(f.sent.length,1);
    await processOne(f,incoming('group',{channel:{id:CHANNEL,type:3}}));await processOne(f,incoming('missing',{channel:undefined}));assert.equal(f.sent.length,1);
    f.store.approve(code.code);const id=await processOne(f,incoming('admitted'));assert.equal(f.bridge.readMessage(id).text,'admitted');f.store.revoke('discord:default',USER);assert.throws(()=>f.bridge.readMessage(id),/available/);
  }finally{f.cleanup();}
});
test('Discord pairing notices and stored expiry follow account TTL without repeating pending challenges',async(t)=>{
  const now=1700000000000;t.mock.method(Date,'now',()=>now);
  for(const [ttl,notice] of [[undefined,'発行から1時間'],[90000,'発行から90秒'],[1500,'発行から1500ミリ秒'],[null,'有効期限はありません']]){
    const f=fixture({discord:{dmPolicy:'pairing',allowFrom:[],...(ttl===undefined?{}:{pairingCodeTtlMs:ttl})}});
    try{
      await processOne(f,incoming('pair me'));await processOne(f,incoming('pair me again'));
      assert.equal(f.sent.length,1);const text=f.sent[0].messages[0].content;assert.ok(text.includes(notice));
      if(ttl===null)assert.ok(!text.includes('1時間'));
      const pending=f.store.db.prepare('SELECT account_id,expires FROM pairings').get();assert.equal(pending.account_id,'discord:default');
      assert.equal(pending.expires,ttl===null?null:now+(ttl ?? 3600000));
    }finally{f.cleanup();}
  }
});
test('guild messages require allowed channel/sender and an explicit bot mention or reply',async()=>{
  const f=fixture({discord:{allowFrom:[],guilds:{[GUILD]:{users:[USER],channels:{[CHANNEL]:{allow:true}}}}}});try{
    const base={guild_id:GUILD,channel:{id:CHANNEL,type:0}};
    await processOne(f,incoming('not addressed',base));assert.equal(f.bridge.listInbox().length,0);
    const id=await processOne(f,incoming(`<@${BOT}> do work`,base));assert.equal(f.bridge.readMessage(id).text,'do work');
    await processOne(f,incoming(`<@${BOT}> denied`,{...base,author:{id:'555555555555555555'}}));assert.equal(f.bridge.listInbox().length,1);
    assert.equal(f.bridge.listConversations()[0].type,'discord-guild');
  }finally{f.cleanup();}
});
test('LINE and Discord workers cannot steal or expose each other\'s queued events',async()=>{
  const f=fixture({withLine:true,transport:'http'}),line=new Bridge({config:f.config,store:f.store,clients:new Map([['default',{reply:async()=>({}),push:async()=>({})}]]),logger:()=>{}});try{
    const m=incoming();f.bridge.ingest(f.config.discordAccounts[0],m);
    const e={type:'message',webhookEventId:randomUUID(),timestamp:Date.now(),source:{type:'user',userId:'U1'},message:{id:randomUUID(),type:'text',text:'line'}};line.ingest(f.config.accounts[0],e);
    assert.equal(f.store.pending(100,{channel:'line'}).length,1);assert.equal(f.store.pending(100,{channel:'discord'}).length,1);
    line.start();f.bridge.start();await wait(()=>f.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='done'").get().n===2);
    assert.equal(line.listInbox().length,1);assert.equal(f.bridge.listInbox().length,1);assert.ok(!line.listConversations().some(c=>c.accountId==='discord:default'));assert.throws(()=>f.bridge.readMessage(`default:message:${e.message.id}`),/available/);
  }finally{await line.close();await f.bridge.close();f.cleanup();}
});
test('Discord replies split losslessly, commit receipts, conflict on changed keys and keep one stable nonce',async()=>{
  const f=fixture();try{
    const id=await processOne(f,incoming());const text='🌟'.repeat(1500),parts=splitDiscordText(text);assert.equal(parts.join(''),text);assert.equal(parts.length,2);
    await f.bridge.sendReply({messageId:id,text,idempotencyKey:'reply'});assert.equal(f.sent.length,2);assert.notEqual(f.sent[0].nonce,f.sent[1].nonce);
    assert.equal((await f.bridge.sendReply({messageId:id,text,idempotencyKey:'reply'})).duplicate,true);assert.equal(f.sent.length,2);await assert.rejects(f.bridge.sendReply({messageId:id,text:'changed',idempotencyKey:'reply'}),/conflict/);
  }finally{f.cleanup();}
});
test('recent Discord nonce retries preserve payload and stale uncertain delivery is held for review',async()=>{
  const f=fixture();try{
    const id=await processOne(f,incoming());let calls=0,nonce;
    f.client.send=async(channel,messages,n)=>{assert.equal(n,nonce || n);nonce=n;if(!calls++)throw Object.assign(new Error('timeout'),{code:'NETWORK_ERROR',uncertain:true,retryable:true});return {accepted:true,receiptComplete:true,sentMessages:[{id:'result'}]};};
    await assert.rejects(f.bridge.sendReply({messageId:id,text:'answer',idempotencyKey:'k'}));await f.bridge.sendReply({messageId:id,text:'answer',idempotencyKey:'k'});assert.equal(calls,2);
    f.client.send=async()=>{throw Object.assign(new Error('timeout'),{uncertain:true,retryable:true});};await assert.rejects(f.bridge.sendReply({messageId:id,text:'another',idempotencyKey:'k2'}));f.store.db.prepare("UPDATE outbound SET updated=0 WHERE status='discord_sending'").run();await assert.rejects(f.bridge.sendReply({messageId:id,text:'another',idempotencyKey:'k2'}),/window_expired/);
  }finally{f.cleanup();}
});
test('native button approvals remain bound to the original sender and interaction tokens never enter jobs',async()=>{
  const f=fixture({backend:'codex'});const answers=[];f.bridge.backend={answer:(id,body)=>{answers.push([id,body]);return true;}};try{
    const m=incoming();await f.bridge.request(f.config.discordAccounts[0],m,'session',{requestId:'approval',method:'item/commandExecution/requestApproval',params:{command:'safe'}});const code=[...f.bridge.requests.keys()][0];assert.ok(f.sent[0].messages[0].components);
    await f.bridge.answer(f.config.discordAccounts[0],incoming('',{author:{id:'555555555555555555'}}),`bridge:${code}:accept`);assert.equal(answers.length,0);await f.bridge.answer(f.config.discordAccounts[0],m,`bridge:${code}:accept`);assert.equal(answers.length,1);
    await f.bridge.interaction(f.config.discordAccounts[0],{id:String(++sequence),type:2,token:'private-interaction-token',channel_id:CHANNEL,user:{id:USER},data:{name:'help'},channel:{id:CHANNEL,type:1}});await wait(()=>f.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='done'").get().n===1);
    assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM jobs').all()).includes('private-interaction-token'));
  }finally{await f.bridge.close();f.cleanup();}
});
test('bot loop protection bounds other-bot input and still ignores the bot itself',()=>{
  const f=fixture();try{const a=f.config.discordAccounts[0];for(let i=0;i<20;i++)assert.equal(f.bridge.ingest(a,incoming('bot',{author:{id:USER,bot:true}})),true);assert.equal(f.bridge.ingest(a,incoming('bot',{author:{id:USER,bot:true}})),false);assert.equal(f.bridge.ingest(a,incoming('self',{author:{id:BOT,bot:true}})),false);}finally{f.cleanup();}
});
test('Discord attachments are available to the same cloud agent without exposing private filesystem paths over MCP',async()=>{
  const f=fixture();try{const id=await processOne(f,incoming('image',{attachments:[{id:'1',filename:'picture.png',content_type:'image/png',url:'https://cdn.discordapp.com/attachments/path'}]}));assert.equal(f.bridge.readMedia(id)[0].type,'image');assert.equal(f.bridge.readMessage(id).mediaPaths,undefined);assert.equal(f.bridge.readMessage(id).policyMessage,undefined);}finally{f.cleanup();}
});
test('standard Discord wizard preserves the selected headless profile and never prints the Bot token',async()=>{
  const f=fixture();try{const configPath=join(f.dir,'config.json'),envPath=join(f.dir,'.env'),output=[];writeFileSync(configPath,JSON.stringify(f.raw));await configureDiscord({configPath,envPath,ask:async(label,opts)=>{assert.equal(opts.secret,true);return 'private-test-bot-token';},write:s=>output.push(s)});const c=JSON.parse(readFileSync(configPath));assert.equal(c.transport,'headless');assert.equal(c.backend,'inbox');assert.equal(c.channels.line.enabled,false);assert.ok(readFileSync(envPath,'utf8').includes('DISCORD_BOT_TOKEN'));assert.ok(!output.join('\n').includes('private-test-bot-token'));}finally{f.cleanup();}
});
test('mentioned stop/approval controls use the separate lane even during an active guild turn',()=>{
  const f=fixture({discord:{guilds:{[GUILD]:{users:[USER]}}}});try{
    const a=f.config.discordAccounts[0],m=incoming(`<@${BOT}> /stop`,{guild_id:GUILD,channel:{id:CHANNEL,type:0}});f.bridge.ingest(a,m);assert.ok(f.store.pending(1,{channel:'discord'})[0].session_key.endsWith(':control'));
    const approval=incoming(`<@${BOT}> /approve example`,{guild_id:GUILD,channel:{id:CHANNEL,type:0}});f.bridge.ingest(a,approval);assert.ok(f.store.db.prepare('SELECT session_key FROM jobs WHERE id=?').get(`discord:default:message:${approval.id}`).session_key.endsWith(':control'));
  }finally{f.cleanup();}
});
test('definitive long rate limits remain safe to retry beyond the uncertain nonce window',async()=>{
  const f=fixture();try{const id=await processOne(f,incoming());let calls=0;f.client.send=async()=>{if(!calls++)throw Object.assign(new Error('rate'),{status:429,retryable:true,uncertain:false,retryAfterMs:300000});return {accepted:true,receiptComplete:true,sentMessages:[{id:'sent'}]};};await assert.rejects(f.bridge.sendReply({messageId:id,text:'answer',idempotencyKey:'rate'}));assert.equal(f.store.db.prepare('SELECT status FROM outbound').get().status,'pending');f.store.db.prepare('UPDATE outbound SET updated=0').run();assert.equal((await f.bridge.sendReply({messageId:id,text:'answer',idempotencyKey:'rate'})).accepted,true);}finally{f.cleanup();}
});
test('interaction acknowledgement is valid for the real adapter, immediate before lookup, and reused after persistence failure',async()=>{
  const f=fixture();let ackCalls=0,release;
  f.client.interactionCallback=(id,token,body)=>new DiscordClient(f.config.discordAccounts[0],{fetchImpl:async()=>{ackCalls++;return new Response(null,{status:204});}}).interactionCallback(id,token,body);
  f.client.channelInfo=async()=>new Promise(resolve=>release=()=>resolve({id:CHANNEL,type:1}));
  const i={id:String(++sequence),type:2,token:'test-interaction-token',channel_id:CHANNEL,user:{id:USER},data:{name:'help'},application_id:BOT};
  const original=f.bridge.ingest.bind(f.bridge);let failures=1;f.bridge.ingest=(...args)=>{if(failures--)throw new Error('persist-failed');return original(...args);};
  try{
    const first=f.bridge.interaction(f.config.discordAccounts[0],i);await wait(()=>ackCalls===1 && !!release);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);release();await assert.rejects(first,/persist-failed/);
    const second=f.bridge.interaction(f.config.discordAccounts[0],{...i,channel:{id:CHANNEL,type:1}});await second;assert.equal(ackCalls,1);await wait(()=>f.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='done'").get().n===1);assert.ok(!JSON.stringify(f.store.db.prepare('SELECT event FROM jobs').all()).includes('test-interaction-token'));
  }finally{await f.bridge.close();f.cleanup();}
});
test('a busy guild does not hide an earlier authorized sender from message lookup',async()=>{
  const f=fixture({discord:{guilds:{[GUILD]:{requireMention:false}}}});try{
    const base={guild_id:GUILD,channel:{id:CHANNEL,type:0}},id=await processOne(f,incoming('first',base));
    for(let n=0;n<110;n++)await processOne(f,incoming('later',{...base,author:{id:'555555555555555555'}}));
    assert.equal(f.bridge.readMessage(id).text,'first');
  }finally{f.cleanup();}
});
