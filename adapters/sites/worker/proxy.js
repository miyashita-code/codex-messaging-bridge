// Private Sites front door. State and credentials live only in the durable companion.
const encoder=new TextEncoder();
function secret(env){let key;try{key=Uint8Array.from(atob(env.COMPANION_SHARED_KEY||''),c=>c.charCodeAt(0));}catch{throw Error('PROXY_NOT_CONFIGURED');}if(key.length!==32)throw Error('PROXY_NOT_CONFIGURED');return key;}
function destination(env){let url;try{url=new URL(env.COMPANION_ORIGIN);}catch{throw Error('PROXY_NOT_CONFIGURED');}if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.port&&url.port!=='443')throw Error('INVALID_COMPANION_ORIGIN');return new URL('/mcp-backend',url);}
export function proxyConfigured(env){try{return !!(env.BRIDGE_OWNER_SITE_ID&&env.DISCORD_GUILD_ID&&secret(env)&&destination(env));}catch{return false;}}
async function bounded(response){const reader=response.body?.getReader();if(!reader)return '';const chunks=[];let total=0;for(;;){const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>8*1024*1024+8192){await reader.cancel();throw Error('PROXY_RESPONSE_TOO_LARGE');}chunks.push(part.value);}const raw=new Uint8Array(total);let offset=0;for(const c of chunks){raw.set(c,offset);offset+=c.length;}return new TextDecoder().decode(raw);}
export async function proxyMcp(env,principal,rpc){
 if(principal!==env.BRIDGE_OWNER_SITE_ID)throw Error('OWNER_ONLY');
 const target=destination(env),key=secret(env);const body=JSON.stringify({principal,guild_id:env.DISCORD_GUILD_ID,rpc});
 const id=crypto.randomUUID(),timestamp=String(Math.floor(Date.now()/1000));
 const cryptoKey=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',cryptoKey,encoder.encode(`${id}.${timestamp}.${body}`)))));
 let response;try{response=await (env.PROXY_FETCH||fetch)(target,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json','X-Bridge-Id':id,'X-Bridge-Timestamp':timestamp,'X-Bridge-Signature':`v1,${signature}`},body});}catch{throw Error('PROXY_OUTCOME_UNCONFIRMED');}
 // Workerd rejects redirect:'error'. Never follow a signed POST, and do not
 // claim its requested mutation failed or completed without a backend result.
 if(response.redirected||response.status>=300&&response.status<400)throw Error('PROXY_OUTCOME_UNCONFIRMED');
 if(!response.ok)throw Error('PROXY_BACKEND_UNAVAILABLE');
 let reply;try{reply=JSON.parse(await bounded(response));}catch{throw Error('PROXY_INVALID_RESPONSE');}
 if(!Number.isInteger(reply.status)||reply.status<200||reply.status>599||typeof reply.body!=='string')throw Error('PROXY_INVALID_RESPONSE');
 // Preserve the backend's exact MCP response and status. Never synthesize success on timeouts.
 return new Response(reply.body,{status:reply.status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
}
