#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { Store } from './store.mjs';
import { CodexBackend } from './codex.mjs';
import { startServer } from './server.mjs';
import { LineClient } from './line.mjs';
import { DiscordClient } from './discord.mjs';
import { DiscordBridge } from './discord-bridge.mjs';
import { Bridge } from './bridge.mjs';
import { configureLine,LINE_SETUP,configureDiscord,DISCORD_SETUP } from './onboarding.mjs';
import { checkCloudRuntime } from './cloud-check.mjs';

const args=process.argv.slice(2),ci=args.indexOf('--config');let configPath='bridge.config.json';
if(ci>=0){configPath=args[ci+1];args.splice(ci,2);if(!configPath)throw new Error('--config needs a path');}
const command=args[0] || 'help';
let pairingChannel='line';if(command==='pairing' && ['line','discord'].includes(args[2])){pairingChannel=args[2];args.splice(2,1);}
const option=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
async function main() {
  if(command==='cloud-check'){const result=await checkCloudRuntime({probe:args.includes('--probe')});console.log(JSON.stringify(result,null,2));if(!result.webSocket || (args.includes('--probe') && !result.discordWss))process.exitCode=1;return;}
  if(command==='channels' && args[1]==='add') {const channel=option('--channel') || 'line';if(channel==='discord')await configureDiscord({configPath});else if(channel==='line')await configureLine();else throw new Error('Channel must be line or discord');return;}
  if(command==='onboard' || (command==='channels' && args[1]==='setup')){console.log(option('--channel')==='discord'?DISCORD_SETUP:LINE_SETUP);return;}
  if(command==='init') {
    const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
    if(existsSync(configPath))throw new Error('Configuration already exists');
    writeFileSync(configPath,readFileSync(join(root,'bridge.config.example.json')),{flag:'wx',mode:0o600});
    if(!existsSync('.env'))writeFileSync('.env',`LINE_CHANNEL_ACCESS_TOKEN=\nLINE_CHANNEL_SECRET=\nDISCORD_BOT_TOKEN=\nLINE_BRIDGE_OWNER_SECRET=${randomBytes(32).toString('base64url')}\nLINE_BRIDGE_MCP_TOKEN=${randomBytes(32).toString('base64url')}\nLINE_BRIDGE_PUBLIC_URL=\n`,{flag:'wx',mode:0o600});
    console.log(JSON.stringify({created:resolve(configPath),envFile:resolve('.env'),next:'Set LINE credentials and public HTTPS URL privately in .env, then npm run doctor.'}));return;
  }
  if(command==='help') {console.log('codex-line-bridge init | onboard --channel line|discord | channels add --channel line|discord | channels status --probe | channels commands --channel discord | gateway | gateway status | doctor | pairing list line|discord | pairing approve line|discord CODE | pairing revoke line|discord ACCOUNT USER | queue list | queue retry ID | inbox list --channel discord | inbox read ID | inbox reply ID --text TEXT --idempotency-key KEY\nUse --config PATH to select configuration.');return;}
  const config=loadConfig(configPath);
  if(command==='directory' && ['peers','groups'].includes(args[1]) && args[2]==='list') {
    const get=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
    if(get('--channel')==='discord') {
      const a=config.discordAccounts.find(a=>a.accountId===(get('--account') || 'default'));if(!a)throw new Error('Discord account not found');
      const ids=args[1]==='groups'?Object.keys(a.guilds):[...a.allowFrom,...Object.values(a.guilds || {}).flatMap(g=>[...(g.users || []),...Object.values(g.channels || {}).flatMap(c=>c.users || [])])];
      const entries=[...new Set(ids.map(id=>id.replace(/^discord:/,'').replace(/^(user|guild):/,'').replace(/^<@!?(\d+)>$/,'$1')))].filter(id=>/^\d+$/.test(id));console.log(args.includes('--json')?JSON.stringify(entries,null,2):entries.join('\n'));return;
    }
    if(get('--channel') && get('--channel')!=='line')throw new Error('Channel must be line or discord');
    const account=config.accounts.find(a=>a.accountId===(get('--account') || 'default'));if(!account)throw new Error('Account not found');
    const ids=args[1]==='groups'?Object.keys(account.groups || {}):[...account.allowFrom,...account.groupAllowFrom,...Object.values(account.groups || {}).flatMap(g=>g.allowFrom || [])];
    const query=get('--query') || '',limit=Number(get('--limit') || 100);if(!Number.isInteger(limit) || limit<1 || limit>1000)throw new Error('Invalid limit');
    const entries=[...new Set(ids.map(id=>id.replace(/^line:/,'')))].filter(id=>new RegExp(args[1]==='groups'?'^[CR][a-f0-9]{32}$':'^U[a-f0-9]{32}$').test(id) && id.includes(query)).slice(0,limit);
    console.log(args.includes('--json')?JSON.stringify(entries,null,2):entries.join('\n'));return;
  }
  if(command==='doctor' || (command==='channels' && args[1]==='status')) {
    const checks={node:process.version,backend:config.backend,transport:config.transport,line:config.accounts.map(a=>({accountId:a.accountId,tokenPresent:!!a.channelAccessToken,secretPresent:!!a.channelSecret,webhookPath:a.webhookPath})),discord:config.discordAccounts.map(a=>({accountId:a.accountId,tokenPresent:!!a.token,messageContentIntent:a.intents.messageContent,guildMembersIntent:a.intents.guildMembers})),httpsConfigured:!!config.publicUrl,oauthOwnerSecretPresent:!!config.ownerSecret,mcpTestTokenPresent:!!config.mcp.token};
    if(config.backend==='codex') {mkdirSync(config.codex.cwd,{recursive:true,mode:0o700});const backend=new CodexBackend(config.codex);try{checks.codex=await backend.health();}catch(e){checks.codex={ok:false,code:e.code || 'not_available'};}finally{await backend.close();}}
    if(args.includes('--probe'))for(const account of config.accounts){const status=checks.line.find(a=>a.accountId===account.accountId);if(!status.tokenPresent || !status.secretPresent){status.probe={ok:false,code:'credentials_missing'};continue;}try{const client=new LineClient(account),info=await client.botInfo();status.probe={ok:true,displayName:info.displayName};const hook=await client.webhookInfo();status.webhook={endpoint:hook.endpoint,active:hook.active};}catch(e){status.probe={ok:false,code:e.code || 'line_unavailable',status:e.status};}}
    if(args.includes('--probe'))for(const a of config.discordAccounts){const status=checks.discord.find(s=>s.accountId===a.accountId);if(!a.token){status.probe={ok:false,code:'credentials_missing'};continue;}try{const client=new DiscordClient(a),bot=await client.botInfo(),app=await client.applicationInfo();status.probe={ok:true,botId:bot.id,username:bot.username,applicationId:app.id,applicationFlags:app.flags};}catch(e){status.probe={ok:false,code:e.code || 'discord_unavailable',status:e.status};}}
    const probesReady=!args.includes('--probe') || [...checks.line,...checks.discord].every(a=>a.probe?.ok===true);
    checks.ready=checks.line.every(a=>a.tokenPresent && a.secretPresent) && checks.discord.every(a=>a.tokenPresent) && probesReady && (config.backend==='codex'?checks.codex?.authenticated:config.backend==='inbox'?true:checks.httpsConfigured && checks.oauthOwnerSecretPresent);
    console.log(JSON.stringify(checks,null,2));if(!checks.ready)process.exitCode=1;return;
  }
  if(command==='channels' && args[1]==='commands') {
    if(option('--channel')!=='discord')throw new Error('Native command synchronization is supported for Discord');
    const a=config.discordAccounts.find(a=>a.accountId===(option('--account') || 'default'));if(!a?.token)throw new Error('Discord credentials are missing');
    const client=new DiscordClient(a),application=await client.applicationInfo(),commands=[['help','AI秘書の使い方'],['status','AI秘書の接続状態'],['new','新しい会話'],['stop','実行中のCodex処理を停止']].map(([name,description])=>({type:1,name,description}));
    const result=await client.registerCommands(application.id,commands,option('--guild'));console.log(JSON.stringify({channel:'discord',applicationId:application.id,registered:result.length ?? commands.length}));return;
  }
  if(command==='gateway' && args[1]==='status') {let running=false;try{const pid=Number(readFileSync(join(config.dataDir,'bridge.pid'),'utf8'));if(Number.isInteger(pid) && pid>0){process.kill(pid,0);running=true;}}catch{}console.log(JSON.stringify({running,backend:config.backend,transport:config.transport}));return;}
  if(command==='start' || command==='gateway') {
    if(config.accounts.some(a=>!a.channelAccessToken || !a.channelSecret))throw new Error('LINE credentials are missing; run doctor');
    if(config.discordAccounts.some(a=>!a.token))throw new Error('Discord credentials are missing; run doctor');
    if(config.backend==='dot' && (!config.publicUrl || !config.ownerSecret))throw new Error('Your dot mode requires publicUrl and LINE_BRIDGE_OWNER_SECRET');
    const app=await startServer(config);let closing=false;const stop=()=>{if(closing)return;closing=true;app.close().then(()=>process.exit(0));};process.on('SIGTERM',stop);process.on('SIGINT',stop);return;
  }
  const store=new Store(join(config.dataDir,'bridge.sqlite'));
  try {
    if(command==='inbox') {
      const channel=option('--channel') || (args[2]?.startsWith('discord:')?'discord':'line'),bridge=channel==='discord'?new DiscordBridge({config,store}):new Bridge({config,store});
      if(args[1]==='list')console.log(JSON.stringify(bridge.listInbox({conversationId:option('--conversation'),limit:Number(option('--limit') || 20)}),null,2));
      else if(args[1]==='read') {const m=bridge.readMessage(args[2]);if(args.includes('--local-media'))m.localMediaPaths=store.message(args[2])?.mediaPaths || [store.message(args[2])?.mediaPath].filter(Boolean);console.log(JSON.stringify(m,null,2));}
      else if(args[1]==='reply') {const path=option('--text-file'),text=path?readFileSync(resolve(path),'utf8'):option('--text');if(text===undefined)throw new Error('Supply --text or --text-file');console.log(JSON.stringify(await bridge.sendReply({messageId:args[2],text,idempotencyKey:option('--idempotency-key')}),null,2));}
      else throw new Error('Use inbox list, read or reply');return;
    }
    if(command==='pairing' && args[1]==='list') console.log(JSON.stringify(store.db.prepare('SELECT account_id,user_id,code,expires,approved FROM pairings ORDER BY expires DESC').all().filter(p=>pairingChannel==='discord'?p.account_id.startsWith('discord:'):!p.account_id.startsWith('discord:')),null,2));
    else if(command==='pairing' && args[1]==='approve') {const p=store.db.prepare('SELECT account_id FROM pairings WHERE code=?').get(args[2] || '');if(!p || (pairingChannel==='discord')!==p.account_id.startsWith('discord:'))throw new Error('Pairing code does not belong to this channel');const approved=store.approve(args[2] || '');if(!approved)throw new Error('Pairing code is missing, expired or already approved');console.log(JSON.stringify({approved:true,...approved}));}
    else if(command==='pairing' && args[1]==='revoke') {if(!args[2] || !args[3])throw new Error('Specify ACCOUNT USER');const account=pairingChannel==='discord'?`discord:${args[2]}`:args[2];console.log(JSON.stringify({revoked:store.revoke(account,args[3])}));}
    else if(command==='queue' && args[1]==='list') console.log(JSON.stringify(store.db.prepare('SELECT id,account_id,status,attempts,error,created FROM jobs WHERE status!=\'done\' ORDER BY created LIMIT 100').all(),null,2));
    else if(command==='queue' && args[1]==='retry') {
      const id=args[2],run=store.db.prepare('SELECT * FROM runs WHERE id=?').get(id || '');
      if(run && !run.finished)throw new Error('This agent may have executed tools. Review the Codex thread and start a new LINE request; automatic replay is blocked.');
      const changed=store.db.prepare("UPDATE jobs SET status='pending',attempts=0,due=? WHERE id=? AND status='dead'").run(Date.now(),id || '').changes;
      if(!changed)throw new Error('No dead-letter job with that ID');console.log(JSON.stringify({retryQueued:id}));
    } else throw new Error('Unknown command. Run help.');
  }finally{store.close();}
}
main().catch(e=>{console.error(JSON.stringify({error:e.code || e.message}));process.exitCode=1;});
