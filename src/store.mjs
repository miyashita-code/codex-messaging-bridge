import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomInt } from 'node:crypto';

export class Store {
  constructor(path) {
    if (path!==':memory:') mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    if (path!==':memory:') chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, session_key TEXT NOT NULL, event TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, created INTEGER NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status,due);
      CREATE TABLE IF NOT EXISTS sessions(key TEXT PRIMARY KEY, account_id TEXT, conversation_id TEXT, user_id TEXT, type TEXT, thread_id TEXT, updated INTEGER);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, session_key TEXT, data TEXT NOT NULL, created INTEGER);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, text TEXT, finished INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pairings(account_id TEXT, user_id TEXT, code TEXT UNIQUE, expires INTEGER, approved INTEGER DEFAULT 0, PRIMARY KEY(account_id,user_id));
      CREATE TABLE IF NOT EXISTS outbound(key TEXT PRIMARY KEY, message_id TEXT, messages TEXT, status TEXT, cursor INTEGER DEFAULT 0, receipts TEXT DEFAULT '[]', updated INTEGER);
      CREATE TABLE IF NOT EXISTS quotes(account_id TEXT, message_id TEXT, created INTEGER, PRIMARY KEY(account_id,message_id));
      CREATE TABLE IF NOT EXISTS introductions(account_id TEXT, conversation_id TEXT, PRIMARY KEY(account_id,conversation_id));`);
  }
  recoverProcessing() {
    for(const job of this.db.prepare("SELECT id,event FROM jobs WHERE status='processing'").all()) {
      const run=this.db.prepare('SELECT finished FROM runs WHERE id=?').get(job.id),event=JSON.parse(job.event);
      const discord=!!(event.channel_id && event.author?.id),isMessage=(event.type==='message' || discord) && !event.bridge_control && !/^\/(approve|deny|answer|stop|help|new|reset)\b/.test(discord?event.content || '':event.message?.text || '');
      const safe=!!run?.finished || (!run && isMessage && !this.db.prepare('SELECT session_key FROM jobs WHERE id=?').get(job.id).session_key.endsWith(':control'));
      this.db.prepare('UPDATE jobs SET status=?,error=?,due=? WHERE id=?').run(safe?'pending':'dead',safe?null:'restart_during_processing_requires_review',Date.now(),job.id);
    }
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try {const r=fn();this.db.exec('COMMIT');return r;} catch(e){this.db.exec('ROLLBACK');throw e;} }
  enqueue(accountId,key,event,id) {
    return this.db.prepare('INSERT OR IGNORE INTO jobs(id,account_id,session_key,event,due,created) VALUES(?,?,?,?,?,?)').run(id,accountId,key,JSON.stringify(event),Date.now(),Date.now()).changes>0;
  }
  pending(limit=32,{channel}={}) {
    const provider=channel==='line'?"AND account_id NOT LIKE 'discord:%'":channel==='discord'?"AND account_id LIKE 'discord:%'":'';
    return this.db.prepare(`SELECT j.* FROM jobs j WHERE status='pending' AND due<=? ${provider} AND NOT EXISTS(SELECT 1 FROM jobs older WHERE older.session_key=j.session_key AND older.status IN ('pending','processing') AND older.rowid<j.rowid) ORDER BY CASE WHEN session_key LIKE '%:control' THEN 0 ELSE 1 END, rowid LIMIT ?`).all(Date.now(),limit);
  }
  claim(id) {return this.db.prepare("UPDATE jobs SET status='processing', attempts=attempts+1 WHERE id=? AND status='pending'").run(id).changes>0;}
  finish(id) {this.db.prepare("UPDATE jobs SET status='done',error=NULL WHERE id=?").run(id);}
  fail(id,code,retryable,maxAttempts,retryAfterMs=0) {
    const j=this.db.prepare('SELECT attempts FROM jobs WHERE id=?').get(id);
    this.db.prepare('UPDATE jobs SET status=?,error=?,due=? WHERE id=?').run(retryable && j.attempts<maxAttempts?'pending':'dead',code,Date.now()+Math.max(Math.min(300000,1000*2**j.attempts),Math.min(3600000,Number(retryAfterMs) || 0)),id);
  }
  paired(accountId,userId) {return !!this.db.prepare('SELECT 1 FROM pairings WHERE account_id=? AND user_id=? AND approved=1').get(accountId,userId);}
  pairing(accountId,userId) {
    this.db.prepare('DELETE FROM pairings WHERE approved=0 AND expires<?').run(Date.now());
    const old=this.db.prepare('SELECT * FROM pairings WHERE account_id=? AND user_id=?').get(accountId,userId);
    if (old) return {code:old.code,created:false};
    if (this.db.prepare('SELECT COUNT(*) n FROM pairings WHERE account_id=? AND approved=0').get(accountId).n>=3) return {created:false};
    const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code;
    do {code=Array.from({length:8},()=>chars[randomInt(chars.length)]).join('');} while(this.db.prepare('SELECT 1 FROM pairings WHERE code=?').get(code));
    this.db.prepare('INSERT INTO pairings(account_id,user_id,code,expires) VALUES(?,?,?,?)').run(accountId,userId,code,Date.now()+3600000);
    return {code,created:true};
  }
  approve(code) {return this.db.prepare('UPDATE pairings SET approved=1 WHERE code=? AND expires>? AND approved=0 RETURNING account_id,user_id').get(code,Date.now());}
  revoke(accountId,userId) {return this.db.prepare('DELETE FROM pairings WHERE account_id=? AND user_id=?').run(accountId,userId).changes>0;}
  session(key) {return this.db.prepare('SELECT * FROM sessions WHERE key=?').get(key);}
  saveSession(key,accountId,source) {
    this.db.prepare(`INSERT INTO sessions(key,account_id,conversation_id,user_id,type,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET user_id=excluded.user_id,updated=excluded.updated`).run(key,accountId,source.groupId || source.roomId || source.userId,source.userId,source.type,Date.now());
  }
  saveThread(key,id) {this.db.prepare('UPDATE sessions SET thread_id=? WHERE key=?').run(id,key);}
  saveMessage(key,message) {this.db.prepare('INSERT OR IGNORE INTO inbox(id,session_key,data,created) VALUES(?,?,?,?)').run(message.id,key,JSON.stringify(message),Date.now());}
  message(id) {const r=this.db.prepare('SELECT data FROM inbox WHERE id=?').get(id);return r && JSON.parse(r.data);}
  rememberQuotes(accountId,receipt) {
    for(const m of receipt?.sentMessages || []) if(m.id) this.db.prepare('INSERT OR IGNORE INTO quotes VALUES(?,?,?)').run(accountId,m.id,Date.now());
    this.db.prepare('DELETE FROM quotes WHERE account_id=? AND message_id NOT IN (SELECT message_id FROM quotes WHERE account_id=? ORDER BY created DESC LIMIT 400)').run(accountId,accountId);
  }
  isQuote(accountId,id) {return !!id && !!this.db.prepare('SELECT 1 FROM quotes WHERE account_id=? AND message_id=?').get(accountId,id);}
  close() {this.db.close();}
}
