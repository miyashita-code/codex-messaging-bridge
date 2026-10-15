// A role name or message text is never invocation authority. Only Discord's
// current managed role tagged for this exact Bot can supplement a user mention.
import {discordGuildProfile,discordGuildScope} from './discord-guilds.js';
const ID=/^[0-9]{17,20}$/;
const none=()=>({mentions_bot:false,mention_kind:null});
export class DiscordInvocationError extends Error{constructor(code='DISCORD_ROLE_RESPONSE_INVALID',status=502){super(code);this.code=code;this.status=status;}}
export function discordDirectInvocation(env,m){if(typeof env?.DISCORD_BOT_ID!=='string'||!ID.test(env.DISCORD_BOT_ID))throw new DiscordInvocationError('DISCORD_INVOCATION_BOT_NOT_CONFIGURED',503);return Array.isArray(m?.mentions)&&m.mentions.some(user=>user?.id===env.DISCORD_BOT_ID)?{mentions_bot:true,mention_kind:'user'}:none();}
export async function resolveDiscordInvocation(env,ch,m,{readRoles}={}){
 if(!ch||typeof ch.id!=='string'||!ID.test(ch.id)||typeof ch.guild_id!=='string'||!ID.test(ch.guild_id)||m?.channel_id!==ch.id||typeof m.id!=='string'||!ID.test(m.id)||!discordGuildProfile(env,ch.guild_id)||discordGuildScope(env)&&discordGuildScope(env)!==ch.guild_id)throw new DiscordInvocationError('DISCORD_INVOCATION_SOURCE_NOT_ALLOWED',403);
 const direct=discordDirectInvocation(env,m),botId=env.DISCORD_BOT_ID;if(direct.mentions_bot)return direct;
 if(!Array.isArray(m.mention_roles)||!m.mention_roles.length)return none();
 if(m.mention_roles.length>1000||m.mention_roles.some(role=>typeof role!=='string'||!ID.test(role))||typeof readRoles!=='function')throw new DiscordInvocationError();
 const roles=await readRoles(env,ch.guild_id);
 // Malformed upstream data is unavailable, not proof that a role is safe.
 if(!Array.isArray(roles)||roles.length>1000||roles.some(role=>!role||typeof role.id!=='string'||!ID.test(role.id)))throw new DiscordInvocationError();
 if(env.DISCORD_BOT_ID!==botId||!discordGuildProfile(env,ch.guild_id)||discordGuildScope(env)&&discordGuildScope(env)!==ch.guild_id)throw new DiscordInvocationError('DISCORD_INVOCATION_SOURCE_NOT_ALLOWED',403);
 return roles.some(role=>role.managed===true&&role.tags?.bot_id===botId&&m.mention_roles.includes(role.id))?{mentions_bot:true,mention_kind:'bot_role'}:none();
}
