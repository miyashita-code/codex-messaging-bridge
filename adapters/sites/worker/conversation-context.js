// Only confirmed cloud-agent exchanges enter this encrypted, bounded memory.
// The HTTP adapter must reauthorize the current source before each operation.
import {eventCryptoForTest as codec} from './events.js';
const PREFIX='cloud_context:v1:';
const MAX_MESSAGES=12;
const MAX_CHARS=24000;
const RETENTION_MS=30*24*3600e3;
const REPLIES=new Set(['line_reply','discord_reply_dm','discord_reply_to_mention']);
const first=(env,key)=>env.DB.prepare('SELECT value,updated_at FROM bridge_runtime WHERE key=?').bind(key).first();
const run=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).run();
export class ConversationContextError extends Error{constructor(){super('CLOUD_CONTEXT_UNAVAILABLE');}}
const fail=()=>{throw new ConversationContextError();};
async function digest(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');}
function validMessage(message){
 if(!message||typeof message!=='object'||!REPLIES.has(message.reply_kind)||typeof message.source_key!=='string'||!message.source_key||message.source_key.length>256||typeof message.source_id!=='string'||!message.source_id||message.source_id.length>128||typeof message.conversation_key!=='string'||!message.conversation_key||message.conversation_key.length>256||typeof message.content!=='string'||message.content.length>10000||typeof message.timestamp!=='string'||!Number.isFinite(Date.parse(message.timestamp)))fail();
}
async function location(env,owner,message){
 if(!owner||owner!==env.BRIDGE_OWNER_SITE_ID||env.BRIDGE_RUNTIME!=='cloud'||!env.DB?.prepare)fail();
 validMessage(message);
 const line=message.reply_kind==='line_reply';
 const bot=line?env.LINE_BOT_ID:env.DISCORD_BOT_ID;
 const guild=line?'':env.DISCORD_GUILD_ID;
 if(typeof bot!=='string'||!bot||typeof guild!=='string'||!line&&!guild)fail();
 const scope=JSON.stringify([owner,message.reply_kind,bot,guild,message.conversation_key]);
 const prefix=PREFIX+await digest(owner)+':';
 return {key:prefix+await digest(scope),prefix,scope};
}
function validTurn(turn){
 return !!turn&&typeof turn==='object'&&typeof turn.source_key==='string'&&turn.source_key.length<=256&&typeof turn.source_id==='string'&&turn.source_id.length<=128&&typeof turn.input==='string'&&turn.input.length<=10000&&typeof turn.reply==='string'&&turn.reply.length>0&&turn.reply.length<=5000&&Number.isSafeInteger(turn.at)&&turn.at>=0&&Number.isSafeInteger(turn.confirmed_at)&&turn.confirmed_at>=0;
}
async function load(env,where){
 const row=await first(env,where.key);if(!row)return {row:null,turns:[],truncated:false};
 let value;try{value=await codec.unseal(env,row.value,where.key);}catch{fail();}
 if(value?.version!==1||value.scope!==where.scope||!Array.isArray(value.turns)||value.turns.length>MAX_MESSAGES/2||value.turns.some(turn=>!validTurn(turn))||value.turns.reduce((n,turn)=>n+turn.input.length+turn.reply.length,0)>MAX_CHARS)fail();
 const cutoff=Date.now()-RETENTION_MS,turns=value.turns.filter(turn=>turn.confirmed_at>=cutoff);
 return {row,turns,truncated:value.truncated===true||turns.length!==value.turns.length};
}
function bounded(turns,limit=MAX_MESSAGES,maxChars=MAX_CHARS){
 const kept=[];let chars=0;
 for(let index=turns.length-1;index>=0;index--){
  const turn=turns[index],size=turn.input.length+turn.reply.length;
  if(kept.length*2+2>limit||chars+size>maxChars)break;
  kept.unshift(turn);chars+=size;
 }
 return {turns:kept,truncated:kept.length<turns.length};
}
export async function readConversationContext(env,owner,message,{limit=MAX_MESSAGES,max_chars=MAX_CHARS}={}){
 if(!Number.isInteger(limit)||limit<0||!Number.isInteger(max_chars)||max_chars<0)fail();
 const where=await location(env,owner,message),stored=await load(env,where);
 const eligible=stored.turns.filter(turn=>turn.source_key!==message.source_key&&turn.at<=Date.parse(message.timestamp));
 const result=bounded(eligible,Math.min(limit,MAX_MESSAGES),Math.min(max_chars,MAX_CHARS));
 return {messages:result.turns.flatMap(turn=>[{role:'user',content:turn.input,timestamp:new Date(turn.at).toISOString()},{role:'assistant',content:turn.reply,timestamp:new Date(turn.confirmed_at).toISOString()}]),truncated:stored.truncated||result.truncated};
}
export async function recordConversationReply(env,owner,message,{content,status}={}){
 if(status!=='completed'||typeof content!=='string'||!content.trim()||content.length>5000)fail();
 const where=await location(env,owner,message);
 for(let attempt=0;attempt<8;attempt++){
  const stored=await load(env,where),existing=stored.turns.find(turn=>turn.source_key===message.source_key);
  if(existing){if(existing.input!==message.content||existing.reply!==content||existing.source_id!==message.source_id)fail();return;}
  const now=Date.now(),turn={source_key:message.source_key,source_id:message.source_id,input:message.content,reply:content,at:Date.parse(message.timestamp),confirmed_at:now};
  const ordered=[...stored.turns,turn].sort((a,b)=>a.at-b.at||a.source_key.localeCompare(b.source_key)),next=bounded(ordered);
  const sealed=await codec.seal(env,{version:1,scope:where.scope,turns:next.turns,truncated:stored.truncated||next.truncated},where.key);
  const saved=stored.row?await run(env,'UPDATE bridge_runtime SET value=?,updated_at=? WHERE key=? AND value=?',sealed,now,where.key,stored.row.value):await run(env,'INSERT OR IGNORE INTO bridge_runtime (key,value,updated_at) VALUES (?,?,?)',where.key,sealed,now);
  if(!saved.meta?.changes)continue;
  // Expired context ciphertext is pruned only in this authenticated owner's
  // namespace; there is no background job and no change to reply/send records.
  await run(env,'DELETE FROM bridge_runtime WHERE key GLOB ? AND updated_at<?',where.prefix+'*',now-RETENTION_MS);
  return;
 }
 fail();
}
