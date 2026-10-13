import { DatabaseSync } from 'node:sqlite';
export async function checkCloudRuntime({probe=false,fetchImpl=fetch,WebSocketImpl=globalThis.WebSocket}={}) {
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE runtime_probe(value INTEGER)');db.close();
  const result={node:process.version,sqlite:true,webSocket:typeof WebSocketImpl==='function',runtimeOnly:true,cloudUptimeVerified:false};
  if(!probe)return result;
  try {
    const response=await fetchImpl('https://discord.com/api/v10/gateway',{signal:AbortSignal.timeout(10000),redirect:'error'}),body=await response.json();
    if(!response.ok || !/^wss:\/\/gateway\.discord\.gg\/?$/.test(body.url || ''))throw new Error('Gateway discovery failed');
    result.discordHttps=true;
    result.discordWss=await new Promise(resolve=>{
      const socket=new WebSocketImpl(`${body.url.replace(/\/$/,'')}/?v=10&encoding=json`),timer=setTimeout(()=>done(false),10000);let ended=false;
      const done=ok=>{if(ended)return;ended=true;clearTimeout(timer);try{socket.close();}catch{}resolve(ok);};
      socket.addEventListener('message',event=>{try{const payload=JSON.parse(event.data);if(payload.op===10)done(true);}catch{done(false);}});
      socket.addEventListener('error',()=>done(false));socket.addEventListener('close',()=>done(false));
    });
  }catch{result.discordHttps=false;result.discordWss=false;}
  return result;
}
