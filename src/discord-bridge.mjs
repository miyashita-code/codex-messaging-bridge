import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DiscordClient } from './discord.mjs';
import { discordAdmitted,discordAddressed,discordSessionKey,stripDiscordMentions } from './discord-policy.mjs';
import { declineRequest } from './codex.mjs';

const namespace = id => `discord:${id}`;
const messageId = (account,message) => `discord:${account.accountId}:message:${message.id}`;
const error = code => Object.assign(new Error(code),{code});
export function splitDiscordText(text,limit=2000,maxLines=17) {
  if(typeof text!=='string')throw error('invalid_text');
  const chunks=[];for(let start=0;start<text.length;){let end=Math.min(text.length,start+limit),newlines=0;for(let i=start;i<end;i++)if(text[i]==='\n' && ++newlines>=maxLines){end=i+1;break;}if(end<text.length && /[\uD800-\uDBFF]/.test(text[end-1]) && /[\uDC00-\uDFFF]/.test(text[end]))end--;if(end===start)end=start+2;chunks.push(text.slice(start,end));start=end;}return chunks;
}
export class DiscordBridge {
  constructor({config,store,backend,mcp,clients,logger=()=>{}}) {
    this.config=config;this.store=store;this.backend=backend;this.mcp=mcp;this.logger=logger;
    this.clients=clients || new Map(config.discordAccounts.map(a=>[a.accountId,new DiscordClient(a)]));
    this.active=new Map();this.requests=new Map();this.sends=new Map();this.botWindows=new Map();this.interactions=new Map();this.stopping=false;
  }
  account(id) {const a=this.config.discordAccounts.find(a=>a.accountId===id);if(!a)throw error('discord_account_not_found');return a;}
  allowed(a,message) {return discordAdmitted(a,message,this.store.paired(namespace(a.accountId),message.author?.id));}
  botLoopAllowed(a,m) {
    if(!m.author?.bot)return true;
    const policy=a.botLoopProtection || {},max=policy.maxEventsPerWindow ?? 20,windowMs=(policy.windowSeconds ?? 60)*1000,cooldownMs=(policy.cooldownSeconds ?? 60)*1000;
    if(policy.enabled===false)return true;
    const key=`${a.accountId}:${m.channel_id}:${m.author.id}`,now=Date.now();let bucket=this.botWindows.get(key);
    if(bucket?.cooldown>now)return false;
    if(!bucket || bucket.start+windowMs<now)bucket={start:now,count:0,cooldown:0};bucket.count++;
    if(bucket.count>max)bucket.cooldown=now+cooldownMs;this.botWindows.set(key,bucket);
    for(const [k,v] of this.botWindows)if(v.start+windowMs<now && v.cooldown<now)this.botWindows.delete(k);
    return bucket.count<=max;
  }
  ingest(a,message) {
    if(!message?.id || !message.channel_id || !message.author?.id)throw error('invalid_discord_event');
    const id=messageId(a,message);
    if(this.store.db.prepare('SELECT 1 FROM jobs WHERE id=?').get(id))return false;
    if(this.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('pending','processing')").get().n>=this.config.queueLimit)throw error('queue_full');
    // Self events never become agent turns or pairing challenges.
    if(message.author.id===(message.bot_id || message.botUserId || a.botId))return false;
    if(!this.botLoopAllowed(a,message))return false;
    const control=/^\/(approve|deny|answer|stop)\b/.test(stripDiscordMentions(message,message.bot_id || message.botUserId || a.botId)) || message.bridge_control;
    return this.store.enqueue(namespace(a.accountId),discordSessionKey(a.accountId,message)+(control?':control':''),message,id);
  }
  sessionSource(m) {return {type:m.guild_id?'discord-guild':m.channel?.type===3?'discord-group':'discord-dm',groupId:m.channel_id,userId:m.author.id};}
  isConversationAllowed(accountId,id,userId) {
    const rows=this.store.db.prepare('SELECT data FROM inbox WHERE session_key IN (SELECT key FROM sessions WHERE account_id=? AND conversation_id=?) AND (? IS NULL OR json_extract(data,\'$.userId\')=?) ORDER BY created DESC,rowid DESC LIMIT 1').all(namespace(accountId),id,userId || null,userId || null);
    for(const row of rows) {
      const m=JSON.parse(row.data);if(userId && m.userId!==userId)continue;
      try {return this.allowed(this.account(accountId),m.policyMessage);}catch{return false;}
    }
    return false;
  }
  listConversations() {
    return this.store.db.prepare("SELECT * FROM sessions WHERE account_id LIKE 'discord:%' ORDER BY updated DESC LIMIT 200").all().filter(s=>this.isConversationAllowed(s.account_id.slice(8),s.conversation_id,s.user_id)).map(s=>({channel:'discord',accountId:s.account_id.slice(8),conversationId:s.conversation_id,userId:s.user_id,type:s.type,threadId:s.thread_id,updated:s.updated}));
  }
  readMessage(id) {
    const m=this.store.message(id);if(m?.channel!=='discord' || !this.allowed(this.account(m.accountId),m.policyMessage) || !this.isConversationAllowed(m.accountId,m.conversationId,m.userId))throw error('discord_message_not_available');
    const {mediaPaths,policyMessage,...safe}=m;return safe;
  }
  listInbox({conversationId,limit=50}={}) {
    if(!Number.isInteger(limit) || limit<1 || limit>100)throw error('invalid_limit');
    return this.store.db.prepare("SELECT data FROM inbox WHERE json_extract(data,'$.channel')='discord' AND (? IS NULL OR json_extract(data,'$.conversationId')=?) ORDER BY created DESC,rowid DESC LIMIT 1000").all(conversationId || null,conversationId || null).map(r=>JSON.parse(r.data)).filter(m=>this.allowed(this.account(m.accountId),m.policyMessage) && this.isConversationAllowed(m.accountId,m.conversationId,m.userId)).slice(0,limit).map(m=>this.readMessage(m.id));
  }
  readMedia(id) {
    this.readMessage(id);const m=this.store.message(id);let size=0;
    if(!m.mediaPaths?.length)throw error('discord_media_not_available');
    return m.mediaPaths.map((path,index)=>{
      if(!existsSync(path))throw error('discord_media_not_available');const data=readFileSync(path);size+=data.length;
      if(size>(this.account(m.accountId).mediaMaxMb || 10)*1024*1024)throw error('discord_media_too_large');
      const mimeType=m.media[index].mimeType;
      return mimeType.startsWith('image/')?{type:'image',data:data.toString('base64'),mimeType}:{type:'resource',resource:{uri:`discord-media://${encodeURIComponent(id)}/${index}`,mimeType,blob:data.toString('base64')}};
    });
  }
  async challenge(a,m) {
    if(m.guild_id || m.channel?.type!==1 || a.dmPolicy!=='pairing' || a.dm?.enabled===false || m.author?.bot || m.webhook_id)return;
    const p=this.store.pairing(namespace(a.accountId),m.author.id);
    if(p.created)await this.simple(a,m,`AI秘書の接続承認が必要です。\nペアリングコード: ${p.code}\n管理者がGatewayで承認してください:\ncodex-line-bridge pairing approve discord ${p.code}\n有効期限は1時間です。承認後もう一度送信してください。`);
  }
  async simple(a,m,text,native) {
    const body=native || splitDiscordText(text,a.textChunkLimit,a.maxLinesPerMessage).map(content=>({content}));
    return this.deliver(createHash('sha256').update(`discord:system:${a.accountId}:${m.id}:${JSON.stringify(body)}`).digest('hex'),{id:`system:${m.id}`,accountId:a.accountId,conversationId:m.channel_id},body,{system:true});
  }
  async process(job) {
    const a=this.account(job.account_id.slice(8)),m=JSON.parse(job.event);
    if(!this.allowed(a,m)) {await this.challenge(a,m);return;}
    const cleanContent=stripDiscordMentions(m,m.bot_id || m.botUserId || a.botId);
    if(m.bridge_control || /^\/(approve|deny|answer)\b/.test(cleanContent)) {await this.answer(a,m,m.bridge_control || cleanContent);return;}
    if(!m.bridge_native && !discordAddressed(a,m,m.bot_id || m.botUserId || a.botId))return;
    const key=discordSessionKey(a.accountId,m),content=stripDiscordMentions(m,m.bot_id || m.botUserId || a.botId);
    if(content==='/help') {await this.simple(a,m,'AI秘書に仕事を依頼してください。\n/new: 新しい会話\n/status: 接続状態\n/stop: 実行停止（Codex用）\nサーバーではBotへのメンションまたは返信で呼び出せます。');return;}
    if(content==='/new' || content==='/reset') {this.store.saveSession(key,namespace(a.accountId),this.sessionSource(m));this.store.saveThread(key,null);await this.simple(a,m,this.config.backend==='dot'?'Discord側の会話区切りを記録しました。Your dotの記憶はYour dot側で管理されます。':'新しい会話を開始します。');return;}
    if(content==='/status') {await this.simple(a,m,`接続先: ${this.config.backend}\nDiscord channel: ${m.channel_id}`);return;}
    if(content==='/stop') {const current=this.active.get(key);if(current){current.abort.abort();await this.backend?.interrupt(key);}await this.simple(a,m,current?'停止を要求しました。完了済みの操作は取り消されません。':'現在この会話で実行中のCodex処理はありません。');return;}
    this.store.saveSession(key,namespace(a.accountId),this.sessionSource(m));
    let stored=this.store.message(job.id);
    if(!stored) {
      const policyMessage={id:m.id,channel_id:m.channel_id,guild_id:m.guild_id,guild:m.guild,webhook_id:m.webhook_id,content:m.content,author:{id:m.author.id,bot:!!m.author.bot,username:m.author.username,global_name:m.author.global_name,discriminator:m.author.discriminator},member:{roles:m.member?.roles || [],nick:m.member?.nick},channel:m.channel,mentions:m.mentions?.map(u=>({id:u.id})),bot_id:m.bot_id || m.botUserId || a.botId,referenced_message:m.referenced_message?{author:{id:m.referenced_message.author?.id}}:undefined};
      stored={id:job.id,channel:'discord',accountId:a.accountId,conversationId:m.channel_id,userId:m.author.id,guildId:m.guild_id,threadParentId:m.channel?.parent_id,type:m.attachments?.length?'attachment':'text',timestamp:m.timestamp || new Date().toISOString(),text:content || (m.attachments?.length?'[添付ファイル]':'[メッセージ]'),policyMessage,media:[],mediaPaths:[]};
      for(const attachment of (m.attachments || []).slice(0,10)) {
        mkdirSync(join(this.config.dataDir,'media'),{recursive:true,mode:0o700});
        const path=join(this.config.dataDir,'media',createHash('sha256').update(`${job.id}:${attachment.id}`).digest('hex'));
        const media=await this.clients.get(a.accountId).download(attachment,path,(a.mediaMaxMb || 10)*1024*1024);
        stored.media.push({id:attachment.id,fileName:attachment.filename,mimeType:media.contentType,size:media.size});stored.mediaPaths.push(media.path);
      }
      this.store.saveMessage(key,stored);
    }
    if(this.config.backend==='inbox')return;
    if(this.config.backend==='dot') {await this.mcp.publish(this.readMessage(job.id));return;}
    const previous=this.store.db.prepare('SELECT * FROM runs WHERE id=?').get(job.id);
    if(previous?.finished) {if(previous.text)await this.sendReply({messageId:job.id,text:previous.text,idempotencyKey:`codex:${job.id}`});return;}
    if(previous)throw error('agent_execution_needs_review');
    const input=[{type:'text',text:stored.text}];
    for(let i=0;i<stored.media.length;i++) {if(stored.media[i].mimeType.startsWith('image/'))input.push({type:'localImage',path:stored.mediaPaths[i]});else input[0].text+=`\n添付 (${stored.media[i].mimeType}): ${stored.mediaPaths[i]}。読める場合のみ内容を確認してください。`;}
    try{await this.clients.get(a.accountId).typing(m.channel_id);}catch{}
    this.store.db.prepare('INSERT INTO runs(id) VALUES(?)').run(job.id);
    const result=await this.backend.run({sessionKey:key,threadId:this.store.session(key)?.thread_id,input,systemPrompt:'あなたはDiscordで応対するAI秘書です。日本語で簡潔に答え、依頼された仕事を進めてください。承認が必要な操作はCodexの承認機構を利用してください。許可のない別会話の非公開情報を共有しないでください。',onThread:id=>this.store.saveThread(key,id),onRequest:r=>this.request(a,m,key,r),signal:this.active.get(key)?.abort.signal});
    this.store.db.prepare('UPDATE runs SET text=?,finished=1 WHERE id=?').run(result.text || '',job.id);
    if(result.text)await this.sendReply({messageId:job.id,text:result.text,idempotencyKey:`codex:${job.id}`});
  }
  async request(a,m,key,r) {
    const code=randomBytes(12).toString('base64url');this.requests.set(code,{...r,accountId:a.accountId,conversationId:m.channel_id,userId:m.author.id,key,expires:Date.now()+600000});
    const question=r.method.includes('requestUserInput') || r.method.includes('elicitation'),summary=String(r.params.reason || r.params.command || r.params.message || JSON.stringify(r.params.questions || [])).slice(0,1300);
    if(question)await this.simple(a,m,`回答が必要です。\n${summary}\n/answer ${code} 回答内容\n拒否: /deny ${code}`);
    else await this.simple(a,m,undefined,[{content:`操作の承認が必要です。\n${summary}`,components:[{type:1,components:[{type:2,style:1,label:'今回だけ許可',custom_id:`bridge:${code}:accept`},{type:2,style:2,label:'拒否',custom_id:`bridge:${code}:decline`}]}]}]);
  }
  async answer(a,m,text) {
    let match=/^bridge:([A-Za-z0-9_-]+):(accept|decline)$/.exec(text),code=match?.[1],decision=match?.[2],answer;
    if(!match){match=/^\/(approve|deny|answer)\s+([A-Za-z0-9_-]+)(?:\s+([\s\S]+))?$/.exec(text);if(!match)return;code=match[2];decision=match[1]==='approve'?'accept':match[1]==='deny'?'decline':'answer';answer=match[3];}
    const r=this.requests.get(code);
    if(!r || r.expires<Date.now() || r.accountId!==a.accountId || r.conversationId!==m.channel_id || r.userId!==m.author.id){await this.simple(a,m,'この確認は期限切れか、あなたの会話の確認ではありません。');return;}
    let result;
    if(r.method==='item/tool/requestUserInput')result={answers:Object.fromEntries((r.params.questions || []).map(q=>[q.id,{answers:decision==='answer' && answer?[answer]:[]}]))};
    else if(r.method==='mcpServer/elicitation/request' || r.method==='item/permissions/requestApproval') {if(decision==='accept'){await this.simple(a,m,'この詳細な承認はCodex側で確認してください。Discordでは拒否だけ受け付けます。');return;}result=declineRequest(r.method,r.params);}
    else result={decision:decision==='accept'?'accept':'decline'};
    this.requests.delete(code);await this.simple(a,m,this.backend.answer(r.requestId,result)?'回答を送信しました。':'この確認はすでに終了しています。');
  }
  async deferInteraction(a,i) {
    const client=this.clients.get(a.accountId);
    const key=`${a.accountId}:${i.id}`,now=Date.now();
    for(const [id,state] of this.interactions)if(state.expires<now)this.interactions.delete(id);
    let state=this.interactions.get(key);
    if(!state) {
      if(this.interactions.size>=1000)throw error('interaction_limit');
      state={expires:now+15*60000};this.interactions.set(key,state);
      // Defer immediately, before channel REST lookup or policy work. Discord requires a response in 3 seconds.
      state.ack=client.interactionCallback(i.id,i.token,{type:5,data:{flags:64}}).catch(e=>{if(e.discordCode!==40060){this.interactions.delete(key);throw e;}});
    }
    await state.ack;
  }
  async interaction(a,i) {
    const client=this.clients.get(a.accountId),user=i.member?.user || i.user;
    if(!user || !i.channel_id)return;
    await this.deferInteraction(a,i);
    const m={id:i.id,channel_id:i.channel_id,guild_id:i.guild_id,guild:i.guild,author:user,member:i.member,channel:i.channel || await client.channelInfo(i.channel_id),mentions:[],bot_id:a.botId,timestamp:new Date().toISOString(),bridge_native:true};
    const edit=content=>client.editInteractionResponse(i.application_id || a.botId,i.token,{content}).catch(()=>{});
    if(!this.allowed(a,m)){await edit('この会話からの利用は許可されていません。DMのペアリングを確認してください。');return;}
    if(i.type===3 && i.data?.custom_id?.startsWith('bridge:'))m.bridge_control=i.data.custom_id;
    else if(i.type===2 && ['help','status','new','stop'].includes(i.data?.name))m.content=`/${i.data.name}`;
    else {await edit('この操作は未対応です。');return;}
    // Ingress can be retried after a failed write, without re-acknowledging the interaction.
    this.ingest(a,m);this.tick();await edit('受け付けました。');
  }
  async sendReply({messageId:id,text,messages,idempotencyKey}) {
    if(typeof idempotencyKey!=='string' || !idempotencyKey || idempotencyKey.length>200)throw error('idempotency_key_required');
    this.readMessage(id);const m=this.store.message(id),a=this.account(m.accountId),body=messages || splitDiscordText(text || '',a.textChunkLimit,a.maxLinesPerMessage).map(content=>({content}));
    if(!body.length || body.length>100)throw error('invalid_message_count');
    const key=createHash('sha256').update(`discord:${id}:${idempotencyKey}`).digest('hex'),payload=JSON.stringify(body);
    const running=this.sends.get(key);if(running){if(running.payload!==payload)throw error('idempotency_key_conflict');return running.promise;}
    const promise=this.deliver(key,m,body).finally(()=>this.sends.delete(key));this.sends.set(key,{payload,promise});return promise;
  }
  async deliver(key,m,body,{system=false}={}) {
    const db=this.store.db,client=this.clients.get(m.accountId);let row=db.prepare('SELECT * FROM outbound WHERE key=?').get(key);
    if(row && row.messages!==JSON.stringify(body))throw error('idempotency_key_conflict');
    if(row?.status==='done')return {accepted:true,duplicate:true,receipts:JSON.parse(row.receipts)};
    if(row?.status==='uncertain')throw error('delivery_uncertain_requires_review');
    // Discord's nonce dedupe is only a recent window, not LINE's 24-hour retry-key contract.
    if(row?.status==='discord_sending' && row.updated<Date.now()-120000)throw error('discord_nonce_window_expired_requires_review');
    if(!row){db.prepare('INSERT INTO outbound(key,message_id,messages,status,updated) VALUES(?,?,?,?,?)').run(key,m.id,JSON.stringify(body),'pending',Date.now());row=db.prepare('SELECT * FROM outbound WHERE key=?').get(key);}
    const receipts=JSON.parse(row.receipts);
    for(let index=row.cursor;index<body.length;index++) {
      if(!system)this.readMessage(m.id);
      db.prepare("UPDATE outbound SET status='discord_sending' WHERE key=?").run(key);
      try {
        const r=await client.send(m.conversationId,[body[index]],`${key}:${index}`);
        if(!r.accepted || r.receiptComplete===false) {db.prepare("UPDATE outbound SET status='uncertain' WHERE key=?").run(key);throw error('delivery_uncertain_requires_review');}
        receipts.push({sentMessages:r.sentMessages || [],messageIds:r.messageIds || []});
        db.prepare('UPDATE outbound SET status=?,cursor=?,receipts=?,updated=? WHERE key=?').run(index===body.length-1?'done':'pending',index+1,JSON.stringify(receipts),Date.now(),key);
      } catch(e) {
        if(e.retryable && !e.accepted){e.safeRetry=true;if(!e.uncertain)db.prepare("UPDATE outbound SET status='pending',updated=? WHERE key=?").run(Date.now(),key);}
        else if(e.uncertain || e.accepted)db.prepare("UPDATE outbound SET status='uncertain' WHERE key=?").run(key);
        throw e;
      }
    }
    return {accepted:true,receipts};
  }
  start() {this.prune();this.housekeeping=setInterval(()=>this.prune(),3600000);this.housekeeping.unref();this.timer=setInterval(()=>this.tick(),100);this.timer.unref();this.tick();}
  prune() {
    const cutoff=Date.now()-this.config.retentionDays*86400000;
    for(const row of this.store.db.prepare('SELECT id,data FROM inbox WHERE created<?').all(cutoff)){const m=JSON.parse(row.data);if(m.channel!=='discord')continue;const job=this.store.db.prepare('SELECT status FROM jobs WHERE id=?').get(row.id);if(!['done','dead'].includes(job?.status))continue;for(const path of m.mediaPaths || [])try{unlinkSync(path);}catch{};this.store.db.prepare('DELETE FROM inbox WHERE id=?').run(row.id);this.store.db.prepare('DELETE FROM runs WHERE id=?').run(row.id);this.store.db.prepare('DELETE FROM outbound WHERE message_id=?').run(row.id);}
    this.store.db.prepare("DELETE FROM jobs WHERE account_id LIKE 'discord:%' AND status IN ('done','dead') AND created<?").run(cutoff);
    if(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dot_deliveries'").get()) {
      this.store.db.prepare("DELETE FROM dot_deliveries WHERE status!='pending' AND created_at<? AND subscription_id IN (SELECT id FROM dot_subscriptions WHERE event_name='discord.message.created')").run(cutoff);
      this.store.db.prepare("DELETE FROM dot_subscriptions WHERE event_name='discord.message.created' AND expires_at<? AND NOT EXISTS(SELECT 1 FROM dot_deliveries WHERE dot_deliveries.subscription_id=dot_subscriptions.id AND status='pending')").run(cutoff);
    }
  }
  tick() {
    if(this.stopping)return;
    for(const [code,r] of this.requests)if(r.expires<Date.now()){this.requests.delete(code);const result=declineRequest(r.method,r.params);if(result)this.backend?.answer(r.requestId,result);}
    const pending=this.store.pending(128,{channel:'discord'});
    for(const job of pending){const control=job.session_key.endsWith(':control');if(!control && [...this.active.keys()].filter(k=>!k.endsWith(':control')).length>=this.config.concurrency)continue;if(control && this.active.size>=this.config.concurrency+8)continue;if(this.active.has(job.session_key) || !this.store.claim(job.id))continue;
      const abort=new AbortController(),promise=this.process(job).then(()=>this.store.finish(job.id)).catch(e=>{const run=this.store.db.prepare('SELECT finished FROM runs WHERE id=?').get(job.id);const retryable=(!run || run.finished) && !!e.retryable && (!e.uncertain || e.safeRetry);this.store.fail(job.id,e.code || 'discord_processing_failed',retryable,this.config.maxAttempts,e.retryAfterMs);this.logger('discord_job_failed',{id:job.id,code:e.code || 'discord_processing_failed',retryable});}).finally(()=>this.active.delete(job.session_key));this.active.set(job.session_key,{promise,abort});
    }
  }
  async close() {this.stopping=true;clearInterval(this.timer);clearInterval(this.housekeeping);for(const [key,v] of this.active){v.abort.abort();await this.backend?.interrupt(key);}await Promise.allSettled([...this.active.values()].map(v=>v.promise));}
}
