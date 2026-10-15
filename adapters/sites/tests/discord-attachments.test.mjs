import test from 'node:test';
import assert from 'node:assert/strict';
import {discordAttachmentTools,readDiscordAttachment,DiscordAttachmentError} from '../worker/discord-attachments.js';

// Synthetic identifiers and credentials; no external request is made.
const G='111111111111111111',C='222222222222222222',A='333333333333333333',M='444444444444444444',B='555555555555555555';
const MAX=256*1024;
const args={channel_id:C,message_id:M,attachment_id:A};
function setup({text='A😀あB\r\n',filename='meeting.md',bytes}={}){
 const body=bytes||new TextEncoder().encode(text),state={calls:[],fetches:[],body,source:{ch:{id:C,guild_id:G,type:11,parent_id:'666666666666666666'},m:{id:M,channel_id:C,author:{id:B,bot:true},attachments:[{id:A,filename,size:body.byteLength,content_type:'application/octet-stream',url:`https://cdn.discordapp.com/attachments/${C}/${A}/${encodeURIComponent(filename)}?ex=123&is=456&hm=synthetic-signed-value`}]}}};
 const env={DISCORD_BOT_TOKEN:'synthetic-bot-secret'};
 const readSource=async(_env,selected)=>{assert.equal(_env,env);state.calls.push({...selected});return structuredClone(state.source);};
 const fetchAttachment=async(url,options)=>{state.fetches.push({url,options});return new Response(state.body,{headers:{'content-length':String(state.body.byteLength)}});};
 const read=(extra={},deps={})=>readDiscordAttachment(env,{...args,...extra},{readSource,fetchAttachment,...deps});
 return {state,env,read,readSource,fetchAttachment};
}
const code=value=>error=>error instanceof DiscordAttachmentError&&error.code==='DISCORD_ATTACHMENT_'+value;

test('tool schema is read-only and accepts only source IDs and bounded character pagination',()=>{
 const tool=discordAttachmentTools[0];assert.equal(tool.name,'discord_text_attachment_read');
 assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.annotations.destructiveHint,false);
 assert.deepEqual(tool.inputSchema.required,['channel_id','message_id','attachment_id']);assert.equal(tool.inputSchema.additionalProperties,false);
 assert.equal(tool.inputSchema.properties.limit.maximum,24000);assert.equal('url' in tool.inputSchema.properties,false);
});
test('authorized Bot attachment returns complete UTF-8 text without URL, query signatures or credentials',async()=>{
 const s=setup(),result=await s.read();
 assert.equal(result.content,'A😀あB\r\n');assert.equal(result.total_characters,6);assert.equal(result.total_bytes,s.state.body.byteLength);
 assert.equal(result.coverage,'complete');assert.equal(result.end_of_file,true);assert.equal(result.next_offset,null);assert.equal(result.trust,'untrusted_discord_attachment');
 assert.equal(result.content_type,'text/markdown');assert.deepEqual(s.state.calls,[{channel_id:C,message_id:M},{channel_id:C,message_id:M}]);
 assert.equal(s.state.fetches.length,1);const options=s.state.fetches[0].options;
 assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');assert.equal('headers' in options,false);
 const serialized=JSON.stringify(result);for(const secret of [s.env.DISCORD_BOT_TOKEN,'synthetic-signed-value','https://','Authorization'])assert.equal(serialized.includes(secret),false);
});
test('offsets and limits count Unicode characters and never split an emoji surrogate pair',async()=>{
 const s=setup(),result=await s.read({offset:1,limit:2});
 assert.equal(result.content,'😀あ');assert.equal(result.returned_characters,2);assert.equal(result.next_offset,3);assert.equal(result.coverage,'partial');assert.equal(result.end_of_file,false);
 const tail=await s.read({offset:3,limit:10});assert.equal(tail.content,'B\r\n');assert.equal(tail.next_offset,null);assert.equal(tail.end_of_file,true);assert.equal(tail.coverage,'partial');
});
test('a realistic transcript pages within 24k characters and supports resuming at EOF',async()=>{
 const text='x'.repeat(108707),s=setup({text,filename:'transcript.txt'});
 const first=await s.read({limit:24000});assert.equal(first.total_bytes,108707);assert.equal(first.returned_characters,24000);assert.equal(first.next_offset,24000);assert.equal(first.coverage,'partial');
 const second=await s.read({offset:first.next_offset,limit:24000});assert.equal(second.offset,24000);assert.equal(second.next_offset,48000);
 const last=await s.read({offset:108000,limit:24000});assert.equal(last.returned_characters,707);assert.equal(last.end_of_file,true);assert.equal(last.coverage,'partial');
 const end=await s.read({offset:108707});assert.equal(end.content,'');assert.equal(end.next_offset,null);assert.equal(end.coverage,'partial');
 await assert.rejects(s.read({offset:108708}),code('INVALID_OFFSET'));
});
test('invalid IDs, arbitrary URL arguments and invalid pagination fail before any source or CDN read',async()=>{
 const cases=[{channel_id:123},{message_id:'../message'},{attachment_id:'https://evil.test/file.txt'},{url:'https://evil.test'},{offset:-1},{offset:1.5},{offset:MAX+1},{limit:0},{limit:24001},{limit:'20'}];
 for(const extra of cases){const s=setup();await assert.rejects(s.read(extra),code('INVALID_ARGUMENTS'));assert.equal(s.state.calls.length,0);assert.equal(s.state.fetches.length,0);}
});
test('the attachment must belong to the actual authorized message, channel and public guild source',async()=>{
 for(const mutate of [s=>s.source.ch.id='777777777777777777',s=>delete s.source.ch.guild_id,s=>s.source.ch.type=1,s=>s.source.ch.type=12,s=>s.source.m.id='777777777777777777',s=>s.source.m.channel_id='777777777777777777']){
  const s=setup();mutate(s.state);await assert.rejects(s.read(),code('SOURCE_NOT_ALLOWED'));assert.equal(s.state.fetches.length,0);
 }
 const s=setup();s.state.source.m.attachments[0].id='777777777777777777';await assert.rejects(s.read(),code('NOT_FOUND'));assert.equal(s.state.fetches.length,0);
});
test('only the selected actual attachment is fetched when a message contains several files',async()=>{
 const s=setup();s.state.source.m.attachments.unshift({id:'777777777777777777',filename:'other.txt',size:1,url:'https://evil.test/do-not-fetch'});
 assert.equal((await s.read()).filename,'meeting.md');assert.equal(s.state.fetches.length,1);assert.ok(s.state.fetches[0].url.includes('/'+A+'/'));
});
test('only the exact HTTPS Discord CDN attachment path is accepted',async()=>{
 const path=`/attachments/${C}/${A}/meeting.md`;
 const urls=[`http://cdn.discordapp.com${path}`,`https://cdn.discordapp.com.evil.test${path}`,`https://user:password@cdn.discordapp.com${path}`,`https://cdn.discordapp.com:444${path}`,`https://cdn.discordapp.com${path}#fragment`,`https://media.discordapp.net${path}`,`https://cdn.discordapp.com/attachments/777777777777777777/${A}/meeting.md`,`https://cdn.discordapp.com/attachments/${C}/777777777777777777/meeting.md`,`https://cdn.discordapp.com/attachments/${C}/${A}/other.md`,`https://cdn.discordapp.com/attachments/${C}/${A}/meeting%2F.md`];
 for(const url of urls){const s=setup();s.state.source.m.attachments[0].url=url;await assert.rejects(s.read(),code('URL_NOT_ALLOWED'));assert.equal(s.state.fetches.length,0);}
});
test('text extensions are bounded independently of an unreliable MIME label',async()=>{
 for(const filename of ['note.TXT','meeting.md','table.csv','data.json']){const s=setup({filename,text:'synthetic text'});assert.equal((await s.read()).content,'synthetic text');}
 for(const filename of ['file.pdf','script.js','file.txt.exe','no-extension','../file.txt']){const s=setup();s.state.source.m.attachments[0].filename=filename;await assert.rejects(s.read(),code('UNSUPPORTED_TYPE'));assert.equal(s.state.fetches.length,0);}
});
test('oversize or invalid declared attachment sizes are rejected before fetching',async()=>{
 for(const size of [MAX+1,-1,1.5,'5',null]){const s=setup();s.state.source.m.attachments[0].size=size;await assert.rejects(s.read(),error=>error instanceof DiscordAttachmentError);assert.equal(s.state.fetches.length,0);}
 const s=setup();s.state.source.m.attachments[0].size=MAX;await assert.rejects(s.read(),code('SIZE_MISMATCH'));
});
test('empty files and the exact 256 KiB maximum remain readable',async()=>{
 const empty=setup({text:''});const result=await empty.read();assert.equal(result.content,'');assert.equal(result.total_bytes,0);assert.equal(result.coverage,'complete');
 const maximum=setup({text:'x'.repeat(MAX)});const page=await maximum.read({limit:24000});assert.equal(page.total_bytes,MAX);assert.equal(page.returned_characters,24000);
});
test('oversize Content-Length is rejected without reading the response body',async()=>{
 const s=setup();let reads=0;
 await assert.rejects(s.read({},{fetchAttachment:async()=>({ok:true,status:200,headers:new Headers({'content-length':String(MAX+1)}),body:{getReader(){reads++;throw Error('must not read');},cancel(){}}})}),code('TOO_LARGE'));
 assert.equal(reads,0);
});
test('stream byte limits hold without Content-Length and cancel the oversized stream',async()=>{
 const s=setup();s.state.source.m.attachments[0].size=MAX;let cancelled=false;
 const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(100000));},cancel(){cancelled=true;}});
 await assert.rejects(s.read({},{fetchAttachment:async()=>new Response(stream)}),code('TOO_LARGE'));assert.equal(cancelled,true);
});
test('invalid UTF-8 bytes are rejected instead of silently replacing or truncating them',async()=>{
 const s=setup({bytes:new Uint8Array([0xc3,0x28]),filename:'transcript.txt'});await assert.rejects(s.read(),code('INVALID_UTF8'));
});
test('redirects and HTTP failures never follow or read an untrusted response body',async()=>{
 const s=setup();let reads=0;
 const body={getReader(){reads++;throw Error('synthetic-private-response');},cancel(){}};
 await assert.rejects(s.read({},{fetchAttachment:async()=>({ok:false,status:302,headers:new Headers({location:'https://evil.test'}),body})}),code('REDIRECT_DENIED'));
 await assert.rejects(s.read({},{fetchAttachment:async()=>({ok:false,status:403,headers:new Headers(),body})}),code('HTTP_403'));
 await assert.rejects(s.read({},{fetchAttachment:async()=>{throw Error('synthetic-bot-secret https://private.test');}}),error=>code('FETCH_FAILED')(error)&&!error.message.includes('synthetic-bot-secret'));
 assert.equal(reads,0);
});
test('a stalled attachment fetch is aborted within the single bounded deadline',async()=>{
 const s=setup();let signal;
 await assert.rejects(s.read({},{timeoutMs:15,fetchAttachment:async(_url,options)=>{signal=options.signal;return new Promise(()=>{});}}),code('TIMEOUT'));
 assert.equal(signal.aborted,true);assert.equal(s.state.calls.length,1);
});
test('a stalled body read is cancelled by the same deadline',async()=>{
 const s=setup();let cancelled=false,signal;
 const stream=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});
 await assert.rejects(s.read({},{timeoutMs:15,fetchAttachment:async(_url,options)=>{signal=options.signal;return new Response(stream);}}),code('TIMEOUT'));
 assert.equal(cancelled,true);assert.equal(signal.aborted,true);
});
test('current permission is rechecked after downloading and no slice survives revocation',async()=>{
 const s=setup();let reads=0;
 await assert.rejects(s.read({},{readSource:async(_env,selected)=>{reads++;if(reads===2)throw {status:403,code:'GUILD_NOT_ALLOWED',message:'synthetic-bot-secret'};return s.readSource(_env,selected);}}),code('SOURCE_NOT_ALLOWED'));
 assert.equal(reads,2);assert.equal(s.state.fetches.length,1);
});
test('attachment removal or actual guild change during fetch cannot return stale content',async()=>{
 for(const mutate of [s=>s.source.m.attachments=[],s=>s.source.ch.guild_id='777777777777777777',s=>s.source.m.attachments[0].size+=1]){
  const s=setup();await assert.rejects(s.read({},{fetchAttachment:async(url,options)=>{mutate(s.state);return s.fetchAttachment(url,options);}}),error=>error instanceof DiscordAttachmentError);assert.equal(s.state.calls.length,2);
 }
});
test('refreshing only the actual signed query leaves the same attachment identity intact',async()=>{
 const s=setup(),result=await s.read({},{fetchAttachment:async(url,options)=>{s.state.source.m.attachments[0].url=s.state.source.m.attachments[0].url.replace('synthetic-signed-value','refreshed-signature');return s.fetchAttachment(url,options);}});
 assert.equal(result.content,'A😀あB\r\n');assert.equal(JSON.stringify(result).includes('signature'),false);
});

test('the global host fetch fallback retains its receiver instead of invoking an unbound native function',async t=>{
 const s=setup();let calls=0;t.mock.method(globalThis,'fetch',function(_url,options){assert.equal(this,globalThis);assert.equal('headers' in options,false);calls++;return Promise.resolve(new Response(s.state.body));});
 const result=await readDiscordAttachment(s.env,args,{readSource:s.readSource});assert.equal(result.content,'A😀あB\r\n');assert.equal(calls,1);assert.equal(s.state.calls.length,2);
});

test('environment fetch methods retain their receiver and attachment-specific methods take precedence',async()=>{
 for(const property of ['FETCH','ATTACHMENT_FETCH']){
  const s=setup();let calls=0;s.env[property]=function(_url,options){assert.equal(this,s.env);assert.equal('headers' in options,false);calls++;return Promise.resolve(new Response(s.state.body));};
  if(property==='ATTACHMENT_FETCH')s.env.FETCH=()=>{throw Error('must not select lower-precedence fetch');};
  const result=await readDiscordAttachment(s.env,args,{readSource:s.readSource});assert.equal(result.total_bytes,s.state.body.byteLength);assert.equal(calls,1);
 }
 const s=setup();s.env.ATTACHMENT_FETCH=()=>{throw Error('explicit injected dependency has precedence');};assert.equal((await s.read()).content,'A😀あB\r\n');
});

test('fixed transport codes separate receiver, policy and network failures without exposing host error details',async()=>{
 const secret='synthetic-secret https://cdn.discordapp.com/private?hm=never-return';
 const cases=[
  [new TypeError('Illegal invocation '+secret),'FETCH_BINDING_ERROR'],
  [Object.assign(new Error(secret),{code:'ERR_INVALID_THIS'}),'FETCH_BINDING_ERROR'],
  [new DOMException(secret,'SecurityError'),'FETCH_POLICY_DENIED'],
  [Object.assign(new Error(secret),{code:'ERR_NETWORK_ACCESS_DENIED'}),'FETCH_POLICY_DENIED'],
  [new DOMException(secret,'AbortError'),'FETCH_ABORTED'],
  [new TypeError(secret),'FETCH_TYPE_ERROR'],[new Error(secret),'FETCH_FAILED'],
 ];
 for(const [error,expected] of cases){const s=setup();await assert.rejects(s.read({},{fetchAttachment:async()=>{throw error;}}),failure=>code(expected)(failure)&&failure.message==='DISCORD_ATTACHMENT_'+expected&&!failure.message.includes(secret));assert.equal(s.state.calls.length,1);}
});

test('HTTP diagnostics expose only the bounded status code and never inspect denied response bodies',async()=>{
 for(const status of [401,403,404,429,500,503]){
  const s=setup();let reads=0;await assert.rejects(s.read({},{fetchAttachment:async()=>({ok:false,status,headers:new Headers(),body:{getReader(){reads++;throw Error('private denied body');},cancel(){}}})}),code('HTTP_'+status));assert.equal(reads,0);
 }
 const s=setup();await assert.rejects(s.read({},{fetchAttachment:async()=>({ok:false,status:0,headers:new Headers()})}),code('RESPONSE_INVALID'));
});

test('a body transport failure and an unavailable configured fetch remain distinct from CDN HTTP rejection',async()=>{
 const s=setup();await assert.rejects(s.read({},{fetchAttachment:async()=>({ok:true,status:200,headers:new Headers(),body:{getReader(){return{read:async()=>{throw Error('private stream https://signed.test');},cancel(){}};}}})}),code('BODY_READ_FAILED'));
 const invalid=setup();invalid.env.ATTACHMENT_FETCH='not-a-function';await assert.rejects(readDiscordAttachment(invalid.env,args,{readSource:invalid.readSource}),code('FETCH_UNAVAILABLE'));assert.equal(invalid.state.calls.length,1);
});
