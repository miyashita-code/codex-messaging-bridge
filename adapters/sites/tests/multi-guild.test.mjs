import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker,{callTool,events} from '../worker/index.js';
import {discordGuildActivation} from '../worker/discord-guilds.js';
const G1='100000000000000001',G2='100000000000000002',G3='100000000000000003',C1='200000000000000001',C2='200000000000000002',C3='200000000000000003',T2='200000000000000012',T3='200000000000000013',BOT='300000000000000001',AUTHOR='300000000000000002',DM='400000000000000001',M1='500000000000000001',M2='500000000000000002',MDM='500000000000000003';
function setup(t){
 const raw=new DatabaseSync(':memory:');t.after(()=>raw.close());for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'));
 const DB={prepare(sql){return{bind(...values){return{async first(){return raw.prepare(sql).get(...values)||null;},async run(){return{meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};},async all(){return{results:raw.prepare(sql).all(...values)};}};}};}};
 const profile={guild_id:G2,label:'Additional fixture',allowed_channel_ids:[C2],poll_channel_ids:[C2],since:new Date(Date.now()-60000).toISOString()},channels=new Map([[C1,{id:C1,guild_id:G1,type:0,name:'primary'}],[C2,{id:C2,guild_id:G2,type:0,name:'additional'}],[C3,{id:C3,guild_id:G3,type:0}],[T2,{id:T2,guild_id:G2,parent_id:C2,type:11}],[T3,{id:T3,guild_id:G3,parent_id:C2,type:11}],[DM,{id:DM,type:1,recipients:[{id:AUTHOR}]}]]);
 const messages=new Map([[M1,{id:M1,channel_id:C1,author:{id:AUTHOR},content:'primary input',mentions:[{id:BOT}],timestamp:new Date().toISOString()}],[M2,{id:M2,channel_id:C2,author:{id:AUTHOR},content:'additional input',mentions:[{id:BOT}],timestamp:new Date().toISOString()}],[MDM,{id:MDM,channel_id:DM,author:{id:AUTHOR},content:'private owner input',mentions:[],timestamp:new Date().toISOString()}]]),sent=[],callbacks=[],reads=[];
 const env={DB,BRIDGE_RUNTIME:'cloud',BRIDGE_OWNER_SITE_ID:'owner',COMPANION_SHARED_KEY:Buffer.alloc(32,7).toString('base64'),DISCORD_GUILD_ID:G1,DISCORD_BOT_ID:BOT,DISCORD_BOT_TOKEN:'synthetic-token',DISCORD_OWNER_USER_ID:AUTHOR,DISCORD_ALLOWED_CHANNEL_IDS:C1,DISCORD_POLL_CHANNEL_IDS:C1+','+DM,DISCORD_CLOUD_SINCE:new Date(Date.now()-60000).toISOString(),DISCORD_ENABLE_EVENTS:'true',DISCORD_ENABLE_REPLIES:'true',DISCORD_ENABLE_THREADS:'true',DISCORD_ENABLE_HELP_DMS:'true',CLOUD_AGENT_ENABLED:'true',CLOUD_AGENT_AFTER:new Date(Date.now()-60000).toISOString(),DISCORD_GUILDS_JSON:JSON.stringify([profile])};
 env.FETCH=async(url,options={})=>{
  const path=new URL(url).pathname.replace('/api/v10','');reads.push(path);
  if(/^\/guilds\/\d+\/channels$/.test(path)){const guild=path.split('/')[2];return Response.json([...channels.values()].filter(ch=>ch.guild_id===guild&&ch.type===0));}
  if(path.endsWith('/threads/active'))return Response.json({threads:[]});
  const meta=/^\/channels\/(\d+)$/.exec(path);if(meta)return Response.json(channels.get(meta[1])||{}, {status:channels.has(meta[1])?200:404});
  const route=/^\/channels\/(\d+)\/messages(?:\/(\d+))?$/.exec(path);
  if(route&&options.method==='POST'){sent.push({channel:route[1],body:JSON.parse(options.body)});return Response.json({id:'600000000000000001',channel_id:route[1]});}
  if(route&&route[2]){const m=messages.get(route[2]);return Response.json(m||{}, {status:m?200:404});}
  if(route)return Response.json([...messages.values()].filter(m=>m.channel_id===route[1]));
  if(path.includes('/threads/archived/'))return Response.json({threads:[channels.get(T2),channels.get(T3)]});
  throw Error('Unexpected synthetic route');
 };
 env.CALLBACK_FETCH=async(_url,options)=>{const data=JSON.parse(options.body);if(data.type==='verification')return Response.json({challenge:data.challenge});callbacks.push(data);return Response.json({});};
 const req=new Request('https://site.example/mcp',{headers:{'oai-authenticated-user-id':'owner'}});
 const tool=(name,args={})=>callTool(name,args,req,env);
 const subscribe=(guild=G2,channel=C2,name='discord.message.created')=>events.subscribed('events/subscribe',{name,arguments:{guild_id:guild,channel_ids:[channel]},delivery:{mode:'webhook',url:'https://chatgpt.com/mcp-events/fixture-'+guild,secret:'whsec_'+Buffer.alloc(32,1).toString('base64')}},req,env);
 const input=(guild=G2,channel=C2,message=M2)=>({guild_id:guild,channel_id:channel,message_id:message});
 return {raw,env,profile,channels,messages,sent,callbacks,reads,req,tool,subscribe,input};
}

test('explicit additional guild reads, inbox records, catalog selection and URLs use the actual source guild',async t=>{
 const s=setup(t),source=await s.tool('discord_message_read',{channel_id:C2,message_id:M2});assert.equal(source.guild_id,G2);assert.ok(source.url.includes('/'+G2+'/'+C2+'/'));
 const inbox=await s.tool('discord_events_read',{channel_id:C2});assert.equal(inbox.messages[0].guild_id,G2);assert.equal(s.raw.prepare('SELECT guild_id FROM inbox WHERE message_id=?').get(M2).guild_id,G2);
 await s.tool('discord_event_ack',{channel_id:C2,message_id:M2});assert.equal(s.raw.prepare('SELECT status FROM inbox WHERE message_id=?').get(M2).status,'handled');
 assert.equal((await s.tool('discord_channels_list')).guild_id,G1);assert.equal((await s.tool('discord_channels_list',{guild_id:G2})).channels[0].guild_id,G2);assert.equal((await s.tool('discord_guilds_list')).guilds.length,2);
 await assert.rejects(s.tool('discord_message_read',{channel_id:C3,message_id:M2}),e=>e.code==='GUILD_NOT_ALLOWED');
});

test('ordinary members can receive one fixed mention reply in an additional guild without private DM access',async t=>{
 const s=setup(t);s.messages.get(M2).author.id='300000000000000003';const result=await s.tool('discord_reply_to_mention',{channel_id:C2,message_id:M2,content:'hello team'});assert.equal(result.status,'completed');assert.ok(result.url.includes('/'+G2+'/'+C2+'/'));assert.equal(s.sent[0].channel,C2);assert.equal(s.sent[0].body.message_reference.message_id,M2);
 await s.tool('discord_reply_to_mention',{channel_id:C2,message_id:M2,content:'hello team'});assert.equal(s.sent.length,1);
 await assert.rejects(s.tool('discord_offer_help_dm',{channel_id:C2,message_id:M2,content:'private outreach'}),e=>e.code==='DM_GUILD_NOT_ALLOWED');
 s.messages.get(M2).mentions=[];await assert.rejects(s.tool('discord_reply_to_mention',{channel_id:C2,message_id:M2,content:'no mention'}),e=>e.code==='EXPLICIT_MENTION_REQUIRED');
});

test('profile removal, same-request withdrawal and source mismatch never send or return content',async t=>{
 const s=setup(t),fetch=s.env.FETCH;s.env.FETCH=async(url,options)=>{const response=await fetch(url,options);if(new URL(url).pathname.endsWith('/messages/'+M2))s.env.DISCORD_GUILDS_JSON='[]';return response;};
 await assert.rejects(s.tool('discord_reply_to_mention',{channel_id:C2,message_id:M2,content:'blocked'}),e=>e.code==='GUILD_NOT_ALLOWED');assert.equal(s.sent.length,0);
 s.env.FETCH=fetch;s.env.DISCORD_GUILDS_JSON=JSON.stringify([s.profile]);s.messages.get(M2).channel_id=C1;await assert.rejects(s.tool('discord_message_read',{channel_id:C2,message_id:M2}),e=>e.code==='SOURCE_MISMATCH');
});

test('profile withdrawal after action reservation is checked immediately before the POST',async t=>{
 const s=setup(t),prepare=s.env.DB.prepare.bind(s.env.DB);s.env.DB.prepare=sql=>({bind(...values){const statement=prepare(sql).bind(...values);return {...statement,async run(){const value=await statement.run();if(sql.startsWith('INSERT OR IGNORE INTO actions'))s.env.DISCORD_GUILDS_JSON='[]';return value;}};}});
 await assert.rejects(s.tool('discord_reply_to_mention',{channel_id:C2,message_id:M2,content:'blocked'}),e=>e.code==='GUILD_NOT_ALLOWED');assert.equal(s.sent.length,0);
});

test('thread listing and work-thread replies cannot substitute a guild through a parent ID',async t=>{
 const s=setup(t),list=await s.tool('discord_threads_list',{channel_id:C2});assert.deepEqual(list.threads.map(ch=>ch.id),[T2]);
 s.raw.prepare("INSERT INTO actions(action_key,kind,source_id,status,result_id,created_at) VALUES (?,?,?,'completed',?,?)").run('thread:'+M2,'thread',M2,T3,Date.now());
 await assert.rejects(s.tool('discord_reply_in_work_thread',{channel_id:C2,message_id:M2,content:'blocked',request_key:'fixture-key'}),e=>e.code==='GUILD_NOT_ALLOWED');assert.equal(s.sent.length,0);
});

test('subscriptions and queued callback delivery bind both the requested guild and current actual source',async t=>{
 const s=setup(t);await s.subscribe();await events.enqueue(s.env,s.input());assert.equal((await events.drain(s.env)).delivered,1);assert.equal(s.callbacks[0].data.guild_id,G2);
 await assert.rejects(s.subscribe(G2,C1),e=>e.code==='GUILD_NOT_ALLOWED');await assert.rejects(s.subscribe(G3,C3),e=>e.message==='GUILD_NOT_ALLOWED');await assert.rejects(s.subscribe(G2,C2,'discord.dm.message.created'),e=>e.message==='GUILD_NOT_ALLOWED');
 await assert.rejects(events.enqueue(s.env,s.input(G1,C2,M2)),e=>e.code==='GUILD_NOT_ALLOWED');
});

test('queued additional callbacks are cancelled after removal and cannot cross subscription guilds',async t=>{
 const s=setup(t);await s.subscribe();await events.enqueue(s.env,s.input());s.env.DISCORD_GUILDS_JSON='[]';assert.equal((await events.drain(s.env)).delivered,0);assert.equal(s.callbacks.length,0);
 assert.equal(s.raw.prepare('SELECT status FROM event_outbox').get().status,'cancelled');
});

test('a queued event cannot be redirected into another configured guild subscription',async t=>{
 const s=setup(t),primary=await s.subscribe(G1,C1);await s.subscribe();await events.enqueue(s.env,s.input());
 s.raw.prepare('UPDATE event_outbox SET subscription_id=?').run(primary.id);
 assert.equal((await events.drain(s.env)).delivered,0);assert.equal(s.callbacks.length,0);assert.equal(s.raw.prepare('SELECT status FROM event_outbox').get().status,'cancelled');
});

test('malformed profiles fail before Discord network reads and disabled profiles do not yield queued claims',async t=>{
 const s=setup(t);s.env.DISCORD_GUILDS_JSON='{';await assert.rejects(s.tool('discord_message_read',{channel_id:C2,message_id:M2}),e=>e.code==='DISCORD_GUILDS_INVALID');assert.equal(s.reads.length,0);
 s.env.DISCORD_GUILDS_JSON=JSON.stringify([s.profile]);await events.enqueue(s.env,s.input());s.env.DISCORD_GUILDS_JSON=JSON.stringify([{...s.profile,enabled:false}]);s.reads.length=0;
 assert.equal((await s.tool('bridge_wait_for_message',{wait_ms:0})).status,'empty');assert.equal(s.reads.some(path=>path.endsWith('/messages/'+M2)),false);
});

test('new guild claims preserve primary configuration and reject old claims after a since advance or rollback',async t=>{
 const s=setup(t);await events.enqueue(s.env,s.input());
 const claim=await s.tool('bridge_wait_for_message',{wait_ms:0});assert.equal(claim.status,'message');assert.equal(claim.conversation_key,'discord_guild:'+G2+':'+C2);assert.equal(s.env.DISCORD_GUILD_ID,G1);
 s.env.DISCORD_GUILDS_JSON=JSON.stringify([{...s.profile,since:new Date(Date.now()+60000).toISOString()}]);
 assert.equal((await s.tool('bridge_reply_to_claim',{lease_id:claim.lease_id,claim_id:claim.claim_id,content:'too old'})).status,'source_unavailable');
 s.env.DISCORD_GUILDS_JSON=JSON.stringify([s.profile]);assert.equal((await s.tool('bridge_wait_for_message',{wait_ms:0,lease_id:claim.lease_id})).status,'empty');assert.equal(s.sent.length,0);
});

test('existing primary owner DM grants and conversation keys survive adding a guild',async t=>{
 const s=setup(t),at=Date.now()-60000;s.raw.prepare("INSERT INTO dm_contacts(channel_id,user_id,guild_id,owner_site_id,source_channel_id,source_message_id,delivery_status,authorized_at,updated_at) VALUES (?,?,?,?,?,?,'sent',?,?)").run(DM,AUTHOR,G1,'owner',C1,M1,at,at);
 await events.enqueue(s.env,{...s.input(G1,DM,MDM),scope:'dm'});const claim=await s.tool('bridge_wait_for_message',{wait_ms:0});assert.equal(claim.status,'message');assert.equal(claim.conversation_key,'discord_dm:'+DM);
 assert.equal((await s.tool('bridge_reply_to_claim',{lease_id:claim.lease_id,claim_id:claim.claim_id,content:'private answer'})).status,'completed');assert.equal(s.sent[0].channel,DM);assert.equal(s.raw.prepare('SELECT guild_id FROM dm_contacts WHERE channel_id=?').get(DM).guild_id,G1);
});

test('primary guild claims retain the legacy conversation key with additional profiles configured',async t=>{
 const s=setup(t);await events.enqueue(s.env,s.input(G1,C1,M1));const claim=await s.tool('bridge_wait_for_message',{wait_ms:0});assert.equal(claim.status,'message');assert.equal(claim.conversation_key,'discord_guild:'+C1);
});

test('reviewed added channels admit legitimate queued mentions and a forward fence cannot be rolled back',async t=>{
 const s=setup(t);await discordGuildActivation(s.env,G2);
 const at=Date.now()-30000,start=new Date(at-1000).toISOString();s.channels.set(C3,{id:C3,guild_id:G2,type:0});s.messages.get(M2).channel_id=C3;s.messages.get(M2).timestamp=new Date(at).toISOString();
 const updated={...s.profile,allowed_channel_ids:[C2,C3],poll_channel_ids:[C2,C3],channel_since:{[C3]:start}};s.env.DISCORD_GUILDS_JSON=JSON.stringify([updated]);await events.enqueue(s.env,s.input(G2,C3,M2));
 const claim=await s.tool('bridge_wait_for_message',{wait_ms:0});assert.equal(claim.status,'message');assert.equal(claim.conversation_key,'discord_guild:'+G2+':'+C3);
 s.env.DISCORD_GUILDS_JSON=JSON.stringify([{...updated,channel_since:{[C3]:new Date(at+1000).toISOString()}}]);assert.equal((await s.tool('bridge_reply_to_claim',{lease_id:claim.lease_id,claim_id:claim.claim_id,content:'blocked historical reply'})).status,'source_unavailable');
 s.env.DISCORD_GUILDS_JSON=JSON.stringify([updated]);assert.equal((await s.tool('bridge_wait_for_message',{wait_ms:0,lease_id:claim.lease_id})).status,'empty');assert.equal(s.sent.length,0);
});

test('queued callbacks honor reviewed channel fences and public thread parent activation',async t=>{
 const s=setup(t);await discordGuildActivation(s.env,G2);
 const at=Date.now()-30000,updated={...s.profile,channel_since:{[C2]:new Date(at-1000).toISOString()}};s.env.DISCORD_GUILDS_JSON=JSON.stringify([updated]);s.messages.get(M2).channel_id=T2;s.messages.get(M2).timestamp=new Date(at).toISOString();
 await s.subscribe(G2,T2);await events.enqueue(s.env,s.input(G2,T2,M2));s.env.DISCORD_GUILDS_JSON=JSON.stringify([{...updated,channel_since:{[C2]:new Date(at+1000).toISOString()}}]);assert.equal((await events.drain(s.env)).delivered,0);assert.equal(s.callbacks.length,0);
});

test('additional guild parent permissions include public threads but never implicitly expose private threads',async t=>{
 const s=setup(t);s.messages.get(M2).channel_id=T2;assert.equal((await s.tool('discord_message_read',{channel_id:T2,message_id:M2})).guild_id,G2);
 s.channels.get(T2).type=12;await assert.rejects(s.tool('discord_message_read',{channel_id:T2,message_id:M2}),e=>e.code==='CHANNEL_NOT_ALLOWED');
 s.env.DISCORD_GUILDS_JSON=JSON.stringify([{...s.profile,allowed_channel_ids:[C2,T2],poll_channel_ids:[C2]}]);assert.equal((await s.tool('discord_message_read',{channel_id:T2,message_id:M2})).id,M2);
 s.channels.get(T2).guild_id=G1;s.env.DISCORD_GUILDS_JSON='[]';s.env.DISCORD_ALLOWED_CHANNEL_IDS=C2;assert.equal((await s.tool('discord_message_read',{channel_id:T2,message_id:M2})).guild_id,G1);
});

test('bot-generated notes are readable with bounded attachment and embed text but never grant write authority',async t=>{
 const s=setup(t),m=s.messages.get(M2),file={id:'700000000000000001',filename:'notes.md',content_type:'application/octet-stream',size:108000,url:'https://cdn.discordapp.com/attachments/private'};m.author={id:'300000000000000010',bot:true,username:'Notes Bot'};m.webhook_id='800000000000000001';m.attachments=[file];m.embeds=Array.from({length:8},()=>({title:'x'.repeat(500),description:'y'.repeat(3000),url:'https://example.invalid/private',fields:Array.from({length:12},()=>({name:'n'.repeat(200),value:'v'.repeat(1500)}))}));
 const result=await s.tool('discord_message_read',{channel_id:C2,message_id:M2});assert.equal(result.is_bot,true);assert.deepEqual(result.attachments,[{id:file.id,filename:file.filename,content_type:file.content_type,size:file.size}]);assert.ok(result.embeds.length<=5);
 assert.equal(JSON.stringify(result).includes('cdn.discordapp.com'),false);assert.equal(JSON.stringify(result).includes('example.invalid'),false);assert.ok(result.embeds.reduce((sum,embed)=>sum+(embed.title?.length||0)+(embed.description?.length||0)+(embed.fields||[]).reduce((n,f)=>n+f.name.length+f.value.length,0),0)<=8000);
 await assert.rejects(s.tool('discord_reply_to_mention',{channel_id:C2,message_id:M2,content:'reply loop'}),e=>e.code==='BOT_LOOP_BLOCKED');assert.equal(s.sent.length,0);
});

test('attachment tool wiring uses owner authentication, authorized bot sources and Unicode paging without exposing a URL',async t=>{
 const s=setup(t),m=s.messages.get(M2),file='700000000000000001',body='議事録😀\n決定事項',url='https://cdn.discordapp.com/attachments/'+C2+'/'+file+'/notes.md';m.author.bot=true;m.attachments=[{id:file,filename:'notes.md',content_type:'application/octet-stream',size:Buffer.byteLength(body),url}];let downloads=0;
 s.env.ATTACHMENT_FETCH=async()=>{downloads++;return new Response(body);};
 const args={channel_id:C2,message_id:M2,attachment_id:file,offset:3,limit:2};
 await assert.rejects(callTool('discord_text_attachment_read',args,new Request('https://site.example/mcp',{headers:{'oai-authenticated-user-id':'other'}}),s.env),e=>e.code==='OWNER_ONLY');assert.equal(downloads,0);
 const result=await s.tool('discord_text_attachment_read',args);assert.equal(result.content,'😀\n');assert.equal(result.returned_characters,2);assert.equal(result.next_offset,5);assert.equal(result.coverage,'partial');assert.equal(downloads,1);assert.equal(JSON.stringify(result).includes('https:'),false);
 const response=await worker.fetch(new Request('https://site.example/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':'owner'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'discord_text_attachment_read',arguments:{...args,url:'https://example.invalid/forbidden'}}})}),s.env);
 const payload=await response.json();assert.equal(payload.result.isError,true);assert.equal(JSON.parse(payload.result.content[0].text).error,'UNKNOWN_ARGUMENT');assert.equal(downloads,1);
});

test('attachment source policy withdrawal after download produces only a fixed error',async t=>{
 const s=setup(t),file='700000000000000001',m=s.messages.get(M2),body='private notes never returned';m.author.bot=true;m.attachments=[{id:file,filename:'notes.txt',size:Buffer.byteLength(body),url:'https://cdn.discordapp.com/attachments/'+C2+'/'+file+'/notes.txt'}];
 s.env.ATTACHMENT_FETCH=async()=>{s.env.DISCORD_GUILDS_JSON='[]';return new Response(body);};
 const response=await worker.fetch(new Request('https://site.example/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':'owner'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'discord_text_attachment_read',arguments:{channel_id:C2,message_id:M2,attachment_id:file}}})}),s.env);
 const payload=await response.json();assert.equal(payload.result.isError,true);assert.deepEqual(JSON.parse(payload.result.content[0].text),{error:'DISCORD_ATTACHMENT_SOURCE_NOT_ALLOWED'});assert.equal(JSON.stringify(payload).includes(body),false);
});
