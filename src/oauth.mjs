import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const hash = s => createHash('sha256').update(s).digest('hex');
const random = () => randomBytes(32).toString('base64url');
export function equalSecret(a,b) {
  if(typeof a!=='string' || typeof b!=='string' || !a || !b) return false;
  return timingSafeEqual(Buffer.from(hash(a),'hex'),Buffer.from(hash(b),'hex'));
}
const escape = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const scopes = ['line:read','line:write','discord:read','discord:write','events:subscribe'];
const safeRedirect = raw => {
  try {const u=new URL(raw);return !u.username && !u.password && !u.hash && (u.protocol==='https:' || (u.protocol==='http:' && ['127.0.0.1','[::1]','localhost'].includes(u.hostname)));} catch {return false;}
};
export class OAuth {
  constructor(store,config) {
    this.db=store.db;this.config=config;this.pending=new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS oauth_clients(id TEXT PRIMARY KEY, data TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS oauth_codes(hash TEXT PRIMARY KEY, client_id TEXT, redirect_uri TEXT, challenge TEXT, scope TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS oauth_tokens(hash TEXT PRIMARY KEY, client_id TEXT, scope TEXT, kind TEXT, family TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS oauth_used_refresh(hash TEXT PRIMARY KEY, client_id TEXT, family TEXT, expires INTEGER);`);
  }
  authenticate(req) {
    const bearer=/^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1];
    if (equalSecret(bearer,this.config.mcp.token)) return {principal:'owner',scopes};
    if (!bearer) return null;
    const row=this.db.prepare("SELECT scope FROM oauth_tokens WHERE hash=? AND kind='access' AND expires>?").get(hash(bearer),Date.now());
    return row ? {principal:'owner',scopes:row.scope.split(' ')} : null;
  }
  json(res,status,data) {res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));}
  error(res,error='invalid_request',status=400) {this.json(res,status,{error});}
  cleanup() {
    for(const [id,v] of this.pending) if(v.expires<Date.now()) this.pending.delete(id);
    this.db.prepare('DELETE FROM oauth_codes WHERE expires<?').run(Date.now());
    this.db.prepare('DELETE FROM oauth_tokens WHERE expires<?').run(Date.now());
    this.db.prepare('DELETE FROM oauth_used_refresh WHERE expires<?').run(Date.now());
    // A connected ChatGPT client reuses its client_id on later consent requests.
    // Keep registrations valid until an operator explicitly removes the connection.
  }
  async handle(req,res,url,readBody) {
    this.cleanup();
    const origin=this.config.publicUrl;
    if(url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      this.json(res,200,{resource:`${origin}/mcp`,authorization_servers:[origin],scopes_supported:scopes,bearer_methods_supported:['header']});return true;
    }
    if(url.pathname==='/.well-known/oauth-authorization-server' || url.pathname==='/.well-known/openid-configuration') {
      this.json(res,200,{issuer:origin,authorization_endpoint:`${origin}/oauth/authorize`,token_endpoint:`${origin}/oauth/token`,registration_endpoint:`${origin}/oauth/register`,revocation_endpoint:`${origin}/oauth/revoke`,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:scopes});return true;
    }
    if(!url.pathname.startsWith('/oauth/')) return false;
    if(!origin || !this.config.ownerSecret) {this.error(res,'temporarily_unavailable',503);return true;}
    if(url.pathname==='/oauth/register' && req.method==='POST') {
      let body; try {body=JSON.parse((await readBody(req,16384)).toString());} catch {this.error(res);return true;}
      if(!Array.isArray(body.redirect_uris) || !body.redirect_uris.length || body.redirect_uris.length>10 || !body.redirect_uris.every(safeRedirect) || (body.token_endpoint_auth_method && body.token_endpoint_auth_method!=='none')) {this.error(res,'invalid_client_metadata');return true;}
      if(this.db.prepare('SELECT COUNT(*) n FROM oauth_clients').get().n>=1000) {this.error(res,'temporarily_unavailable',429);return true;}
      const id=random(), data={client_id:id,client_name:String(body.client_name || 'ChatGPT').slice(0,100),redirect_uris:body.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']};
      this.db.prepare('INSERT INTO oauth_clients VALUES(?,?,?)').run(id,JSON.stringify(data),Date.now());this.json(res,201,data);return true;
    }
    if(url.pathname==='/oauth/authorize' && req.method==='GET') {
      const p=Object.fromEntries(url.searchParams),client=this.db.prepare('SELECT data FROM oauth_clients WHERE id=?').get(p.client_id || '');
      if(!client || !JSON.parse(client.data).redirect_uris.includes(p.redirect_uri) || p.response_type!=='code' || p.code_challenge_method!=='S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge || '') || (p.resource && p.resource!==`${origin}/mcp`)) {this.error(res);return true;}
      p.scope=p.scope || scopes.join(' ');
      if(p.scope.split(' ').some(s=>!scopes.includes(s))) {this.error(res,'invalid_scope');return true;}
      if(this.pending.size>=100) {this.error(res,'temporarily_unavailable',429);return true;}
      const id=random(),csrf=random();this.pending.set(id,{...p,csrf,expires:Date.now()+300000});
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'",'x-frame-options':'DENY','set-cookie':`bridge_consent=${id}; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=300`});
      const labels={'line:read':'LINE会話の閲覧','line:write':'LINEへの返信','discord:read':'Discord会話の閲覧','discord:write':'Discordへの返信','events:subscribe':'新着イベントの購読'};
      res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>AI秘書ブリッジ 接続承認</title><h1>AI秘書ブリッジへの接続</h1><p>${escape(JSON.parse(client.data).client_name)} に、許可済みの会話について次の権限を与えます。</p><ul>${p.scope.split(' ').map(s=>`<li>${escape(labels[s])} (${escape(s)})</li>`).join('')}</ul><form method="post" action="/oauth/consent"><input type="hidden" name="csrf" value="${csrf}"><label>管理者の接続パスフレーズ <input type="password" name="owner_secret" required autocomplete="current-password"></label><button name="decision" value="accept">接続を許可</button><button name="decision" value="deny">キャンセル</button></form></html>`);return true;
    }
    if(url.pathname==='/oauth/consent' && req.method==='POST') {
      const id=/(?:^|;\s*)bridge_consent=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '')?.[1],p=this.pending.get(id);
      const body=new URLSearchParams((await readBody(req,8192)).toString());
      if(!p || !['accept','deny'].includes(body.get('decision')) || !equalSecret(body.get('csrf'),p.csrf) || (req.headers.origin && req.headers.origin!==origin)) {this.error(res,'access_denied',403);return true;}
      if(body.get('decision')!=='deny' && !equalSecret(body.get('owner_secret'),this.config.ownerSecret)) {this.pending.delete(id);this.error(res,'access_denied',403);return true;}
      this.pending.delete(id);const redirect=new URL(p.redirect_uri);
      if(body.get('decision')==='deny') redirect.searchParams.set('error','access_denied');
      else {const code=random();this.db.prepare('INSERT INTO oauth_codes VALUES(?,?,?,?,?,?)').run(hash(code),p.client_id,p.redirect_uri,p.code_challenge,p.scope,Date.now()+60000);redirect.searchParams.set('code',code);}
      if(p.state) redirect.searchParams.set('state',p.state);
      res.writeHead(302,{location:redirect.href,'cache-control':'no-store','set-cookie':'bridge_consent=; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=0'});res.end();return true;
    }
    if(url.pathname==='/oauth/token' && req.method==='POST') {
      const p=Object.fromEntries(new URLSearchParams((await readBody(req,16384)).toString()));
      if(p.resource && p.resource!==`${origin}/mcp`) {this.error(res,'invalid_target');return true;}
      let scope,family=random();
      if(p.grant_type==='authorization_code') {
        const row=this.db.prepare('SELECT * FROM oauth_codes WHERE hash=? AND expires>?').get(hash(p.code || ''),Date.now());
        const challenge=createHash('sha256').update(p.code_verifier || '').digest('base64url');
        if(!row || p.client_id!==row.client_id || p.redirect_uri!==row.redirect_uri || !/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier || '') || !equalSecret(challenge,row.challenge)) {this.error(res,'invalid_grant');return true;}
        this.db.prepare('DELETE FROM oauth_codes WHERE hash=?').run(row.hash);scope=row.scope;
      } else if(p.grant_type==='refresh_token') {
        const used=this.db.prepare('SELECT * FROM oauth_used_refresh WHERE hash=?').get(hash(p.refresh_token || ''));
        if(used && used.client_id===p.client_id) {this.db.prepare('DELETE FROM oauth_tokens WHERE family=?').run(used.family);await this.onRevoke?.();this.error(res,'invalid_grant');return true;}
        const row=this.db.prepare("SELECT * FROM oauth_tokens WHERE hash=? AND kind='refresh' AND expires>?").get(hash(p.refresh_token || ''),Date.now());
        if(!row || p.client_id!==row.client_id) {this.error(res,'invalid_grant');return true;}
        scope=row.scope;family=row.family;this.db.prepare('INSERT INTO oauth_used_refresh VALUES(?,?,?,?)').run(row.hash,row.client_id,row.family,row.expires);this.db.prepare('DELETE FROM oauth_tokens WHERE family=?').run(family);
      } else {this.error(res,'unsupported_grant_type');return true;}
      const access=random(),refresh=random();
      this.db.prepare('INSERT INTO oauth_tokens VALUES(?,?,?,?,?,?)').run(hash(access),p.client_id,scope,'access',family,Date.now()+3600000);
      this.db.prepare('INSERT INTO oauth_tokens VALUES(?,?,?,?,?,?)').run(hash(refresh),p.client_id,scope,'refresh',family,Date.now()+30*86400000);
      this.json(res,200,{access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope});return true;
    }
    if(url.pathname==='/oauth/revoke' && req.method==='POST') {
      const p=new URLSearchParams((await readBody(req,8192)).toString()),row=this.db.prepare('SELECT family,client_id FROM oauth_tokens WHERE hash=?').get(hash(p.get('token') || ''));
      if(row && p.get('client_id')===row.client_id) {this.db.prepare('DELETE FROM oauth_tokens WHERE family=?').run(row.family);await this.onRevoke?.();}
      this.json(res,200,{});return true;
    }
    this.error(res,'invalid_request',404);return true;
  }
}
