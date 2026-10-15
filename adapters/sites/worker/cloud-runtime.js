import {renewCloudLineToken} from './line-token.js';
import {retryCloudLineReplies} from './line.js';
import {pruneDeliveryDiagnostics} from './delivery-diagnostics.js';
import {discordGuildProfiles,discordGuildProfile,discordGuildEnv,discordGuildActivation} from './discord-guilds.js';
const ID=/^[0-9]{17,20}$/;
const FAST_DISCORD_DEADLINE=Symbol('cloud-agent-discord-deadline');
// The private overlay is propagated to authorization GETs inside enqueue too.
// Ordinary MCP reads and maintenance retain their existing 12-second timeout.
export function discordRequestTimeoutMs(env){const deadline=env?.[FAST_DISCORD_DEADLINE];return Number.isFinite(deadline)?Math.max(1,Math.min(2500,Math.floor(deadline-Date.now()))):12000;}
export function cloudAgentDiscordEnv(env,{deadline_ms}={}){const deadline=Math.min(Date.now()+20000,Number.isFinite(deadline_ms)?deadline_ms:Infinity,Number.isFinite(env?.[FAST_DISCORD_DEADLINE])?env[FAST_DISCORD_DEADLINE]:Infinity);return Object.assign(Object.create(env),{[FAST_DISCORD_DEADLINE]:deadline});}
const run=(env,sql,...v)=>env.DB.prepare(sql).bind(...v).run();
const first=(env,sql,...v)=>env.DB.prepare(sql).bind(...v).first();
const DISCORD_FAILURES=new Set(['DISCORD_RATE_LIMITED','DISCORD_UNAVAILABLE','DISCORD_REDIRECT_DENIED','DISCORD_INVALID_RESPONSE','DM_NOT_ALLOWED','DM_RECIPIENT_MISMATCH','DM_SOURCE_MISMATCH','SOURCE_MISMATCH','GUILD_NOT_ALLOWED','CHANNEL_NOT_ALLOWED','DISCORD_CURSOR_STALLED']);
const discordFailure=error=>{const code=error?.code||error?.message;return typeof code==='string'&&(DISCORD_FAILURES.has(code)||/^DISCORD_[45]\d\d$/.test(code))?code:null;};
class ChannelFailure extends Error{}
function discordRetryAfter(error){const value=Number(error?.retryAfterMs);return Number.isFinite(value)&&value>0?Math.min(Math.max(value,15000),86400000):15000;}
async function readDiscord(discord,env,path){
 try{return await discord(env,path);}catch(error){
  // The HTTP dependency may throw a transport error containing a URL or secret.
  // Only fixed labels reach maintenance records, never arbitrary exception text.
  const failure=new ChannelFailure(discordFailure(error)||'DISCORD_UNAVAILABLE');
  if(failure.message==='DISCORD_RATE_LIMITED'){
   // Carry only bounded retry timing, never arbitrary upstream details.
   failure.retryAfterMs=discordRetryAfter(error);
   failure.globalRateLimit=error?.globalRateLimit===true;
  }
  throw failure;
 }
}
const lineTokenFailure=error=>{const code=error?.code||error?.message;return typeof code==='string'&&(/^LINE_TOKEN_HTTP_[45]\d\d$/.test(code)||['LINE_TOKEN_OUTCOME_UNKNOWN','LINE_TOKEN_INVALID_RESPONSE','LINE_TOKEN_IDENTITY_MISMATCH','LINE_TOKEN_BOT_MISMATCH'].includes(code))?code:null;};
const lineReplyFailure=error=>{const code=error?.code;return typeof code==='string'&&(/^LINE_HTTP_[45]\d\d$/.test(code)||code==='LINE_WRITE_OUTCOME_UNKNOWN')?code:null;};
export const maintainTool={name:'bridge_maintain',description:'Recover pending event deliveries and collect new messages from the explicitly configured Discord channels. Safe to repeat; durable cursor, lease and event deduplication. Call from a cloud recovery schedule; this does not prove always-on uptime.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:false,openWorldHint:true}};
export async function cloudRuntimeStatus(env){
 if(!env.DB)return {healthy:false};
 const row=await first(env,"SELECT value,updated_at FROM bridge_runtime WHERE key='cloud_maintenance'");
 const state=row?JSON.parse(row.value):{};
 return {...state,healthy:!!row&&Date.now()-row.updated_at<120000&&!state.failures?.length,last_tick_at:row?new Date(row.updated_at).toISOString():null,computer_independent_e2e_verified:false};
}
async function acquireCollectionLease(env){
 if(!env.DB)throw Error('PERSISTENCE_UNAVAILABLE');
 const nonce=crypto.randomUUID(),now=Date.now();
 const acquired=await run(env,"INSERT INTO bridge_runtime (key,value,updated_at) VALUES ('cloud_lease',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE bridge_runtime.updated_at<?",nonce,now,now-120000);
 return acquired.meta?.changes?nonce:null;
}
async function releaseCollectionLease(env,nonce){await run(env,"DELETE FROM bridge_runtime WHERE key='cloud_lease' AND value=?",nonce);}
async function discordBackoffUntil(env,key){
 const row=await first(env,'SELECT value FROM bridge_runtime WHERE key=?',key);
 if(!row)return 0;
 const until=Number(row.value);
 if(!Number.isFinite(until)||until<0)throw Error('INVALID_DISCORD_BACKOFF');
 return until;
}
function currentCollectionProfile(env,guildId,ch){
 const profile=discordGuildProfile(env,guildId);
 if(!profile)throw new ChannelFailure('GUILD_NOT_ALLOWED');
 if(!profile.poll_channel_ids.includes(ch.id))throw new ChannelFailure('CHANNEL_NOT_ALLOWED');
 if(ch.type===1){if(!profile.is_primary)throw new ChannelFailure('DM_CHANNEL_NOT_ALLOWED');}
 else{
  if(ch.guild_id!==profile.guild_id)throw new ChannelFailure('GUILD_NOT_ALLOWED');
  if(profile.allowed_channel_ids.length&&!profile.allowed_channel_ids.includes(ch.id)&&!profile.allowed_channel_ids.includes(ch.parent_id))throw new ChannelFailure('CHANNEL_NOT_ALLOWED');
 }
 return profile;
}
async function collectDiscordUnderLease(env,{discord,events,configured,source,fastBackoff=false}){
 const now=Date.now(),baseEnv=env;let observed=0;const failures=[];
  if(configured(env)&&env.DISCORD_ENABLE_EVENTS==='true'){
   const profiles=discordGuildProfiles(baseEnv),multi=profiles.length>1;
   // The multi-guild opt-in is bounded too when invoked by maintenance. The
   // primary-only maintenance path retains its previous retry behavior.
   fastBackoff=fastBackoff||multi;
   if(fastBackoff)env=cloudAgentDiscordEnv(baseEnv,{deadline_ms:now+20000});
   const groups=[];
   for(const [guildIndex,profile] of profiles.entries()){
    if(!Number.isSafeInteger(profile.since_ms)||profile.since_ms<1420070400000)throw Error('DISCORD_START_TIME_REQUIRED');
    const channels=[...new Set(profile.poll_channel_ids)];
    if(!channels.length||channels.length>10||channels.some(id=>!ID.test(id)))throw Error('DISCORD_CHANNELS_REQUIRED');
    const activation=await discordGuildActivation(baseEnv,profile.guild_id),since=activation.since_ms;
    if(!profile.is_primary){
     // Seed all channels before a slow guild consumes the tick. Initial channels
     // honor the reviewed activation; later-added channels start when observed.
     // Empty channels retain the boundary rather than resetting on every tick.
     for(const id of channels){
      const start=String(BigInt((activation.initial_channel_ids.includes(id)?since:Math.max(since,now))-1420070400000)<<22n);
      await run(env,'INSERT OR IGNORE INTO bridge_runtime (key,value,updated_at) VALUES (?,?,?)','cloud_cursor:'+profile.guild_id+':'+id,start,now);
     }
    }
    groups.push({profile,guildIndex,since,channels});
   }
   let ordinal=0;
   if(multi){
    const saved=await first(env,"SELECT value FROM bridge_runtime WHERE key='cloud_discord_round_robin'");ordinal=saved?Number(saved.value):0;
    if(!Number.isSafeInteger(ordinal)||ordinal<0)throw Error('INVALID_DISCORD_ROUND_ROBIN');
    await run(env,"INSERT INTO bridge_runtime (key,value,updated_at) VALUES ('cloud_discord_round_robin',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",String((ordinal+1)%1000000),Date.now());
   }
   const tasks=[];
   for(let index=0;index<10;index++)for(const group of groups)if(index<group.channels.length)tasks.push({...group,index,id:group.channels[index]});
   // Rotate the flattened, guild-interleaved list, so every channel eventually
   // goes first even when another channel consumes the complete tick budget.
   if(multi)tasks.push(...tasks.splice(0,ordinal%tasks.length));
   const globalBackoffKey='cloud_discord_backoff:global';
   let globalBackoff=fastBackoff?await discordBackoffUntil(env,globalBackoffKey):0;
   for(const {profile,guildIndex,since,index,id} of tasks){
    // A channel ordinal identifies the failed configured entry without copying
    // private Discord IDs into the status or arbitrary upstream error bodies.
    const failure=code=>failures.push((multi?'DISCORD_GUILD_'+(guildIndex+1)+'_':'DISCORD_')+'CHANNEL_'+(index+1)+':'+code);
    if(fastBackoff&&Date.now()-now>=20000){failure('RECOVERY_CONTINUES_NEXT_TICK');break;}
    const backoffKey='cloud_discord_backoff:'+id;
    try{
    if(fastBackoff){
     if(globalBackoff>Date.now()||await discordBackoffUntil(env,backoffKey)>Date.now()){failure('DISCORD_RATE_LIMITED');continue;}
    }
    // Refresh the live profile before metadata and every body fetch. A revoked
    // channel may not be read merely because it is still in a saved poll list.
    const latestProfile=discordGuildProfile(baseEnv,profile.guild_id);
    if(!latestProfile)throw new ChannelFailure('GUILD_NOT_ALLOWED');
    if(!latestProfile.poll_channel_ids.includes(id))throw new ChannelFailure('CHANNEL_NOT_ALLOWED');
    let scoped=discordGuildEnv(env,profile.guild_id);
    const ch=await readDiscord(discord,scoped,'/channels/'+id);
    if(!ch||ch.id!==id)throw new ChannelFailure('SOURCE_MISMATCH');
    currentCollectionProfile(baseEnv,profile.guild_id,ch);
    const dm=ch.type===1;
    if(dm){
     const owner=baseEnv.DISCORD_OWNER_USER_ID;
     if(!ID.test(owner||''))throw Error('DISCORD_OWNER_REQUIRED');
     if(ch.recipients?.length!==1||ch.recipients[0].id!==owner)throw new ChannelFailure('DM_RECIPIENT_MISMATCH');
     await run(env,"INSERT OR IGNORE INTO dm_contacts (channel_id,user_id,guild_id,owner_site_id,source_channel_id,source_message_id,delivery_status,authorized_at,updated_at) VALUES (?,?,?,?,?,?,'sent',?,?)",id,owner,profile.guild_id,env.BRIDGE_OWNER_SITE_ID,id,'cloud-owner',since,Date.now());
    }
    const cursorKey='cloud_cursor:'+(profile.is_primary?'':profile.guild_id+':')+id;
    const initial=String(BigInt(since-1420070400000)<<22n);
    const saved=await first(env,'SELECT value FROM bridge_runtime WHERE key=?',cursorKey);
    let cursor=saved?.value||initial;
    if(!ID.test(cursor))throw Error('INVALID_CURSOR');
    if(!profile.is_primary&&BigInt(cursor)<BigInt(initial))cursor=initial;
    let before,complete=false,budgetExpired=false;const fresh=[];
    // Paginate backwards to the persisted cursor before advancing it. Never
    // silently skip a busy channel's backlog by keeping only its newest page.
    for(let page=0;page<10;page++){
     if(fastBackoff&&Date.now()-now>=20000){budgetExpired=true;break;}
     currentCollectionProfile(baseEnv,profile.guild_id,ch);scoped=discordGuildEnv(env,profile.guild_id);
     const rows=await readDiscord(discord,scoped,'/channels/'+id+'/messages?limit=100'+(before?'&before='+before:''));
     if(!Array.isArray(rows)||rows.some(m=>!m||!ID.test(m.id||'')||m.channel_id!==id))throw new ChannelFailure('SOURCE_MISMATCH');
     for(const m of rows)if(BigInt(m.id)>BigInt(cursor))fresh.push(m);
     if(rows.length<100||rows.some(m=>BigInt(m.id)<=BigInt(cursor))){complete=true;break;}
     const oldest=rows.reduce((a,m)=>BigInt(m.id)<BigInt(a)?m.id:a,rows[0].id);
     if(oldest===before)throw new ChannelFailure('DISCORD_CURSOR_STALLED');before=oldest;
    }
    if(budgetExpired){failure('RECOVERY_CONTINUES_NEXT_TICK');break;}
    if(!complete){failure('DISCORD_BACKLOG_LIMIT');continue;}
    fresh.sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
    for(const m of fresh){
     if(Date.now()-now>20000){failure('RECOVERY_CONTINUES_NEXT_TICK');break;}
     if(!m.author?.bot&&!m.webhook_id&&m.author?.id!==env.DISCORD_BOT_ID&&(!dm||m.author.id===env.DISCORD_OWNER_USER_ID)){
      currentCollectionProfile(baseEnv,profile.guild_id,ch);scoped=discordGuildEnv(env,profile.guild_id);
      await events.enqueue(scoped,{guild_id:profile.guild_id,channel_id:id,message_id:m.id,...(dm?{scope:'dm'}:{})});observed++;
     }
     await run(env,'INSERT INTO bridge_runtime (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',cursorKey,m.id,Date.now());
    }
    }catch(error){
     const code=error instanceof ChannelFailure?error.message:discordFailure(error);
     // Cursor writes, event persistence, invalid saved cursors and global
     // configuration faults remain fatal; they must never look like a good tick.
     if(!code)throw error;
     if(fastBackoff&&code==='DISCORD_RATE_LIMITED'){
      const until=Date.now()+discordRetryAfter(error);
      if(error.globalRateLimit)globalBackoff=until;
      await run(env,'INSERT INTO bridge_runtime (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',error.globalRateLimit?globalBackoffKey:backoffKey,String(until),Date.now());
     }
     failure(code);
    }
   }
  }
 return {observed,failures,degraded:failures.length>0,discord_configured:configured(env),mode:'cloud_collection',source};
}
// This intake-only entry point deliberately never renews LINE credentials,
// drains callbacks, retries replies, or invokes a model. Use the same durable
// cursor/lease as maintenance so cloud-agent waits cannot race another collector.
export async function collectCloudDiscord(env,{discord,events,configured,source='cloud_agent'}){
 const nonce=await acquireCollectionLease(env);
 if(!nonce)return {busy:true,observed:0,source};
 try{
  const result=await collectDiscordUnderLease(env,{discord,events,configured,source,fastBackoff:true});
  await run(env,"INSERT INTO bridge_runtime (key,value,updated_at) VALUES ('cloud_discord_collection',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",JSON.stringify(result),Date.now());
  return result;
 }finally{await releaseCollectionLease(env,nonce);}
}
export async function maintainCloud(env,{discord,events,configured,source='unspecified'}){
 const nonce=await acquireCollectionLease(env);
 if(!nonce)return {busy:true,...await cloudRuntimeStatus(env)};
 try{
  const {observed,failures}=await collectDiscordUnderLease(env,{discord,events,configured,source,fastBackoff:env.CLOUD_AGENT_ENABLED==='true'});
  let tokenRenewal;
  try{tokenRenewal=await renewCloudLineToken(env);if(tokenRenewal.requires_review)failures.push('LINE_TOKEN_REVIEW_REQUIRED');}
  catch(error){const code=lineTokenFailure(error);if(!code)throw error;failures.push(code);tokenRenewal={configured:true,renewed:false,requires_review:true,reason:code};}
  const delivery=await events.drain(env);
  let lineReplies;
  try{lineReplies=await retryCloudLineReplies(env);if(lineReplies.failures?.length)failures.push('LINE_REPLY_RECOVERY_INCOMPLETE');}
  catch(error){const code=lineReplyFailure(error);if(!code)throw error;failures.push(code);lineReplies={retried:0,completed:0,requires_review:true,reason:code};}
  // LINE payloads have bounded retention; keep undelivered messages for review.
  await run(env,"DELETE FROM cloud_line_messages WHERE created_at<? AND NOT EXISTS (SELECT 1 FROM event_outbox WHERE event_id='line_'||cloud_line_messages.event_id AND status='pending')",Date.now()-30*86400000);
  await pruneDeliveryDiagnostics(env);
  const result={observed,delivered:delivery.delivered,failures,degraded:failures.length>0,discord_configured:configured(env),mode:'cloud_polling',line_token:tokenRenewal,line_replies:lineReplies,source};
  if(source==='mcp')await run(env,"INSERT INTO bridge_runtime (key,value,updated_at) VALUES ('cloud_mcp_maintenance',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",JSON.stringify(result),Date.now());
  await run(env,"INSERT INTO bridge_runtime (key,value,updated_at) VALUES ('cloud_maintenance',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",JSON.stringify(result),Date.now());
  return result;
 }finally{await releaseCollectionLease(env,nonce);}
}
export function cloudRuntimePage(nonce){
 return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ともにゃ クラウド受信</title><style>body{font:17px/1.7 system-ui;max-width:760px;margin:50px auto;padding:24px;background:#f5f7fb;color:#17202a}pre{white-space:pre-wrap;background:white;padding:20px;border-radius:12px}button{font:inherit;padding:12px 20px}</style><h1>ともにゃ クラウド受信</h1><p>この画面をdotのcloud browserで開くと、15秒ごとにDiscordの新着と未配信通知を回収します。LINEの受信口は、この画面が閉じてもクラウドで受信・保存します。</p><p>画面を閉じると高速回収は停止します。クラウドの復旧スケジュールは別途設定が必要です。</p><p><a href="/runtime/inbox">本人用LINE受信箱</a></p><button id="retry">今すぐ回収</button><p id="status" role="status">接続しています…</p><pre id="result">未実行</pre><script nonce="${nonce}">
 let running=false,timer;const status=document.getElementById('status'),result=document.getElementById('result');
 async function tick(){if(running)return;running=true;clearTimeout(timer);try{const r=await fetch('/runtime/tick',{method:'POST',headers:{'content-type':'application/json'},body:'{}',redirect:'error'});if(!r.ok)throw Error('HTTP '+r.status);const data=await r.json();result.textContent=JSON.stringify({checkedAt:new Date().toISOString(),...data},null,2);status.textContent='クラウドで回収中';}catch(e){status.textContent='接続を再試行します';result.textContent=String(e.message);}finally{running=false;timer=setTimeout(tick,15000);}}
 document.getElementById('retry').addEventListener('click',tick);addEventListener('online',tick);tick();
 </script></html>`;
}
