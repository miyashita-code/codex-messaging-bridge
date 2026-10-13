import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { Bridge } from './bridge.mjs';
import { CodexBackend } from './codex.mjs';
import { DotMcp } from './mcp.mjs';
import { OAuth } from './oauth.mjs';
import { verifySignature } from './line.mjs';
import { DiscordBridge } from './discord-bridge.mjs';
import { DiscordGateway } from './discord.mjs';
import { MultiMcp } from './multi-mcp.mjs';

export function readBody(req,limit=65536) {
  return new Promise((resolve,reject)=>{
    const chunks=[];let bytes=0;
    const cleanup=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',error);req.off('aborted',aborted);};
    const fail=e=>{cleanup();req.resume();reject(e);};
    const data=chunk=>{bytes+=chunk.length;if(bytes>limit){fail(Object.assign(new Error('payload_too_large'),{status:413}));return;}chunks.push(chunk);};
    const end=()=>{cleanup();resolve(Buffer.concat(chunks));},error=e=>{cleanup();reject(e);},aborted=()=>fail(Object.assign(new Error('body_aborted'),{status:400}));
    const timer=setTimeout(()=>fail(Object.assign(new Error('body_timeout'),{status:408})),5000);
    req.on('data',data);req.once('end',end);req.once('error',error);req.once('aborted',aborted);
  });
}
function json(res,status,data,headers={}) {res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...headers});res.end(JSON.stringify(data));}
function lock(dir) {
  mkdirSync(dir,{recursive:true,mode:0o700});const path=join(dir,'bridge.pid');
  try {writeFileSync(path,String(process.pid),{flag:'wx',mode:0o600});} catch(e) {
    if(e.code!=='EEXIST')throw e;
    const pid=Number(readFileSync(path,'utf8'));let stale=false;
    if(!Number.isSafeInteger(pid) || pid<=0) throw new Error('Invalid bridge.pid; inspect it before restarting');
    try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')stale=true;else throw e;}
    if(!stale)throw new Error('A bridge already uses this data directory');
    unlinkSync(path);writeFileSync(path,String(process.pid),{flag:'wx',mode:0o600});
  }
  return ()=>{try{if(readFileSync(path,'utf8')===String(process.pid))unlinkSync(path);}catch{}};
}
export async function startServer(config,{store,backend,clients,discordClients,webhookFetch,logger,acquireLock=true,enableDiscordGateway=true,GatewayImpl=DiscordGateway}={}) {
  const log=logger || ((event,data={})=>console.log(JSON.stringify({time:new Date().toISOString(),event,...data})));
  const unlock=acquireLock?lock(config.dataDir):()=>{};
  store ??= new Store(join(config.dataDir,'bridge.sqlite'));
  mkdirSync(config.codex.cwd,{recursive:true,mode:0o700});
  backend ??= config.backend==='codex'?new CodexBackend(config.codex,{logger:log}):undefined;
  const bridge=new Bridge({config,store,backend,clients,logger:log});
  const discordBridge=new DiscordBridge({config,store,backend,clients:discordClients,logger:log});
  const lineMcp=config.accounts.length?new DotMcp({config,store,bridge,logger:log,webhookFetch}):undefined;
  const discordMcp=config.discordAccounts?.length?new DotMcp({channel:'discord',config,store,bridge:discordBridge,logger:log,webhookFetch}):undefined;
  bridge.mcp=lineMcp;discordBridge.mcp=discordMcp;
  const mcp=new MultiMcp({line:lineMcp,discord:discordMcp});
  const oauth=new OAuth(store,config);oauth.onRevoke=()=>mcp.revokeSubscriptions?.('owner');
  const gateways=[];
  const counters=new Map();
  const server=createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');
    try {
      const url=new URL(req.url,'http://bridge.local');
      if(req.method==='GET' && url.pathname==='/healthz') {json(res,200,{ok:true,backend:config.backend,discord:gateways.map(g=>g.status())});return;}
      const account=config.accounts.find(a=>a.webhookPath===url.pathname);
      if(account) {
        if(req.method==='GET'){res.writeHead(200,{'content-type':'text/plain'});res.end('OK');return;}
        if(req.method==='HEAD'){res.writeHead(204);res.end();return;}
        if(req.method!=='POST'){json(res,405,{error:'method_not_allowed'});return;}
        if(!account.channelSecret || !account.channelAccessToken){json(res,503,{error:'line_not_configured'});return;}
        const body=await readBody(req,65536);
        if(!req.headers['x-line-signature']){json(res,400,{error:'missing_signature'});return;}
        if(!verifySignature(body,req.headers['x-line-signature'],account.channelSecret)){json(res,401,{error:'invalid_signature'});return;}
        let payload;try{payload=JSON.parse(body.toString('utf8'));}catch{json(res,400,{error:'invalid_json'});return;}
        if(!Array.isArray(payload.events) || payload.events.length>100){json(res,400,{error:'invalid_events'});return;}
        // An atomic durable write is the acknowledgment boundary. No model or LINE API call blocks it.
        let accepted=0;store.transaction(()=>{for(const event of payload.events){if(!event || typeof event.type!=='string')throw Object.assign(new Error('invalid_event'),{status:400});if(bridge.ingest(account,event))accepted++;}});
        json(res,200,{ok:true},accepted?{'x-bridge-delivery-accepted':'durable'}:{});bridge.tick();return;
      }
      // Rate-limit auth/RPC endpoints. Only use the actual socket peer, never a client-supplied forwarded header.
      const peer=req.socket.remoteAddress || 'unknown',now=Date.now();
      let bucket=counters.get(peer);if(!bucket || bucket.reset<now)bucket={count:0,reset:now+60000};bucket.count++;counters.set(peer,bucket);
      for(const [k,v] of counters)if(v.reset<now)counters.delete(k);
      if(bucket.count>240){json(res,429,{error:'rate_limited'},{'retry-after':'60'});return;}
      if(await oauth.handle(req,res,url,readBody)) return;
      if(url.pathname==='/mcp') {
        const auth=oauth.authenticate(req);
        if(!auth){json(res,401,{error:'unauthorized'},{'www-authenticate':`Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`});return;}
        if(req.method==='GET'){json(res,405,{error:'stream_not_required'});return;}
        if(req.method!=='POST'){json(res,405,{error:'method_not_allowed'});return;}
        let body;try{body=JSON.parse((await readBody(req,262144)).toString());}catch(e){if(e.status)throw e;json(res,400,{error:'invalid_json'});return;}
        const method=typeof body?.method==='string'?body.method:'';
        const tool=typeof body?.params?.name==='string'?body.params.name:'',provider=tool.startsWith('discord_')?'discord':'line';
        const scope=method.startsWith('events/')?'events:subscribe':method==='tools/call' && tool===`${provider}_reply`?`${provider}:write`:method==='tools/call'?`${provider}:read`:undefined;
        if(scope && !auth.scopes.includes(scope)){json(res,403,{error:'insufficient_scope'},{'www-authenticate':`Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`});return;}
        const reply=await mcp.dispatch(body,auth.principal);
        if(reply===undefined){res.writeHead(202);res.end();return;}
        json(res,200,reply);return;
      }
      json(res,404,{error:'not_found'});
    } catch(e) {if(!res.headersSent){if([408,413].includes(e.status)){res.setHeader('connection','close');res.once('finish',()=>req.destroy());}json(res,e.status || 500,{error:e.status===413?'payload_too_large':e.status===408?'body_timeout':e.status===400?'invalid_event':'request_failed'});}else res.end();log('request_failed',{code:e.status || 'internal'});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  try {
    if(config.transport!=='headless')await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve);});
    store.recoverProcessing();
    if(config.accounts.length)bridge.start({recover:false});
    if(config.discordAccounts?.length)discordBridge.start();
    if(config.backend==='dot')mcp.start();
    if(enableDiscordGateway)for(const a of config.discordAccounts || []) {
      const client=discordBridge.clients.get(a.accountId),bot=await client.botInfo();a.botId=bot.id;
      const gateway=new GatewayImpl(a,{onMessage:async message=>{
        if(!message.channel)message.channel=await client.channelInfo(message.channel_id);
        message.bot_id=message.bot_id || message.botUserId || bot.id;
        discordBridge.ingest(a,message);discordBridge.tick();
      },onInteractionReceived:i=>discordBridge.deferInteraction(a,i),onInteraction:i=>discordBridge.interaction(a,i),logger:{warn:message=>log('discord_gateway_warning',{accountId:a.accountId,message})}});
      gateways.push(gateway);await gateway.start();
    }
  }catch(e){for(const g of gateways)await g.close();if(server.listening)await new Promise(resolve=>server.close(resolve));await Promise.allSettled([bridge.close(),discordBridge.close()]);await mcp.close();await backend?.close();store.close();unlock();throw e;}
  const close=async()=>{for(const g of gateways)await g.close();if(server.listening)await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});await Promise.allSettled([bridge.close(),discordBridge.close()]);await mcp.close();store.close();unlock();};
  log(config.transport==='headless'?'gateway_headless':'listening',{host:config.transport==='headless'?undefined:config.host,port:server.address()?.port,backend:config.backend});
  return {server,bridge,discordBridge,mcp,lineMcp,discordMcp,oauth,store,gateways,close};
}
