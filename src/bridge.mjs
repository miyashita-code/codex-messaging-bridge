import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { LineClient, splitText } from './line.mjs';
import { renderMarkdown } from './format.mjs';
import { admitted, addressed, stripMentions, groupConfig, conversationId, sessionKey, senderAllowed } from './policy.mjs';
import { pairingCodeExpiryNotice } from './pairing.mjs';

const idFor = (account,event) => `${account}:${event.message?.id ? `message:${event.message.id}` : `event:${event.webhookEventId}`}`;
const retryId = key => {const h=createHash('sha256').update(key).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
const safeError = (code,retryable=false) => Object.assign(new Error(code),{code,retryable});
export class Bridge {
  constructor({config,store,backend,mcp,clients,logger=()=>{}}) {
    this.config=config;this.store=store;this.backend=backend;this.mcp=mcp;this.logger=logger;
    this.clients=clients || new Map(config.accounts.map(a=>[a.accountId,new LineClient(a)]));
    this.active=new Map();this.requests=new Map();this.sends=new Map();this.stopping=false;
  }
  account(id) {const a=this.config.accounts.find(a=>a.accountId===id);if(!a) throw safeError('account_not_found');return a;}
  allowed(account,source) {return admitted(account,source,this.store.paired(account.accountId,source.userId),this.config.accessGroups || {});}
  isConversationAllowed(accountId,id,userId) {
    const s=this.store.db.prepare('SELECT * FROM sessions WHERE account_id=? AND conversation_id=? ORDER BY updated DESC LIMIT 1').get(accountId,id);
    if(!s) return false;
    const source={type:s.type,userId:userId || s.user_id,...(s.type==='group'?{groupId:id}:s.type==='room'?{roomId:id}:{})};
    try{return this.allowed(this.account(accountId),source);}catch{return false;}
  }
  listConversations() {
    return this.store.db.prepare('SELECT * FROM sessions ORDER BY updated DESC LIMIT 200').all().filter(s=>this.isConversationAllowed(s.account_id,s.conversation_id,s.user_id)).map(s=>({accountId:s.account_id,conversationId:s.conversation_id,userId:s.user_id,type:s.type,updated:s.updated,threadId:s.thread_id}));
  }
  readMessage(id) {
    const m=this.store.message(id);if(!m || !this.isConversationAllowed(m.accountId,m.conversationId,m.userId)) throw safeError('message_not_available');
    const {replyToken,mediaPath,...safe}=m;return safe;
  }
  listInbox({conversationId:id,limit=50}={}) {
    if(!Number.isInteger(limit) || limit<1 || limit>100) throw safeError('invalid_limit');
    return this.store.db.prepare("SELECT data FROM inbox WHERE (json_extract(data,'$.channel') IS NULL OR json_extract(data,'$.channel')='line') AND (? IS NULL OR json_extract(data,'$.conversationId')=?) ORDER BY created DESC,rowid DESC LIMIT 1000").all(id || null,id || null).map(r=>JSON.parse(r.data)).filter(m=>this.isConversationAllowed(m.accountId,m.conversationId,m.userId)).slice(0,limit).map(m=>this.readMessage(m.id));
  }
  readMedia(id) {
    this.readMessage(id);const m=this.store.message(id),ids=m.media?.items?.map(i=>i.messageId) || [id],limit=this.account(m.accountId).mediaMaxMb;let size=0;
    return ids.map(itemId=>{
      this.readMessage(itemId);const item=this.store.message(itemId);
      if(!item.mediaPath || !existsSync(item.mediaPath)) throw safeError('media_not_available');
      const data=readFileSync(item.mediaPath);size+=data.length;if(size>limit*1024*1024) throw safeError('media_group_too_large_read_items_individually');
      return item.media.mimeType.startsWith('image/') ? {type:'image',data:data.toString('base64'),mimeType:item.media.mimeType} : {type:'resource',resource:{uri:`line-media://${encodeURIComponent(itemId)}`,mimeType:item.media.mimeType,blob:data.toString('base64')}};
    });
  }
  ingest(account,event) {
    if(event.mode==='standby' || !event.source || !conversationId(event.source)) return false;
    if(!event.message?.id && !event.webhookEventId)throw Object.assign(safeError('stable_event_id_required'),{status:400});
    const id=idFor(account.accountId,event);
    if(this.store.db.prepare('SELECT 1 FROM jobs WHERE id=?').get(id))return false;
    if(this.store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('pending','processing')").get().n>=this.config.queueLimit)throw Object.assign(safeError('queue_full'),{status:503});
    const control=event.type==='postback' || (event.type==='message' && /^\/(approve|deny|answer|stop)\b/.test(stripMentions(event.message || {})));
    const key=sessionKey(account.accountId,event.source)+(control?':control':'');
    return this.store.enqueue(account.accountId,key,event,id);
  }
  async simple(account,event,text,messages) {
    const client=this.clients.get(account.accountId),body=messages || splitText(text).map(text=>({type:'text',text})).slice(0,5);
    if(!body.length) return;
    if(event.replyToken) {
      try {const r=await client.reply(event.replyToken,body);this.store.rememberQuotes(account.accountId,r);return r;} catch(e){if(!e.invalidReplyToken) throw e;}
    }
    const r=await client.push(conversationId(event.source),body,retryId(`${idFor(account.accountId,event)}:system:${JSON.stringify(body)}`));this.store.rememberQuotes(account.accountId,r);return r;
  }
  async process(job) {
    const a=this.account(job.account_id),event=JSON.parse(job.event),source=event.source;
    if(event.type==='join') {
      const id=conversationId(source),g=groupConfig(a,id);
      const known=this.store.db.prepare('SELECT 1 FROM introductions WHERE account_id=? AND conversation_id=?').get(a.accountId,id);
      if(known || a.groupPolicy==='disabled' || g.enabled===false || a.intro===false || a.joinIntro===false) return;
      if(a.groupPolicy!=='open' && !(g.allowFrom ?? a.groupAllowFrom)?.length) return;
      this.store.db.prepare('INSERT OR IGNORE INTO introductions VALUES(?,?)').run(a.accountId,id);
      await this.simple(a,event,typeof a.intro==='string'?a.intro:'こんにちは。AI秘書です。このグループで担当する仕事を教えてください。');return;
    }
    if(!['message','postback'].includes(event.type)) return;
    if(!this.allowed(a,source)) {
      if(source.type==='user' && a.dmPolicy==='pairing') {
        const pairing=this.store.pairing(a.accountId,source.userId,a.pairingCodeTtlMs);
        if(pairing.created) await this.simple(a,event,`AI秘書の接続承認が必要です。\nペアリングコード: ${pairing.code}\n管理者がGatewayで次を実行してください:\ncodex-line-bridge pairing approve line ${pairing.code}\n${pairingCodeExpiryNotice(a.pairingCodeTtlMs)}承認後、もう一度送信してください。`);
      }return;
    }
    if(event.type==='postback') {await this.answer(a,event,event.postback?.data || '');return;}
    const message=event.message || {},text=stripMentions(message);
    if(/^\/(approve|deny|answer)\b/.test(text)) {await this.answer(a,event,text);return;}
    if(!addressed(a,event,this.store.isQuote(a.accountId,message.quotedMessageId),this.config.channels?.defaults?.implicitMentions?.quotedBot!==false)) return;
    const key=sessionKey(a.accountId,source);this.store.saveSession(key,a.accountId,source);
    if(text==='/help') {await this.simple(a,event,'AI秘書に仕事を依頼してください。\n/new: 新しい会話\n/status: 接続状態\n/stop: 実行停止（Codex用）\nグループではメンションまたはBotへの引用返信で呼び出せます。');return;}
    if(text==='/new' || text==='/reset') {
      this.store.saveThread(key,null);await this.simple(a,event,this.config.backend==='dot'?'LINE側の会話区切りを記録しました。Your dotの記憶はYour dot側で管理されます。':'新しい会話を開始します。');return;
    }
    if(text==='/status') {await this.simple(a,event,`接続先: ${this.config.backend==='dot'?'Your dot (MCP Events)':'ローカルCodex'}\n会話: ${conversationId(source)}\nペアリング: 承認済み`);return;}
    if(text==='/stop') {if(!await this.immediate(a,event)) await this.simple(a,event,'現在この会話で実行中の処理はありません。');return;}
    const id=job.id;
    let stored=this.store.message(id);
    if(!stored) {
      const groupedRows=[];
      stored={id,accountId:a.accountId,conversationId:conversationId(source),userId:source.userId,type:message.type || 'unknown',timestamp:new Date(event.timestamp || Date.now()).toISOString(),text:text || this.describe(message),replyToken:event.replyToken};
      if(['image','audio','video','file'].includes(message.type)) {
        const path=join(this.config.dataDir,'media',createHash('sha256').update(id).digest('hex'));
        mkdirSync(join(this.config.dataDir,'media'),{recursive:true,mode:0o700});
        const media=await this.clients.get(a.accountId).download(message.id,path,a.mediaMaxMb*1024*1024);
        stored.media={messageId:message.id,mimeType:media.contentType,size:media.size,fileName:message.fileName || undefined};stored.mediaPath=media.path;
      }
      if(message.type==='image' && message.imageSet?.id) {
        const parts=await this.collectImageSet(job,event),items=[];
        for(const part of parts) {
          const partId=idFor(a.accountId,part.event);
          if(partId===id) {items.push({messageId:id,mimeType:stored.media.mimeType,size:stored.media.size});continue;}
          let sibling=this.store.message(partId);
          if(!sibling) {
            const path=join(this.config.dataDir,'media',createHash('sha256').update(partId).digest('hex'));
            const media=await this.clients.get(a.accountId).download(part.event.message.id,path,a.mediaMaxMb*1024*1024);
            sibling={id:partId,accountId:a.accountId,conversationId:stored.conversationId,userId:source.userId,type:'image',timestamp:new Date(part.event.timestamp || Date.now()).toISOString(),text:'[画像セットの画像]',media:{messageId:part.event.message.id,mimeType:media.contentType,size:media.size},mediaPath:media.path};
            this.store.saveMessage(key,sibling);
          }
          items.push({messageId:partId,mimeType:sibling.media.mimeType,size:sibling.media.size});groupedRows.push(part.row.id);
        }
        stored.media.items=items;stored.text=`[画像セット: ${items.length}枚${Number.isInteger(message.imageSet.total) && message.imageSet.total>items.length?` / ${message.imageSet.total}枚中`:''}]`;
        const last=[...parts].sort((a,b)=>a.row.created-b.row.created).at(-1)?.event;if(last?.replyToken)stored.replyToken=last.replyToken;
      }
      this.store.saveMessage(key,stored);
      for(const groupedId of groupedRows)this.store.finish(groupedId);
    }
    if(this.config.backend==='inbox')return;
    if(this.config.backend==='dot') {await this.mcp.publish(this.readMessage(id));return;}
    const previous=this.store.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    if(previous?.finished) {if(previous.text) await this.sendReply({messageId:id,text:previous.text,idempotencyKey:`codex:${id}`});return;}
    if(previous) throw safeError('agent_execution_needs_review');
    const input=[{type:'text',text:stored.text}];
    if(stored.type==='image' && stored.mediaPath) for(const item of stored.media?.items || [{messageId:id}]) {const image=item.messageId===id?stored:this.store.message(item.messageId);input.push({type:'localImage',path:image.mediaPath});}
    else if(stored.mediaPath) input[0].text+=`\n添付ファイル (${stored.media.mimeType}): ${stored.mediaPath}。利用できるツールで読める場合のみ内容を確認し、確認できなければその旨を伝えてください。`;
    try{await this.clients.get(a.accountId).loading(source.type==='user'?source.userId:undefined);}catch{}
    this.store.db.prepare('INSERT INTO runs(id) VALUES(?)').run(id);
    const result=await this.backend.run({sessionKey:key,threadId:this.store.session(key)?.thread_id,input,systemPrompt:`あなたはLINEで応対するAI秘書です。日本語で簡潔に答え、依頼された作業を進めてください。承認が必要な操作はCodexの承認機構を利用してください。LINEの1メッセージ上限は5000文字です。${groupConfig(a,conversationId(source)).systemPrompt || a.systemPrompt || ''}`,onThread:id=>this.store.saveThread(key,id),onRequest:r=>this.request(a,event,key,r),signal:this.active.get(key)?.abort.signal});
    this.store.db.prepare('UPDATE runs SET text=?,finished=1 WHERE id=?').run(result.text || '',id);
    if(result.text) await this.sendReply({messageId:id,text:result.text,idempotencyKey:`codex:${id}`});
  }
  describe(m) {
    if(m.type==='sticker') return m.text || (m.keywords || []).slice(0,3).join(', ') || '[スタンプ]';
    if(m.type==='location') return `[位置情報] ${m.title || ''} ${m.address || ''} (${m.latitude}, ${m.longitude})`;
    return `[${m.type || '未対応メッセージ'}]`;
  }
  async collectImageSet(job,event) {
    const set=event.message.imageSet,total=set.total;
    for(;;) {
      const parts=this.store.db.prepare("SELECT * FROM jobs WHERE session_key=? AND status IN ('pending','processing') ORDER BY rowid LIMIT 100").all(job.session_key).map(row=>({row,event:JSON.parse(row.event)})).filter(p=>p.event.source?.userId===event.source.userId && p.event.message?.type==='image' && p.event.message.imageSet?.id===set.id);
      const latest=Math.max(job.created,...parts.map(p=>p.row.created));
      if((Number.isInteger(total) && parts.length>=total) || Date.now()-latest>=4000 || this.stopping) return parts.sort((a,b)=>(a.event.message.imageSet.index ?? 999)-(b.event.message.imageSet.index ?? 999));
      await new Promise(r=>setTimeout(r,100));
    }
  }
  async request(a,event,key,r) {
    const code=randomBytes(12).toString('base64url');
    const item={...r,code,key,accountId:a.accountId,conversationId:conversationId(event.source),userId:event.source.userId,expires:Date.now()+600000};this.requests.set(code,item);
    const question=r.method.includes('requestUserInput') || r.method.includes('elicitation');
    const summary=String(r.params.reason || r.params.command || r.params.message || (question?JSON.stringify(r.params.questions || []):r.method)).slice(0,3000);
    if(question) {
      await this.simple(a,{...event,replyToken:undefined},`回答が必要です。\n${summary}\n/answer ${code} 回答内容\n拒否: /deny ${code}`);
    } else {
      const buttons=['accept','decline'].map((decision,i)=>({type:'action',action:{type:'postback',label:i?'拒否':'今回だけ許可',data:`bridge:${code}:${decision}`}}));
      await this.simple(a,{...event,replyToken:undefined},undefined,[{type:'text',text:`操作の承認が必要です。\n${summary}\n許可: /approve ${code}\n拒否: /deny ${code}`,quickReply:{items:buttons}}]);
    }
  }
  async answer(a,event,text) {
    let match=/^bridge:([A-Za-z0-9_-]+):(accept|decline)$/.exec(text),code=match?.[1],decision=match?.[2],answer;
    if(!match) {match=/^\/(approve|deny|answer)\s+([A-Za-z0-9_-]+)(?:\s+([\s\S]+))?$/.exec(text);if(!match)return;code=match[2];decision=match[1]==='approve'?'accept':match[1]==='deny'?'decline':'answer';answer=match[3];}
    const r=this.requests.get(code);
    if(!r || r.expires<Date.now() || r.accountId!==a.accountId || r.conversationId!==conversationId(event.source) || r.userId!==event.source.userId) {await this.simple(a,event,'この確認は期限切れか、あなたの会話の確認ではありません。');return;}
    let result;
    if(r.method==='item/tool/requestUserInput' || r.method==='tool/requestUserInput') {
      if(decision!=='answer' || !answer) {result={answers:{}};} else {result={answers:Object.fromEntries((r.params.questions || []).map(q=>[q.id,{answers:[answer]}]))};}
    } else if(r.method==='mcpServer/elicitation/request') {
      if(decision==='decline') result={action:'decline',content:null};
      else {await this.simple(a,event,'この接続先のフォーム承認はCodex側で確認してください。LINEでは拒否だけ受け付けます。');return;}
    } else if(r.method==='item/permissions/requestApproval') {
      // Permission grants are structured; never convert a generic button into unrestricted permissions.
      if(decision==='accept') {await this.simple(a,event,'詳細な権限の許可はCodex側で確認してください。LINEでは拒否だけ受け付けます。');return;}
      result={permissions:{},scope:'turn'};
    } else result={decision:decision==='accept'?'accept':'decline'};
    this.requests.delete(code);const ok=this.backend.answer(r.requestId,result);
    await this.simple(a,event,ok?'回答を送信しました。':'この確認はすでに終了しています。');
  }
  async sendReply({messageId,text,messages,idempotencyKey}) {
    if(typeof idempotencyKey!=='string' || !idempotencyKey || idempotencyKey.length>200) throw safeError('idempotency_key_required');
    const m=this.store.message(messageId);this.readMessage(messageId);
    const body=messages || renderMarkdown(text || '');
    if(!body.length || body.length>100) throw safeError('invalid_message_count');
    const key=createHash('sha256').update(`${messageId}:${idempotencyKey}`).digest('hex');
    if(this.sends.has(key)) {const running=this.sends.get(key);if(running.payload!==JSON.stringify(body))throw safeError('idempotency_key_conflict');return running.promise;}
    const promise=this.deliver(key,m,body).finally(()=>this.sends.delete(key));this.sends.set(key,{promise,payload:JSON.stringify(body)});return promise;
  }
  async deliver(key,m,body) {
    const db=this.store.db;let row=db.prepare('SELECT * FROM outbound WHERE key=?').get(key);
    if(row && row.messages!==JSON.stringify(body)) throw safeError('idempotency_key_conflict');
    if(row?.status==='done') return {accepted:true,duplicate:true,receipts:JSON.parse(row.receipts)};
    if(['uncertain','reply_inflight'].includes(row?.status)) throw safeError('delivery_uncertain_requires_review');
    if(row && row.updated<Date.now()-23*3600000) throw safeError('delivery_retry_window_expired');
    if(!row) {db.prepare('INSERT INTO outbound(key,message_id,messages,status,updated) VALUES(?,?,?,?,?)').run(key,m.id,JSON.stringify(body),'pending',Date.now());row=db.prepare('SELECT * FROM outbound WHERE key=?').get(key);}
    const client=this.clients.get(m.accountId),receipts=JSON.parse(row.receipts);let cursor=row.cursor;
    for(let index=cursor;index<body.length;index+=5) {
      this.readMessage(m.id);
      const chunk=body.slice(index,index+5);let receipt;
      const useReply=index===0 && !row.cursor && row.status==='pending' && m.replyToken && Date.parse(m.timestamp)>Date.now()-45000;
      let transport=useReply?'reply':'push';
      try {
        if(useReply) {
          db.prepare("UPDATE outbound SET status='reply_inflight' WHERE key=?").run(key);
          try {receipt=await client.reply(m.replyToken,chunk);} catch(e){if(e.invalidReplyToken){transport='push';db.prepare("UPDATE outbound SET status='push' WHERE key=?").run(key);receipt=await client.push(m.conversationId,chunk,retryId(`${key}:${index}`));}else throw e;}
        } else {db.prepare("UPDATE outbound SET status='push' WHERE key=?").run(key);receipt=await client.push(m.conversationId,chunk,retryId(`${key}:${index}`));}
        if(receipt?.uncertain) {db.prepare("UPDATE outbound SET status='uncertain' WHERE key=?").run(key);throw safeError('delivery_uncertain_requires_review');}
      } catch(e) {
        const safePushRetry=transport==='push' && e.retryable && !e.accepted;
        if(safePushRetry) {e.safeRetry=true;db.prepare("UPDATE outbound SET status='push' WHERE key=?").run(key);}
        else if(e.uncertain || (transport==='reply' && !e.status)) db.prepare("UPDATE outbound SET status='uncertain' WHERE key=?").run(key);
        else if(transport==='reply') db.prepare("UPDATE outbound SET status='push' WHERE key=?").run(key);
        throw e;
      }
      receipts.push({requestId:receipt?.requestId,sentMessages:receipt?.sentMessages || []});cursor=index+chunk.length;
      db.prepare('UPDATE outbound SET status=?,cursor=?,receipts=?,updated=? WHERE key=?').run(cursor>=body.length?'done':'push',cursor,JSON.stringify(receipts),Date.now(),key);
      this.store.rememberQuotes(m.accountId,receipt);
    }
    return {accepted:true,receipts};
  }
  start({recover=true}={}) {if(recover)this.store.recoverProcessing();this.prune();this.housekeeping=setInterval(()=>this.prune(),3600000);this.housekeeping.unref();this.timer=setInterval(()=>this.tick(),100);this.timer.unref();this.tick();}
  prune() {
    const cutoff=Date.now()-this.config.retentionDays*86400000,db=this.store.db;
    const old=db.prepare("SELECT inbox.id,inbox.data FROM inbox JOIN jobs ON inbox.id=jobs.id WHERE inbox.created<? AND jobs.status IN ('done','dead') AND jobs.account_id NOT LIKE 'discord:%'").all(cutoff);
    for(const row of old) {const m=JSON.parse(row.data);if(m.mediaPath)try{unlinkSync(m.mediaPath);}catch{};db.prepare('DELETE FROM inbox WHERE id=?').run(row.id);db.prepare('DELETE FROM runs WHERE id=?').run(row.id);db.prepare('DELETE FROM outbound WHERE message_id=?').run(row.id);}
    db.prepare("DELETE FROM jobs WHERE account_id NOT LIKE 'discord:%' AND status IN ('done','dead') AND created<?").run(cutoff);
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dot_deliveries'").get()) {
      db.prepare("DELETE FROM dot_deliveries WHERE status!='pending' AND created_at<?").run(cutoff);
      db.prepare('DELETE FROM dot_subscriptions WHERE expires_at<? AND NOT EXISTS(SELECT 1 FROM dot_deliveries WHERE dot_deliveries.subscription_id=dot_subscriptions.id AND status=\'pending\')').run(cutoff);
    }
  }
  tick() {
    if(this.stopping)return;
    for(const [code,r] of this.requests) if(r.expires<Date.now()){this.requests.delete(code);this.backend?.answer(r.requestId,r.method.includes('requestUserInput')?{answers:{}}:r.method.includes('elicitation')?{action:'decline',content:null}:r.method.includes('permissions')?{permissions:{},scope:'turn'}:{decision:'decline'});}
    for(const job of this.store.pending(this.config.concurrency*4,{channel:'line'}).sort((a,b)=>Number(b.session_key.endsWith(':control'))-Number(a.session_key.endsWith(':control')))) {
      const control=job.session_key.endsWith(':control');
      if(!control && [...this.active.keys()].filter(k=>!k.endsWith(':control')).length>=this.config.concurrency) continue;
      if(control && this.active.size>=this.config.concurrency+8) continue;
      if(this.active.has(job.session_key) || !this.store.claim(job.id)) continue;
      const abort=new AbortController();
      const promise=this.process(job).then(()=>this.store.finish(job.id)).catch(e=>{
        const finished=!!this.store.db.prepare('SELECT finished FROM runs WHERE id=?').get(job.id)?.finished;
        const beforeAgent=!this.store.db.prepare('SELECT 1 FROM runs WHERE id=?').get(job.id);
        const retryable=(this.config.backend==='dot' || finished || beforeAgent) && !!e.retryable && (!e.uncertain || e.safeRetry);
        this.store.fail(job.id,e.code || 'processing_failed',retryable,this.config.maxAttempts);this.logger('job_failed',{id:job.id,code:e.code || 'processing_failed',retryable});
      }).finally(()=>this.active.delete(job.session_key));
      this.active.set(job.session_key,{promise,abort});
    }
  }
  async immediate(account,event) {
    if(!this.allowed(account,event.source) || event.type!=='message' || stripMentions(event.message || {})!=='/stop') return false;
    if(!addressed(account,event,this.store.isQuote(account.accountId,event.message?.quotedMessageId),this.config.channels?.defaults?.implicitMentions?.quotedBot!==false)) return false;
    const key=sessionKey(account.accountId,event.source),active=this.active.get(key);
    if(!active)return false;
    active.abort.abort();await this.backend?.interrupt(key);await this.simple(account,event,'処理の停止を要求しました。すでに完了した操作は取り消されません。');return true;
  }
  async close() {this.stopping=true;clearInterval(this.timer);clearInterval(this.housekeeping);for(const v of this.active.values())v.abort.abort();await this.backend?.close();await Promise.allSettled([...this.active.values()].map(v=>v.promise));}
}
