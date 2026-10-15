import {lineCall,lineSource} from './line.js';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const page=body=>new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ともにゃ LINE受信箱</title><style>body{font:17px/1.7 system-ui;max-width:780px;margin:40px auto;padding:20px;color:#17202a;background:#f5f7fb}article{background:white;padding:22px;margin:20px 0;border-radius:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}textarea{width:100%;min-height:100px;font:inherit;box-sizing:border-box}button{font:inherit;padding:10px 22px;margin-top:12px}small{color:#526172}code{overflow-wrap:anywhere}</style><h1>ともにゃ LINE受信箱</h1><p>承認済みの送信者との会話です。返信先は受信した会話に固定されています。</p>${body}<p><a href="/runtime/inbox">受信箱を更新</a> · <a href="/runtime/bridge">クラウド受信</a></p></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'",'x-content-type-options':'nosniff'}});
export async function cloudInbox(req,env){
 const url=new URL(req.url);
 if(req.method==='POST'){
  if(url.pathname!=='/runtime/line-reply'||req.headers.get('origin')!==url.origin)return Response.json({error:'ORIGIN_DENIED'},{status:403});
  if(!req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))return Response.json({error:'FORM_REQUIRED'},{status:415});
  const reader=req.body.getReader();let bytes=0,chunks=[];for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>64000){await reader.cancel();return Response.json({error:'TOO_LARGE'},{status:413});}chunks.push(value);}
  const raw=new Uint8Array(bytes);let at=0;for(const b of chunks){raw.set(b,at);at+=b.length;}
  const form=new URLSearchParams(new TextDecoder().decode(raw));
  if([...form.keys()].some(k=>!['event_id','content'].includes(k))||form.getAll('event_id').length!==1||form.getAll('content').length!==1)return Response.json({error:'INVALID_FORM'},{status:400});
  const result=await lineCall('line_reply',{event_id:form.get('event_id'),content:form.get('content')},env);
  return page(`<article><h2>${result.status==='completed'?'送信済み':'送信状態の確認が必要です'}</h2><p>イベント: <code>${escape(form.get('event_id'))}</code></p><p>状態: ${escape(result.status)}</p><p>${result.duplicate?'同じイベントへの重複送信は行っていません。':'同じLINE会話への返信処理を実行しました。'}</p></article>`);
 }
 if(req.method!=='GET'||url.pathname!=='/runtime/inbox')return Response.json({error:'METHOD_NOT_ALLOWED'},{status:405});
 const eventId=url.searchParams.get('event_id');
 const rows=eventId?[{event_id:eventId}]:(await env.DB.prepare('SELECT event_id FROM cloud_line_messages ORDER BY created_at DESC LIMIT 30').bind().all()).results;
 let body='';
 for(const row of rows){
  const {row:source,m}=await lineSource(env,row);
  const action=await env.DB.prepare('SELECT status FROM actions WHERE action_key=?').bind('linereply:'+row.event_id).first();
  body+=`<article aria-label="LINEイベント ${escape(row.event_id)}"><small>${escape(new Date(source.occurred_at).toISOString())}</small><p>イベント: <code>${escape(row.event_id)}</code></p><h2>受信メッセージ</h2><pre>${escape(m.text)}</pre>${action?`<p>返信状態: ${escape(action.status)}</p>`:`<form method="post" action="/runtime/line-reply"><input type="hidden" name="event_id" value="${escape(row.event_id)}"><label>同じ会話への返信<textarea name="content" required maxlength="5000"></textarea></label><button type="submit">LINEへ返信</button></form>`}</article>`;
 }
 return page(body||'<p>まだメッセージを受信していません。</p>');
}
