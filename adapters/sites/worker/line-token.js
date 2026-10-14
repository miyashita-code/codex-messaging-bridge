import {eventCryptoForTest as codec} from './events.js';
const first=(env,key)=>env.DB.prepare('SELECT value FROM bridge_runtime WHERE key=?').bind(key).first();
const save=(env,key,value)=>env.DB.prepare('INSERT INTO bridge_runtime (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,value,Date.now()).run();
async function tokenRecord(env){const row=await first(env,'line_token');return row?codec.unseal(env,row.value,'line_token'):null;}
export async function currentLineToken(env){return (await tokenRecord(env))?.token||env.LINE_CHANNEL_ACCESS_TOKEN;}
async function request(env,path,options={}){
 let r;try{r=await (env.LINE_TOKEN_FETCH||fetch)('https://api.line.me'+path,{...options,redirect:'manual',signal:AbortSignal.timeout(12000)});}catch{throw Error('LINE_TOKEN_OUTCOME_UNKNOWN');}
 if(r.redirected||r.status>=300&&r.status<400||r.status>=500)throw Error('LINE_TOKEN_OUTCOME_UNKNOWN');
 if(!r.ok)throw Error('LINE_TOKEN_HTTP_'+r.status);
 try{return await r.json();}catch{throw Error('LINE_TOKEN_INVALID_RESPONSE');}
}
export async function renewCloudLineToken(env){
 if(!env.LINE_CHANNEL_ID||!env.LINE_TOKEN_EXPIRES_AT)return {configured:false};
 const active=await tokenRecord(env),expiresAt=active?.expiresAt||Date.parse(env.LINE_TOKEN_EXPIRES_AT);
 if(!Number.isFinite(expiresAt))throw Error('LINE_TOKEN_EXPIRY_REQUIRED');
 if(expiresAt>Date.now()+48*3600000)return {configured:true,renewed:false,expires_at:new Date(expiresAt).toISOString()};
 let journal=await first(env,'line_token_renewal');
 if(journal?.value==='issuing'||journal?.value==='unknown')return {configured:true,requires_review:true,reason:'TOKEN_ISSUANCE_OUTCOME_UNKNOWN'};
 let pending=journal?await codec.unseal(env,journal.value,'line_token_pending'):null;
 if(!pending){
  await save(env,'line_token_renewal','issuing');
  try{
   const issued=await request(env,'/v2/oauth/accessToken',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:env.LINE_CHANNEL_ID,client_secret:env.LINE_CHANNEL_SECRET})});
   if(typeof issued.access_token!=='string'||issued.access_token.length<20||!Number.isInteger(issued.expires_in)||issued.expires_in<=0||issued.expires_in>2678400)throw Error('LINE_TOKEN_INVALID_RESPONSE');
   pending={token:issued.access_token,expiresAt:Date.now()+issued.expires_in*1000};
   await save(env,'line_token_renewal',await codec.seal(env,pending,'line_token_pending'));
  }catch{await save(env,'line_token_renewal','unknown');return {configured:true,requires_review:true,reason:'TOKEN_ISSUANCE_OUTCOME_UNKNOWN'};}
 }
 const verification=await request(env,'/v2/oauth/verify',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({access_token:pending.token})});
 if(String(verification.client_id)!==env.LINE_CHANNEL_ID||verification.expires_in<=0)throw Error('LINE_TOKEN_IDENTITY_MISMATCH');
 const bot=await request(env,'/v2/bot/info',{headers:{authorization:'Bearer '+pending.token}});
 if(bot.userId!==env.LINE_BOT_ID)throw Error('LINE_TOKEN_BOT_MISMATCH');
 await save(env,'line_token',await codec.seal(env,pending,'line_token'));
 await env.DB.prepare("DELETE FROM bridge_runtime WHERE key='line_token_renewal'").bind().run();
 return {configured:true,renewed:true,expires_at:new Date(pending.expiresAt).toISOString()};
}
