import { readFileSync, writeFileSync, existsSync, lstatSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

export const LINE_SETUP = `LINE — Setup
1. LINE Business IDを登録し、LINE公式アカウントを作成します。
   LINE Official Account Managerで対象アカウントを開きます。
   https://manager.line.biz/
2. Official Account Managerの 設定 → Messaging API で利用を有効にします。
   Messaging API channelが作成されます。
3. 管理するProviderを作成または選択します。
   選択後はProviderを変更・解除できません。
4. 同じBusiness IDでLINE Developers Consoleを開き、選んだProviderのchannelを開きます。
   https://developers.line.biz/console/
   Basic settingsのChannel secretと、Messaging APIタブのChannel access tokenを取得します。
5. Webhook URLにGatewayのHTTPS endpointを設定します。
   https://gateway-host/line/webhook
   Gateway起動後にVerifyの成功を確認し、Use webhookを有効にします。
6. 応答メッセージとあいさつメッセージは標準で有効です。
   Official Account Managerで無効にするとBotの返信を確認しやすくなります。

Configure: channels.line.dmPolicy は pairing が標準です。
不明な送信者にはペアリングコードを返し、承認までAIへ渡しません。`;

export function saveEnvValues(path,values) {
  const target=resolve(path);
  if(existsSync(target) && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()))throw new Error('Env file must be a regular file');
  let content=existsSync(target)?readFileSync(target,'utf8'):'';
  for(const [key,value] of Object.entries(values)) {
    if(!/^[A-Z][A-Z0-9_]+$/.test(key) || typeof value!=='string' || /[\r\n\x00]/.test(value))throw new Error('Invalid environment setting');
    const line=`${key}=${JSON.stringify(value)}`,pattern=new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`,'m');
    content=pattern.test(content)?content.replace(pattern,()=>line):content.replace(/\n?$/,'\n')+line+'\n';
  }
  writeFileSync(target,content,{mode:0o600});
  chmodSync(target,0o600);
}
export function promptTerminal(label,{secret=false,input=process.stdin,output=process.stdout}={}) {
  if(!input.isTTY || !output.isTTY)throw new Error('Interactive setup requires a terminal. Configure .env privately instead.');
  const wasRaw=!!input.isRaw;input.setRawMode(true);output.write(label);input.resume();
  return new Promise((resolve,reject)=>{
    let value='';
    const done=error=>{input.off('data',onData);input.setRawMode(wasRaw);input.pause();output.write('\n');error?reject(error):resolve(value.trim());};
    const onData=data=>{
      for(const char of data.toString('utf8')) {
        if(char==='\x03'){done(new Error('Setup canceled'));return;}
        if(char==='\r' || char==='\n'){done();return;}
        if(char==='\x7f' || char==='\b'){if(value){value=value.slice(0,-1);if(!secret)output.write('\b \b');}continue;}
        if(char<' ' || char==='\x1b')continue;
        if(value.length>=5000){done(new Error('Input is too long'));return;}
        value+=char;if(!secret)output.write(char);
      }
    };
    input.on('data',onData);
  });
}
export async function configureLine({envPath='.env',ask=promptTerminal,write=console.log}={}) {
  write(LINE_SETUP);
  const token=await ask('Channel access token (入力は表示されません): ',{secret:true});
  const secret=await ask('Channel secret (入力は表示されません): ',{secret:true});
  if(!token || !secret)throw new Error('Channel access token and Channel secret are required');
  saveEnvValues(envPath,{LINE_CHANNEL_ACCESS_TOKEN:token,LINE_CHANNEL_SECRET:secret});
  write('LINE channelを設定しました。トークンとシークレットは表示しません。');
  write('Access control:\n  codex-line-bridge pairing list line\n  codex-line-bridge pairing approve line <CODE>');
}
export const DISCORD_SETUP = `Discord — Setup
1. Discord Developer PortalでApplicationを作成し、Botを追加します。
   https://discord.com/developers/applications
2. BotのPrivileged Gateway IntentsでMessage Content Intentを有効にします。
   メンバー情報を使う場合はServer Members Intentも有効にします。
3. Bot tokenを取得します（入力は表示しません）。
4. OAuth2 URL Generatorでbotとapplications.commandsを選び、必要な権限を付けます。
5. Botをサーバーに招待し、Developer ModeでUser/Server/Channel IDを確認します。
6. DMを送り、ペアリングを承認します。

Discord Gatewayは外向きWebSocketで接続します。公開Webhook URLは不要です。`;
export async function configureDiscord({envPath='.env',configPath='bridge.config.json',ask=promptTerminal,write=console.log}={}) {
  write(DISCORD_SETUP);const token=await ask('Bot token (入力は表示されません): ',{secret:true});
  if(!token)throw new Error('Discord Bot token is required');
  const raw=JSON.parse(readFileSync(configPath,'utf8'));
  if(lstatSync(configPath).isSymbolicLink() || !lstatSync(configPath).isFile())throw new Error('Configuration must be a regular file');
  raw.channels ??= {};raw.channels.discord={dmPolicy:'pairing',groupPolicy:'allowlist',guilds:{},...raw.channels.discord,enabled:true};
  if(raw.channels.discord.accounts){raw.channels.discord.accounts.default={...raw.channels.discord.accounts.default,token:{source:'env',provider:'default',id:'DISCORD_BOT_TOKEN'}};delete raw.channels.discord.accounts.default.tokenFile;}
  else {raw.channels.discord.token={source:'env',provider:'default',id:'DISCORD_BOT_TOKEN'};delete raw.channels.discord.tokenFile;}
  saveEnvValues(envPath,{DISCORD_BOT_TOKEN:token});
  writeFileSync(configPath,JSON.stringify(raw,null,2)+'\n',{mode:0o600});chmodSync(configPath,0o600);
  write('Discord Botを設定しました。トークンは表示しません。');
  write('Access control:\n  codex-line-bridge pairing list discord\n  codex-line-bridge pairing approve discord <CODE>');
}
