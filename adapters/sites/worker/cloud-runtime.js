import {renewCloudLineToken} from './line-token.js';
import {retryCloudLineReplies} from './line.js';
import {pruneDeliveryDiagnostics} from './delivery-diagnostics.js';
const ID=/^[0-9]{17,20}$/;
const run=(env,sql,...v)=>env.DB.prepare(sql).bind(...v).run();
const first=(env,sql,...v)=>env.DB.prepare(sql).bind(...v).first();
const DISCORD_FAILURES=new Set(['DISCORD_RATE_LIMITED','DISCORD_UNAVAILABLE','DISCORD_REDIRECT_DENIED','DISCORD_INVALID_RESPONSE','DM_NOT_ALLOWED','DM_RECIPIENT_MISMATCH','DM_SOURCE_MISMATCH','SOURCE_MISMATCH','GUILD_NOT_ALLOWED','CHANNEL_NOT_ALLOWED','DISCORD_CURSOR_STALLED']);
const discordFailure=error=>{const code=error?.code||error?.message;return typeof code==='string'&&(DISCORD_FAILURES.has(code)||/^DISCORD_[45]\d\d$/.test(code))?code:null;};
class ChannelFailure extends Error{}
async function readDiscord(discord,env,path){
 try{return await discord(env,path);}catch(error){
  // The HTTP dependency may throw a transport error containing a URL or secret.
  // Only fixed labels reach maintenance records, never arbitrary exception text.
  throw new ChannelFailure(discordFailure(error)||'DISCORD_UNAVAILABLE');
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
export async function maintainCloud(env,{discord,events,configured,source='unspecified'}){
 if(!env.DB)throw Error('PERSISTENCE_UNAVAILABLE');
 const nonce=crypto.randomUUID(),now=Date.now();
 const acquired=await run(env,"INSERT INTO bridge_runtime (key,value,updated_at) VALUES ('cloud_lease',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE bridge_runtime.updated_at<?",nonce,now,now-120000);
 if(!acquired.meta?.changes)return {busy:true,...await cloudRuntimeStatus(env)};
 let observed=0;const failures=[];
 try{
  if(configured(env)&&env.DISCORD_ENABLE_EVENTS==='true'){
   const since=Date.parse(env.DISCORD_CLOUD_SINCE||'');
   if(!Number.isFinite(since)||since<1420070400000)throw Error('DISCORD_START_TIME_REQUIRED');
   const initial=String(BigInt(since-1420070400000)<<22n);
   const channels=[...new Set((env.DISCORD_POLL_CHANNEL_IDS||'').split(',').filter(Boolean))];
   if(!channels.length||channels.length>10||channels.some(id=>!ID.test(id)))throw Error('DISCORD_CHANNELS_REQUIRED');
   for(const [index,id] of channels.entries()){
    // A channel ordinal identifies the failed configured entry without copying
    // private Discord IDs into the status or arbitrary upstream error bodies.
    const failure=code=>failures.push('DISCORD_CHANNEL_'+(index+1)+':'+code);
    try{
    const ch=await readDiscord(discord,env,'/channels/'+id);
    if(!ch||ch.id!==id)throw new ChannelFailure('SOURCE_MISMATCH');
    const dm=ch.type===1;
    if(dm){
     const owner=env.DISCORD_OWNER_USER_ID;
     if(!ID.test(owner||''))throw Error('DISCORD_OWNER_REQUIRED');
     if(ch.recipients?.length!==1||ch.recipients[0].id!==owner)throw new ChannelFailure('DM_RECIPIENT_MISMATCH');
     await run(env,"INSERT OR IGNORE INTO dm_contacts (channel_id,user_id,guild_id,owner_site_id,source_channel_id,source_message_id,delivery_status,authorized_at,updated_at) VALUES (?,?,?,?,?,?,'sent',?,?)",id,owner,env.DISCORD_GUILD_ID,env.BRIDGE_OWNER_SITE_ID,id,'cloud-owner',since,Date.now());
    }else if(ch.guild_id!==env.DISCORD_GUILD_ID)throw new ChannelFailure('GUILD_NOT_ALLOWED');
    const cursorKey='cloud_cursor:'+id;
    const saved=await first(env,'SELECT value FROM bridge_runtime WHERE key=?',cursorKey);
    const cursor=saved?.value||initial;
    if(!ID.test(cursor))throw Error('INVALID_CURSOR');
    let before,complete=false;const fresh=[];
    // Paginate backwards to the persisted cursor before advancing it. Never
    // silently skip a busy channel's backlog by keeping only its newest page.
    for(let page=0;page<10;page++){
     const rows=await readDiscord(discord,env,'/channels/'+id+'/messages?limit=100'+(before?'&before='+before:''));
     if(!Array.isArray(rows)||rows.some(m=>!m||!ID.test(m.id||'')||m.channel_id!==id))throw new ChannelFailure('SOURCE_MISMATCH');
     for(const m of rows)if(BigInt(m.id)>BigInt(cursor))fresh.push(m);
     if(rows.length<100||rows.some(m=>BigInt(m.id)<=BigInt(cursor))){complete=true;break;}
     const oldest=rows.reduce((a,m)=>BigInt(m.id)<BigInt(a)?m.id:a,rows[0].id);
     if(oldest===before)throw new ChannelFailure('DISCORD_CURSOR_STALLED');before=oldest;
    }
    if(!complete){failure('DISCORD_BACKLOG_LIMIT');continue;}
    fresh.sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
    for(const m of fresh){
     if(Date.now()-now>20000){failure('RECOVERY_CONTINUES_NEXT_TICK');break;}
     if(!m.author?.bot&&!m.webhook_id&&m.author?.id!==env.DISCORD_BOT_ID&&(!dm||m.author.id===env.DISCORD_OWNER_USER_ID)){
      await events.enqueue(env,{guild_id:env.DISCORD_GUILD_ID,channel_id:id,message_id:m.id,...(dm?{scope:'dm'}:{})});observed++;
     }
     await run(env,'INSERT INTO bridge_runtime (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',cursorKey,m.id,Date.now());
    }
    }catch(error){
     const code=error instanceof ChannelFailure?error.message:discordFailure(error);
     // Cursor writes, event persistence, invalid saved cursors and global
     // configuration faults remain fatal; they must never look like a good tick.
     if(!code)throw error;
     failure(code);
    }
   }
  }
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
 }finally{await run(env,"DELETE FROM bridge_runtime WHERE key='cloud_lease' AND value=?",nonce);}
}
export function cloudRuntimePage(nonce){
 return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ともにゃ クラウド受信</title><style>body{font:17px/1.7 system-ui;max-width:760px;margin:50px auto;padding:24px;background:#f5f7fb;color:#17202a}pre{white-space:pre-wrap;background:white;padding:20px;border-radius:12px}button{font:inherit;padding:12px 20px}</style><h1>ともにゃ クラウド受信</h1><p>この画面をdotのcloud browserで開くと、15秒ごとにDiscordの新着と未配信通知を回収します。LINEの受信口は、この画面が閉じてもクラウドで受信・保存します。</p><p>画面を閉じると高速回収は停止します。クラウドの復旧スケジュールは別途設定が必要です。</p><p><a href="/runtime/inbox">本人用LINE受信箱</a></p><button id="retry">今すぐ回収</button><p id="status" role="status">接続しています…</p><pre id="result">未実行</pre><script nonce="${nonce}">
 let running=false,timer;const status=document.getElementById('status'),result=document.getElementById('result');
 async function tick(){if(running)return;running=true;clearTimeout(timer);try{const r=await fetch('/runtime/tick',{method:'POST',headers:{'content-type':'application/json'},body:'{}',redirect:'error'});if(!r.ok)throw Error('HTTP '+r.status);const data=await r.json();result.textContent=JSON.stringify({checkedAt:new Date().toISOString(),...data},null,2);status.textContent='クラウドで回収中';}catch(e){status.textContent='接続を再試行します';result.textContent=String(e.message);}finally{running=false;timer=setTimeout(tick,15000);}}
 document.getElementById('retry').addEventListener('click',tick);addEventListener('online',tick);tick();
 </script></html>`;
}
