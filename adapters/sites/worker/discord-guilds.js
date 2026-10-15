// Additional guilds are explicit, bounded opt-ins. The original guild remains
// the primary identity for existing DMs, companion intake and encrypted history.
const ID=/^[0-9]{17,20}$/;
const BASE=Symbol('discord-guild-base');
const SCOPE=Symbol('discord-guild-scope');
const KEYS=new Set(['guild_id','label','allowed_channel_ids','poll_channel_ids','since','enabled']);
export class DiscordGuildConfigError extends Error{constructor(code='DISCORD_GUILDS_INVALID',status=503){super(code);this.code=code;this.status=status;}}
const invalid=()=>{throw new DiscordGuildConfigError();};
const base=env=>env?.[BASE]||env;
export const discordPrimaryGuildId=env=>base(env)?.DISCORD_GUILD_ID;
export const discordGuildScope=env=>env?.[SCOPE]||null;
function ids(value){if(!Array.isArray(value)||!value.length||value.length>10||value.some(id=>typeof id!=='string'||!ID.test(id))||new Set(value).size!==value.length)invalid();return [...value];}
export function discordGuildProfiles(env){
 const root=base(env),primary=root.DISCORD_GUILD_ID;
 const legacy={guild_id:primary,label:'',allowed_channel_ids:(root.DISCORD_ALLOWED_CHANNEL_IDS||'').split(',').map(x=>x.trim()).filter(Boolean),poll_channel_ids:(root.DISCORD_POLL_CHANNEL_IDS||'').split(',').filter(Boolean),since_ms:Date.parse(root.DISCORD_CLOUD_SINCE||''),enabled:true,is_primary:true};
 const raw=root.DISCORD_GUILDS_JSON;if(raw===undefined||raw==='')return [legacy];
 if(typeof raw!=='string'||raw.length>32768)invalid();
 let values;try{values=JSON.parse(raw);}catch{invalid();}
 if(!Array.isArray(values)||values.length>4)invalid();
 const guilds=new Set([primary]),channels=new Set([...legacy.allowed_channel_ids,...legacy.poll_channel_ids]),profiles=[legacy];
 for(const value of values){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!KEYS.has(k))||typeof value.guild_id!=='string'||!ID.test(value.guild_id)||guilds.has(value.guild_id)||value.label!==undefined&&(typeof value.label!=='string'||value.label.length>80)||value.enabled!==undefined&&typeof value.enabled!=='boolean')invalid();
  const allowed=ids(value.allowed_channel_ids),poll=ids(value.poll_channel_ids);
  if(poll.some(id=>!allowed.includes(id))||allowed.some(id=>channels.has(id)))invalid();
  const since=typeof value.since==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value.since)?Date.parse(value.since):NaN;
  const parts=typeof value.since==='string'?/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)/.exec(value.since):null;
  const calendar=parts?new Date(Date.UTC(...[Number(parts[1]),Number(parts[2])-1,...parts.slice(3).map(Number)])):null;
  if(!Number.isSafeInteger(since)||since<1420070400000||!calendar||calendar.getUTCFullYear()!==Number(parts[1])||calendar.getUTCMonth()!==Number(parts[2])-1||calendar.getUTCDate()!==Number(parts[3])||Number(parts[4])>23||Number(parts[5])>59||Number(parts[6])>59)invalid();
  guilds.add(value.guild_id);for(const id of allowed)channels.add(id);
  if(value.enabled!==false)profiles.push({guild_id:value.guild_id,label:value.label||'',allowed_channel_ids:allowed,poll_channel_ids:poll,since_ms:since,enabled:true,is_primary:false});
 }
 return profiles;
}
export function discordGuildProfile(env,guildId=discordPrimaryGuildId(env)){return discordGuildProfiles(env).find(profile=>profile.guild_id===guildId)||null;}
export function discordGuildEnv(env,guildId){
 if(discordGuildScope(env)&&discordGuildScope(env)!==guildId)throw new DiscordGuildConfigError('GUILD_NOT_ALLOWED',403);
 const profile=discordGuildProfile(env,guildId);if(!profile)throw new DiscordGuildConfigError('GUILD_NOT_ALLOWED',403);
 return Object.assign(Object.create(env),{[BASE]:base(env),[SCOPE]:guildId,DISCORD_GUILD_ID:guildId,DISCORD_ALLOWED_CHANNEL_IDS:profile.allowed_channel_ids.join(','),DISCORD_POLL_CHANNEL_IDS:profile.poll_channel_ids.join(','),DISCORD_CLOUD_SINCE:profile.is_primary?base(env).DISCORD_CLOUD_SINCE:new Date(profile.since_ms).toISOString()});
}
export async function discordGuildActivation(env,guildId){
 let profile=discordGuildProfile(env,guildId);if(!profile)throw new DiscordGuildConfigError('GUILD_NOT_ALLOWED',403);
 if(profile.is_primary)return {since_ms:profile.since_ms,initial_channel_ids:[...profile.poll_channel_ids]};
 const root=base(env);if(typeof root.BRIDGE_OWNER_SITE_ID!=='string'||!root.BRIDGE_OWNER_SITE_ID||!root.DB?.prepare)throw new DiscordGuildConfigError('DISCORD_GUILD_STATE_UNAVAILABLE');
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([root.BRIDGE_OWNER_SITE_ID,guildId])));
 const key='cloud_guild_activation:v1:'+Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,'0')).join('');
 for(let attempt=0;attempt<8;attempt++){
  profile=discordGuildProfile(env,guildId);if(!profile)throw new DiscordGuildConfigError('GUILD_NOT_ALLOWED',403);
  const row=await root.DB.prepare('SELECT value FROM bridge_runtime WHERE key=?').bind(key).first();
  let stored;try{stored=row?JSON.parse(row.value):null;}catch{throw new DiscordGuildConfigError('DISCORD_GUILD_STATE_UNAVAILABLE');}
  if(row&&(!stored||stored.version!==1||stored.scope!==key||!Number.isSafeInteger(stored.since_ms)||stored.since_ms<1420070400000||!Array.isArray(stored.initial_channel_ids)||!stored.initial_channel_ids.length||stored.initial_channel_ids.length>10||stored.initial_channel_ids.some(id=>typeof id!=='string'||!ID.test(id))||new Set(stored.initial_channel_ids).size!==stored.initial_channel_ids.length))throw new DiscordGuildConfigError('DISCORD_GUILD_STATE_UNAVAILABLE');
  const next={version:1,scope:key,since_ms:Math.max(stored?.since_ms||0,profile.since_ms),initial_channel_ids:stored?.initial_channel_ids||profile.poll_channel_ids};
  if(row&&next.since_ms===stored.since_ms)return {since_ms:next.since_ms,initial_channel_ids:[...next.initial_channel_ids]};
  const raw=JSON.stringify(next),result=row?await root.DB.prepare('UPDATE bridge_runtime SET value=?,updated_at=? WHERE key=? AND value=?').bind(raw,Date.now(),key,row.value).run():await root.DB.prepare('INSERT OR IGNORE INTO bridge_runtime (key,value,updated_at) VALUES (?,?,?)').bind(key,raw,Date.now()).run();
  if(result.meta?.changes)return {since_ms:next.since_ms,initial_channel_ids:[...next.initial_channel_ids]};
 }
 throw new DiscordGuildConfigError('DISCORD_GUILD_STATE_UNAVAILABLE');
}
