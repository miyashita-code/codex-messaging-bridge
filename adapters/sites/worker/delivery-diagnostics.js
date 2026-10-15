// Server-observed tool timings plus the stored platform event timestamp.
// Event occurrence is not message composition or model/task-start time.
// Never store message bodies, credentials, callback URLs or raw errors here.
const PREFIX='delivery_diag:v1:';
const RETENTION_MS=7*86400000;
const LIMIT=10;
const ID=/^[0-9]{17,20}$/;
const LINE_EVENT=/^[A-Za-z0-9_-]{8,100}$/;
const LINE_USER=/^U[0-9a-f]{32}$/;
const ISO_TIMESTAMP=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const PHASES={read_tool:['first_read_tool_at','last_read_tool_at'],send_attempt:['first_send_attempt_at','last_send_attempt_at'],confirmed_completed:['confirmed_completed_at']};
const run=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).run();
const first=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).first();
const instant=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000?value:null;
const iso=value=>instant(value)===null?null:new Date(value).toISOString();
const delta=(end,start)=>instant(end)===null||instant(start)===null?null:end-start;
function platformInstant(value){
 const match=typeof value==='string'&&ISO_TIMESTAMP.exec(value);if(!match)return null;
 const [year,month,day,hour,minute,second]=match.slice(1).map(Number),days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
 if(month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59)return null;
 return instant(Date.parse(value));
}
async function namespace(env){
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.BRIDGE_OWNER_SITE_ID));
 return PREFIX+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')+':';
}
function metadata(input){
 if(input?.channel==='line'&&LINE_EVENT.test(input.source_id||''))return {channel:'line',source_id:input.source_id,event_id:'line_'+input.source_id};
 if(!['discord_guild','discord_dm'].includes(input?.channel)||![input.source_id,input.channel_id,input.guild_id].every(id=>typeof id==='string'&&ID.test(id)))return null;
 return {channel:input.channel,source_id:input.source_id,channel_id:input.channel_id,guild_id:input.guild_id,...(input.channel==='discord_guild'&&ID.test(input.parent_channel_id||'')?{parent_channel_id:input.parent_channel_id}:{}),event_id:`discord_${input.channel==='discord_dm'?'dm_':''}message_${input.source_id}`};
}
export const lineDiagnosticSource=eventId=>({channel:'line',source_id:eventId});
export const discordDiagnosticSource=(env,scope,ch,message)=>({channel:scope==='dm'?'discord_dm':'discord_guild',source_id:message.id,channel_id:message.channel_id,guild_id:env.DISCORD_GUILD_ID,...(ch?.parent_id?{parent_channel_id:ch.parent_id}:{})});
export async function recordLineIngressDelivery(env,eventId,isRedelivery,sourceCreated=false){
 try{
  if(env.BRIDGE_RUNTIME!=='cloud'||!env.DB||!env.BRIDGE_OWNER_SITE_ID)return;
  const source=metadata(lineDiagnosticSource(eventId));if(!source)return;
  const redelivery=typeof isRedelivery==='boolean'?isRedelivery:null,initial=sourceCreated===true;
  const key=await namespace(env)+source.event_id,value={...source,line_first_ingress_is_redelivery:redelivery,line_ingress_source_first:initial};
  // The source INSERT winner identifies the original durable ingress even if
  // its background task finishes after a duplicate. Otherwise retain the first
  // recorded flag, including an explicitly unknown/null flag.
  await run(env,`INSERT INTO bridge_runtime (key,value,updated_at) VALUES (?,?,?)
   ON CONFLICT(key) DO UPDATE SET value=CASE WHEN
    json_type(bridge_runtime.value,'$.line_first_ingress_is_redelivery') IS NULL OR
    (?=1 AND json_extract(bridge_runtime.value,'$.line_ingress_source_first') IS NOT 1)
    THEN json_set(bridge_runtime.value,'$.line_first_ingress_is_redelivery',json(?),'$.line_ingress_source_first',json(?))
    ELSE bridge_runtime.value END,updated_at=MAX(bridge_runtime.updated_at,excluded.updated_at)`,key,JSON.stringify(value),Date.now(),initial?1:0,JSON.stringify(redelivery),JSON.stringify(initial));
 }catch{
  // Ingress metadata is best effort and must never affect ACK or send state.
 }
}
export async function recordDeliveryTiming(env,input,phase,at=Date.now()){
 try{
  if(env.BRIDGE_RUNTIME!=='cloud'||!env.DB||!env.BRIDGE_OWNER_SITE_ID||instant(at)===null)return;
  const source=metadata(input),fields=PHASES[phase];if(!source||!fields)return;
  const key=await namespace(env)+source.event_id;
  const value={...source,...Object.fromEntries(fields.map(field=>[field,at]))};
  // SQL merges preserve first/last observations even when concurrent tool
  // reads finish out of order. Field names come only from PHASES above.
  const changes=fields.map((field,index)=>`'$.${field}',${index===1?'MAX':'MIN'}(COALESCE(json_extract(bridge_runtime.value,'$.${field}'),?),?)`).join(',');
  await run(env,`INSERT INTO bridge_runtime (key,value,updated_at) VALUES (?,?,?)
   ON CONFLICT(key) DO UPDATE SET value=json_set(bridge_runtime.value,${changes}),updated_at=MAX(bridge_runtime.updated_at,excluded.updated_at)`,key,JSON.stringify(value),Date.now(),...fields.flatMap(()=>[at,at]));
 }catch{
  // Telemetry must never turn a successful read/write into a failure, change
  // an action reservation, or cause an uncertain write to be sent again.
 }
}
async function permittedSource(env,source,authorizeChannel){
 if(source.channel==='line'){
  const row=await first(env,'SELECT user_id,occurred_at,created_at FROM cloud_line_messages WHERE event_id=?',source.source_id);
  if(!row||!LINE_USER.test(row.user_id)||!(env.LINE_ALLOWED_USER_IDS||'').split(',').includes(row.user_id))return null;
  return {occurredAt:instant(row.occurred_at),recordedAt:row.created_at,actionKey:'linereply:'+source.source_id};
 }
 if(source.guild_id!==env.DISCORD_GUILD_ID)return null;
 if(source.channel==='discord_dm'){
  const contact=await first(env,'SELECT channel_id FROM dm_contacts WHERE channel_id=? AND guild_id=? AND owner_site_id=?',source.channel_id,source.guild_id,env.BRIDGE_OWNER_SITE_ID);
  if(!contact)return null;
 }else{
  const allowed=(env.DISCORD_ALLOWED_CHANNEL_IDS||'').split(',').map(id=>id.trim()).filter(Boolean);
  if(allowed.length&&!allowed.includes(source.channel_id)){
   // Unread event payloads do not carry a thread's parent. Reuse the normal
   // channel authorization rather than omitting legitimate thread events or
   // trusting a parent retained in an older trace after permissions change.
   if(typeof authorizeChannel!=='function')return null;
   try{const ch=await authorizeChannel(env,source.channel_id);if(ch.id!==source.channel_id||ch.guild_id!==source.guild_id||!allowed.includes(ch.parent_id))return null;}catch{return null;}
  }
 }
 const row=await first(env,'SELECT occurred_at,created_at FROM event_records WHERE id=?',source.event_id);
 const occurredAt=platformInstant(row?.occurred_at);
 return {occurredAt,recordedAt:row?.created_at??null,actionKey:(source.channel==='discord_dm'?'dmreply:':'reply:')+source.source_id};
}
export async function deliveryDiagnostics(env,principal,{channel:authorizeChannel}={}){
 // bridge_status also serves initial setup before an owner is configured.
 // Never expose retained observations through that setup exception.
 if(env.BRIDGE_RUNTIME!=='cloud'||!env.DB||!env.BRIDGE_OWNER_SITE_ID||principal!==env.BRIDGE_OWNER_SITE_ID)return null;
 try{
  const prefix=await namespace(env);
  const cutoff=Date.now()-RETENTION_MS;
  const rows=(await env.DB.prepare('SELECT value,updated_at FROM bridge_runtime WHERE key GLOB ? AND updated_at>=? ORDER BY updated_at DESC,key LIMIT ?').bind(prefix+'*',cutoff,LIMIT).all()).results||[];
  const candidates=new Map();
  for(const row of rows){
   let value;try{value=JSON.parse(row.value);}catch{continue;}
   const source=metadata(value);if(!source)continue;
   candidates.set(source.event_id,{source,value,updatedAt:row.updated_at});
  }
  // Include notifications that never reached a read tool, not just events
  // that already have timing observations. Candidate ownership comes from
  // the subscription; current source authorization is checked below.
  const notifications=(await env.DB.prepare(`SELECT e.id,e.data_json,s.name,MAX(o.updated_at) AS updated_at
   FROM event_records e JOIN event_outbox o ON o.event_id=e.id
   JOIN event_subscriptions s ON s.id=o.subscription_id
   WHERE s.principal=? AND e.created_at>=? AND s.name IN ('line.message.created','discord.message.created','discord.dm.message.created')
   GROUP BY e.id,s.name ORDER BY updated_at DESC,e.id LIMIT ?`).bind(principal,cutoff,LIMIT).all()).results||[];
  for(const row of notifications){
   let data;try{data=JSON.parse(row.data_json);}catch{continue;}
   const source=metadata(row.name==='line.message.created'?{channel:'line',source_id:data?.event_id}:{channel:row.name==='discord.dm.message.created'?'discord_dm':'discord_guild',source_id:data?.message_id,channel_id:data?.channel_id,guild_id:data?.guild_id});
   if(!source||source.event_id!==row.id)continue;
   const existing=candidates.get(source.event_id);
   if(existing)existing.updatedAt=Math.max(existing.updatedAt,row.updated_at);
   else candidates.set(source.event_id,{source,value:{},updatedAt:row.updated_at});
  }
  const output=[];
  for(const {source,value} of [...candidates.values()].sort((a,b)=>b.updatedAt-a.updatedAt||a.source.event_id.localeCompare(b.source.event_id))){
   const permitted=await permittedSource(env,source,authorizeChannel);if(!permitted)continue;
   const accepted=await first(env,`SELECT MIN(CASE WHEN o.status='delivered' THEN o.updated_at END) AS accepted_at,
    MAX(o.status='pending') AS pending,MAX(o.status='delivered') AS delivered,MAX(o.status='dead') AS dead,MAX(o.status='cancelled') AS cancelled FROM event_outbox o
    JOIN event_subscriptions s ON s.id=o.subscription_id WHERE o.event_id=? AND s.principal=?`,source.event_id,principal);
   const action=await first(env,'SELECT status,created_at FROM actions WHERE action_key=?',permitted.actionKey);
   const callbackAt=accepted?.accepted_at??null,readAt=instant(value.first_read_tool_at),reservedAt=action?.created_at??null;
   const completedAt=action?.status==='completed'?instant(value.confirmed_completed_at):null;
   const intervals={occurred_to_recorded:delta(permitted.recordedAt,permitted.occurredAt),recorded_to_callback:delta(callbackAt,permitted.recordedAt),callback_to_first_read_tool:delta(readAt,callbackAt),first_read_tool_to_reply_reserved:delta(reservedAt,readAt),reply_reserved_to_confirmed_completed:delta(completedAt,reservedAt),first_send_attempt_to_confirmed_completed:delta(completedAt,instant(value.first_send_attempt_at))};
   output.push({channel:source.channel,event_id:source.event_id,source_occurred_at:iso(permitted.occurredAt),source_recorded_at:iso(permitted.recordedAt),line_first_ingress_is_redelivery:source.channel==='line'&&typeof value.line_first_ingress_is_redelivery==='boolean'?value.line_first_ingress_is_redelivery:null,notification_statuses:['pending','delivered','dead','cancelled'].filter(status=>accepted?.[status]===1),callback_delivery_updated_at:iso(callbackAt),first_read_tool_at:iso(readAt),last_read_tool_at:iso(value.last_read_tool_at),reply_reserved_at:iso(reservedAt),first_send_attempt_at:iso(value.first_send_attempt_at),last_send_attempt_at:iso(value.last_send_attempt_at),confirmed_completed_at:iso(completedAt),reply_status:['reserved','retryable','unknown','failed','completed'].includes(action?.status)?action.status:null,interval_ms:intervals,timing_order_warning:Object.values(intervals).some(value=>value!==null&&value<0)});
   if(output.length>=LIMIT)break;
  }
  return {available:true,limit:LIMIT,retention_days:7,source_occurrence_observation:'platform_event_timestamp_not_message_composition_or_model_start',line_redelivery_observation:'first_signature_verified_ingress_best_effort_waitUntil_null_if_missing_or_no_context_not_cause_proof',read_observation:'successful_read_tool_entry_not_model_start',callback_observation:'earliest_delivered_outbox_updated_at',trigger_origin:'not_observed',messages:output};
 }catch{return {available:false,reason:'DIAGNOSTICS_UNAVAILABLE',messages:[]};}
}
export async function pruneDeliveryDiagnostics(env){
 try{
  if(env.BRIDGE_RUNTIME==='cloud'&&env.DB)await run(env,'DELETE FROM bridge_runtime WHERE substr(key,1,?)=? AND updated_at<?',PREFIX.length,PREFIX,Date.now()-RETENTION_MS);
 }catch{}
}
