export function senderAllowed(list, userId, accessGroups = {}) {
  return (list || []).some(id => id==='*' || id.replace(/^line:/,'')===userId || (id.startsWith('accessGroup:') && senderAllowed(accessGroups[id.slice(12)] || [],userId,{})));
}
export function groupConfig(account, conversationId) {
  return {...account.groups?.['*'],...account.groups?.[conversationId]};
}
export function admitted(account, source, paired, accessGroups={}) {
  if (!source?.userId) return false;
  if (source.type==='user') {
    if (account.dmPolicy==='disabled') return false;
    if (senderAllowed(account.allowFrom, source.userId,accessGroups)) return true;
    if (account.dmPolicy==='pairing') return paired;
    return account.dmPolicy==='open';
  }
  if (!['group','room'].includes(source.type) || account.groupPolicy==='disabled') return false;
  const g=groupConfig(account,source.groupId || source.roomId);
  if (g.enabled===false) return false;
  if(g.allowFrom!==undefined) return senderAllowed(g.allowFrom,source.userId,accessGroups);
  return account.groupPolicy==='open' || senderAllowed(account.groupAllowFrom,source.userId,accessGroups);
}
export function addressed(account, event, quotedBot=false, implicitQuoted=true) {
  if (event.source.type==='user') return true;
  if (groupConfig(account,event.source.groupId || event.source.roomId).requireMention===false) return true;
  return (implicitQuoted && quotedBot) || (event.message?.mention?.mentionees || []).some(m=>m.isSelf===true || m.type==='all');
}
export function stripMentions(message) {
  let text=message.text || '';
  const spans=(message.mention?.mentionees || []).filter(m=>m.isSelf || m.type==='all').sort((a,b)=>b.index-a.index);
  for (const m of spans) if (Number.isInteger(m.index) && Number.isInteger(m.length) && m.index>=0 && m.length>0) text=text.slice(0,m.index)+' '+text.slice(m.index+m.length);
  return text.trim();
}
export const conversationId = source => source?.groupId || source?.roomId || source?.userId;
export const sessionKey = (accountId,source) => `${accountId}:${source.type}:${conversationId(source)}`;
