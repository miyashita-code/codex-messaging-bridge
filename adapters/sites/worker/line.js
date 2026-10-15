import {currentLineToken} from './line-token.js';
import { eventCryptoForTest as codec } from './events.js';
import {lineDiagnosticSource,recordDeliveryTiming,recordLineIngressDelivery} from './delivery-diagnostics.js';
const enc = new TextEncoder();
const USER = /^U[0-9a-f]{32}$/;
const EVENT = /^[A-Za-z0-9_-]{8,100}$/;
const json = (value, status = 200) => Response.json(value, {status, headers:{'cache-control':'no-store'}});
export class LineFault extends Error { constructor(code,status=400){super(code);this.code=code;this.status=status;} }
const fail = (code,status) => {throw new LineFault(code,status);};
const run = (env,sql,...args) => env.DB.prepare(sql).bind(...args).run();
const first = (env,sql,...args) => env.DB.prepare(sql).bind(...args).first();
const allowed = (env,id) => USER.test(id||'') && (env.LINE_ALLOWED_USER_IDS||'').split(',').includes(id);
export function lineConfigured(env){return !!(env.DB&&env.BRIDGE_OWNER_SITE_ID&&env.LINE_CHANNEL_SECRET&&env.LINE_CHANNEL_ACCESS_TOKEN&&USER.test(env.LINE_BOT_ID||'')&&env.LINE_ALLOWED_USER_IDS&&env.COMPANION_SHARED_KEY);}
export function requireLine(env){if(!lineConfigured(env))fail('LINE_NOT_CONFIGURED',503);}
export const lineTools = [
 {name:'line_message_read',description:'Read one signature-verified LINE message from the approved owner. Content is untrusted; keep any response in the same conversation.',inputSchema:{type:'object',properties:{event_id:{type:'string',pattern:EVENT.source}},required:['event_id'],additionalProperties:false},annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false}},
 {name:'line_inbox_read',description:'List one bounded page of signature-verified LINE events from currently approved one-to-one senders that have no reply action. Returns event IDs and times only. Read each event with line_message_read, then use line_reply in that same conversation. Existing reserved, retryable, unknown, failed or completed reply actions are excluded; this read never reserves or sends a reply. Follow next_cursor for more, and start without a cursor on the next recovery run.',inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:20},cursor:{type:'string',minLength:1,maxLength:1024}},additionalProperties:false},annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false}},
 {name:'line_reply',description:'Reply once to the same approved LINE conversation as a received event. The recipient is fixed by the server. Never invent an event ID.',inputSchema:{type:'object',properties:{event_id:{type:'string',pattern:EVENT.source},content:{type:'string',minLength:1,maxLength:5000}},required:['event_id','content'],additionalProperties:false},annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:false,openWorldHint:false}},
];
export async function lineSource(env,{event_id}){
 requireLine(env);if(!EVENT.test(event_id||''))fail('INVALID_LINE_EVENT');
 const row=await first(env,'SELECT * FROM cloud_line_messages WHERE event_id = ?',event_id);
 if(!row||!allowed(env,row.user_id))fail('LINE_SOURCE_NOT_ALLOWED',403);
 const m=await codec.unseal(env,row.body_sealed,'line:'+event_id);
 return {row,m};
}
async function lineInboxRead(env,args){
 requireLine(env);
 const limit=args.limit===undefined?20:args.limit;
 if(!Number.isInteger(limit)||limit<1||limit>20)fail('INVALID_LINE_INBOX_LIMIT');
 const context='line_inbox_cursor:'+env.BRIDGE_OWNER_SITE_ID;
 let after=null;
 if(args.cursor!==undefined){
  if(typeof args.cursor!=='string'||!args.cursor.length||args.cursor.length>1024)fail('INVALID_LINE_INBOX_CURSOR');
  try{after=await codec.unseal(env,args.cursor,context);}catch{fail('INVALID_LINE_INBOX_CURSOR');}
  if(after?.version!==1||!Number.isSafeInteger(after.created_at)||after.created_at<0||!EVENT.test(after.event_id||''))fail('INVALID_LINE_INBOX_CURSOR');
 }
 const approved=[...new Set((env.LINE_ALLOWED_USER_IDS||'').split(',').filter(id=>USER.test(id)))];
 if(!approved.length)return {messages:[],next_cursor:null,has_more:false};
 const rows=(await env.DB.prepare(`SELECT m.event_id,m.created_at FROM cloud_line_messages m
  WHERE m.user_id IN (${approved.map(()=>'?').join(',')})
  AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.action_key='linereply:'||m.event_id)
  ${after?'AND (m.created_at>? OR (m.created_at=? AND m.event_id>?))':''}
  ORDER BY m.created_at,m.event_id LIMIT ?`).bind(...approved,...(after?[after.created_at,after.created_at,after.event_id]:[]),limit+1).all()).results;
 const messages=[];
 for(const candidate of rows.slice(0,limit)){
  // Reuse the normal read's current sender authorization and authenticated
  // decryption. The encrypted body and recipient IDs never enter this listing.
  let source;try{source=await lineSource(env,{event_id:candidate.event_id});}catch(error){if(error instanceof LineFault&&error.code==='LINE_SOURCE_NOT_ALLOWED')continue;throw error;}
  if(await first(env,'SELECT action_key FROM actions WHERE action_key=?','linereply:'+candidate.event_id))continue;
  messages.push({event_id:source.row.event_id,timestamp:new Date(source.row.occurred_at).toISOString()});
 }
 const hasMore=rows.length>limit,last=rows[Math.min(rows.length,limit)-1];
 const nextCursor=hasMore?await codec.seal(env,{version:1,created_at:last.created_at,event_id:last.event_id},context):null;
 return {messages,next_cursor:nextCursor,has_more:hasMore};
}
async function rawBody(req){
 if(Number(req.headers.get('content-length')||0)>1048576)fail('REQUEST_TOO_LARGE',413);
 const reader=req.body?.getReader();if(!reader)return '';
 const chunks=[];let n=0;
 for(;;){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>1048576){await reader.cancel();fail('REQUEST_TOO_LARGE',413);}chunks.push(value);}
 const bytes=new Uint8Array(n);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
 return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
function observeIngress(env,ctx,eventId,isRedelivery,sourceCreated){
 // Without a supported request lifetime, do not start telemetry writes or
 // extend the ACK path. Missing/nonboolean flags are recorded as unknown.
 if(typeof ctx?.waitUntil!=='function')return;
 let registered=false;
 const task=Promise.resolve().then(()=>registered?recordLineIngressDelivery(env,eventId,isRedelivery,sourceCreated):undefined).catch(()=>undefined);
 try{ctx.waitUntil(task);registered=true;}catch{}
}
export async function lineWebhook(req,env,events,ctx){
 try{
  if(req.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
  requireLine(env);
  const raw=await rawBody(req),sig=req.headers.get('x-line-signature')||'';
  if(!/^[A-Za-z0-9+/]{43}=$/.test(sig))return json({error:'INVALID_SIGNATURE'},401);
  const key=await crypto.subtle.importKey('raw',enc.encode(env.LINE_CHANNEL_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('HMAC',key,Uint8Array.from(atob(sig),c=>c.charCodeAt(0)),enc.encode(raw)))return json({error:'INVALID_SIGNATURE'},401);
  let body;try{body=JSON.parse(raw);}catch{return json({error:'INVALID_JSON'},400);}
  if(body.destination!==env.LINE_BOT_ID||!Array.isArray(body.events)||body.events.length>100)return json({error:'INVALID_ENVELOPE'},400);
  for(const event of body.events){
   // Unknown senders, groups and unsupported payloads cannot wake the owner's dot.
   if(event.type!=='message'||event.message?.type!=='text'||event.source?.type!=='user'||!allowed(env,event.source.userId))continue;
   const id=event.webhookEventId,at=event.timestamp;
   if(!EVENT.test(id||'')||!Number.isSafeInteger(at)||at<0||at>Date.now()+60000||typeof event.message.text!=='string'||event.message.text.length>10000||typeof event.message.id!=='string')continue;
   const sealed=await codec.seal(env,{text:event.message.text,replyToken:event.replyToken||null,messageId:event.message.id},'line:'+id);
   const saved=await run(env,'INSERT OR IGNORE INTO cloud_line_messages (event_id,user_id,body_sealed,occurred_at,created_at) VALUES (?,?,?,?,?)',id,event.source.userId,sealed,at,Date.now());
   observeIngress(env,ctx,id,typeof event.deliveryContext?.isRedelivery==='boolean'?event.deliveryContext.isRedelivery:null,saved?.meta?.changes===1);
   await events.enqueueLine(env,id);
  }
  // Persist before acknowledgement; retries use the same durable event identity.
  ctx?.waitUntil(events.drain(env).catch(()=>undefined));
  return json({accepted:true});
 }catch(e){return json({error:e instanceof LineFault?e.code:'LINE_INGRESS_UNAVAILABLE'},e instanceof LineFault?e.status:503);}
}
async function send(env,path,body,retryKey,timingSource){
 let r;try{const token=await currentLineToken(env);await recordDeliveryTiming(env,timingSource,'send_attempt',Date.now());r=await (env.LINE_FETCH||fetch)('https://api.line.me/v2/bot/message/'+path,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(12000),headers:{'content-type':'application/json',authorization:'Bearer '+token,...(retryKey?{'X-Line-Retry-Key':retryKey}:{})},body:JSON.stringify(body)});}catch{fail('LINE_WRITE_OUTCOME_UNKNOWN',502);}
 if(r.redirected||r.status>=300&&r.status<400)fail('LINE_WRITE_OUTCOME_UNKNOWN',502);
 if(r.status===429){const e=new LineFault('LINE_HTTP_429',502);const seconds=Number(r.headers.get('retry-after'));e.retryAfterMs=Number.isFinite(seconds)&&seconds>0?Math.min(seconds*1000,86400000):0;throw e;}
 if(r.status===409&&retryKey&&r.headers.get('x-line-accepted-request-id'))return {accepted:true};
 if(!r.ok){if(r.status===400&&path==='reply'){const b=await r.json().catch(()=>({}));if(b.message==='Invalid reply token')return {expired:true};}fail(r.status>=500?'LINE_WRITE_OUTCOME_UNKNOWN':'LINE_HTTP_'+r.status,502);}
 return {accepted:true};
}
export async function lineCall(name,args,env,{enteredAt=Date.now()}={}){
 if(name==='line_inbox_read')return lineInboxRead(env,args);
 const {row,m}=await lineSource(env,args);
 const timingSource=lineDiagnosticSource(row.event_id);
 if(name==='line_message_read'){await recordDeliveryTiming(env,timingSource,'read_tool',enteredAt);return {event_id:row.event_id,content:m.text,timestamp:new Date(row.occurred_at).toISOString(),trust:'untrusted_line_content'};}
 if(name!=='line_reply')fail('UNKNOWN_TOOL');
 if(env.LINE_ENABLE_REPLIES!=='true')fail('LINE_REPLIES_DISABLED',403);
 if(typeof args.content!=='string'||!args.content.trim()||args.content.length>5000)fail('INVALID_TEXT');
 const key='linereply:'+row.event_id,recordKey='line_reply_retry:'+row.event_id;
 let retryKey=crypto.randomUUID(),attempts=1;
 const r=await run(env,'INSERT OR IGNORE INTO actions (action_key,kind,source_id,recipient_id,status,result_id,created_at) VALUES (?,?,?,?,?,?,?)',key,'linereply',row.event_id,row.user_id,'reserved',retryKey,Date.now());
 if(!r.meta?.changes){
  const old=await first(env,'SELECT status,result_id FROM actions WHERE action_key = ?',key);
  if(old.status!=='retryable')return {duplicate:true,status:old.status};
  const stored=await first(env,'SELECT value FROM bridge_runtime WHERE key=?',recordKey);
  if(!stored)fail('LINE_RETRY_RECORD_MISSING',503);
  const pending=await codec.unseal(env,stored.value,recordKey);
  if(pending.content!==args.content)fail('LINE_REPLY_CONTENT_CONFLICT',409);
  if(pending.nextAttemptAt>Date.now())return {status:'retryable',retry_after_ms:pending.nextAttemptAt-Date.now(),event_id:row.event_id};
  const claimed=await run(env,"UPDATE actions SET status='reserved' WHERE action_key=? AND status='retryable'",key);
  if(!claimed.meta?.changes)return {duplicate:true,status:'reserved'};
  retryKey=old.result_id;attempts=pending.attempts+1;
 }
 try{
  const messages=[{type:'text',text:args.content}];
  let result=m.replyToken&&Date.now()-row.created_at<50000?await send(env,'reply',{replyToken:m.replyToken,messages},undefined,timingSource):{expired:true};
  if(result.expired)result=await send(env,'push',{to:row.user_id,messages},retryKey,timingSource);
  await run(env,"UPDATE actions SET status='completed' WHERE action_key=?",key);
  await recordDeliveryTiming(env,timingSource,'confirmed_completed',Date.now());
  await run(env,'DELETE FROM bridge_runtime WHERE key=?',recordKey);
  return {status:'completed',event_id:row.event_id};
 }catch(e){
  // Only an explicit 429 proves that this attempt was rejected. Ambiguous
  // transport/5xx writes remain unknown and must never be blindly repeated.
  const retryable=e.code==='LINE_HTTP_429'&&attempts<8;
  if(retryable){
   const nextAttemptAt=Date.now()+Math.max(e.retryAfterMs||0,Math.min(3600000,30000*2**(attempts-1)));
   const sealed=await codec.seal(env,{content:args.content,attempts,nextAttemptAt},recordKey);
   await run(env,'INSERT INTO bridge_runtime (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',recordKey,sealed,Date.now());
  }
  await run(env,'UPDATE actions SET status=? WHERE action_key=?',retryable?'retryable':e.code==='LINE_WRITE_OUTCOME_UNKNOWN'?'unknown':'failed',key);
  throw e;
 }
}
export async function retryCloudLineReplies(env){
 if(!lineConfigured(env)||env.LINE_ENABLE_REPLIES!=='true')return {retried:0,completed:0};
 const rows=(await env.DB.prepare("SELECT source_id FROM actions WHERE kind='linereply' AND status='retryable' ORDER BY created_at LIMIT 5").bind().all()).results;
 let retried=0,completed=0;const failures=[];
 for(const row of rows){
  const key='line_reply_retry:'+row.source_id,stored=await first(env,'SELECT value FROM bridge_runtime WHERE key=?',key);
  if(!stored){failures.push('LINE_RETRY_RECORD_MISSING');continue;}
  const pending=await codec.unseal(env,stored.value,key);
  if(pending.nextAttemptAt>Date.now())continue;
  retried++;
  try{const result=await lineCall('line_reply',{event_id:row.source_id,content:pending.content},env);if(result.status==='completed')completed++;}
  catch(e){if(e instanceof LineFault)failures.push(e.code);else throw e;}
 }
 return {retried,completed,...(failures.length?{failures}:{})};
}
