function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function errorResponse(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

// Each channel owns its admission and delivery worker; this object presents one
// MCP endpoint while routing requests before any channel can inspect private data.
export class MultiMcp {
  constructor({ line, discord } = {}) {
    this.channels = new Map();
    for (const [channel, mcp] of Object.entries({ line, discord })) {
      if (mcp === undefined || mcp === null) continue;
      if (mcp.channel !== channel || typeof mcp.dispatch !== 'function') throw new Error(`Invalid ${channel} MCP server.`);
      this.channels.set(channel, mcp);
    }
    if (!this.channels.size) throw new Error('At least one MCP channel is required.');
    this.closed = false;
  }

  async dispatch(body, principal) {
    const validId = body?.id === null || typeof body?.id === 'string' || (typeof body?.id === 'number' && Number.isFinite(body.id));
    const id = validId ? body.id : null;
    if (!isObject(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || ('id' in body && !validId)) return errorResponse(null, -32600, 'Invalid JSON-RPC request.');
    if (!Object.hasOwn(body, 'id')) return undefined;
    if (principal !== 'owner') return errorResponse(id, -32001, 'Owner authentication required.');
    if (this.closed) return errorResponse(id, -32000, 'MCP server is closed.');
    const params = body.params ?? {};
    if (!isObject(params)) return errorResponse(id, -32602, 'Parameters must be an object.');
    const first = this.channels.values().next().value;
    try {
      switch (body.method) {
        case 'tools/list':
        case 'events/list': {
          const key = body.method === 'tools/list' ? 'tools' : 'events';
          const results = await Promise.all([...this.channels.values()].map((mcp) => mcp.dispatch(body, principal)));
          const failed = results.find((result) => result?.error);
          if (failed) return failed;
          return { jsonrpc: '2.0', id, result: { [key]: results.flatMap((result) => result.result[key]) } };
        }
        case 'tools/call': {
          const channel = typeof params.name === 'string' ? params.name.split('_')[0] : undefined;
          const mcp = this.channels.get(channel);
          if (!mcp) return errorResponse(id, -32602, 'Unknown tool.');
          return await mcp.dispatch(body, principal);
        }
        case 'events/subscribe':
        case 'events/unsubscribe': {
          const mcp = [...this.channels.values()].find((candidate) => candidate.eventName === params.name);
          if (!mcp) return errorResponse(id, -32602, 'Unknown event.');
          return await mcp.dispatch(body, principal);
        }
        case 'server/discover':
        case 'initialize': {
          const response = await first.dispatch(body, principal);
          if (response.error || this.channels.size === 1) return response;
          return {
            ...response,
            result: {
              ...response.result,
              serverInfo: { ...response.result.serverInfo, name: 'codex-secretary-bridge' },
              instructions: [...this.channels.values()].map((mcp) => mcp.instructions).join('\n'),
            },
          };
        }
        default: return await first.dispatch(body, principal);
      }
    } catch {
      return errorResponse(id, -32603, 'MCP operation failed.');
    }
  }

  start() {
    if (this.closed) throw new Error('MCP server is closed.');
    for (const mcp of this.channels.values()) mcp.start();
  }

  revokeSubscriptions(principal = 'owner') {
    let revoked = 0;
    for (const mcp of this.channels.values()) revoked += mcp.revokeSubscriptions(principal).revoked;
    return { revoked };
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.channels.values()].map((mcp) => mcp.close()));
  }
}
