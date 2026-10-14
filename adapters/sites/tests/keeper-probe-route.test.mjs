import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

const env=()=>({BRIDGE_OWNER_SITE_ID:'owner',BRIDGE_KEEPER_PROBE_UNTIL:new Date(Date.now()+600000).toISOString()});
const request=(path='/runtime/keeper-probe',headers={'oai-authenticated-user-id':'owner'},method='GET')=>new Request('https://site.example'+path,{method,headers});

test('keeper routes are disabled by default, expiry, oversized window, and live companion mode',async()=>{
 for(const settings of [{},{...env(),BRIDGE_KEEPER_PROBE_UNTIL:'invalid'},{...env(),BRIDGE_KEEPER_PROBE_UNTIL:new Date(Date.now()-1).toISOString()},{...env(),BRIDGE_KEEPER_PROBE_UNTIL:new Date(Date.now()+3700000).toISOString()},{...env(),BRIDGE_RUNTIME:'companion'}]){
  for(const path of ['/runtime/keeper-probe','/runtime/keeper-socket'])assert.equal((await worker.fetch(request(path),settings)).status,404);
 }
});
test('keeper requires the verified owner and refuses foreign origin or mutating methods',async()=>{
 assert.equal((await worker.fetch(request('/runtime/keeper-probe',{}),env())).status,401);
 assert.equal((await worker.fetch(request('/runtime/keeper-probe',{'oai-authenticated-user-id':'other'}),env())).status,403);
 assert.equal((await worker.fetch(request('/runtime/keeper-probe',{'oai-authenticated-user-id':'owner',Origin:'https://other.example'}),env())).status,403);
 assert.equal((await worker.fetch(request('/runtime/keeper-probe',{'oai-authenticated-user-id':'owner'},'POST'),env())).status,405);
});
test('keeper page has a fresh script nonce and exact same-site websocket CSP without credentials',async()=>{
 const response=await worker.fetch(request(),env());assert.equal(response.status,200);
 const html=await response.text(),csp=response.headers.get('content-security-policy');
 const nonce=html.match(/<script[^>]*nonce="([A-Za-z0-9_-]+)"/)[1];
 assert.ok(csp.includes(`script-src 'nonce-${nonce}'`));assert.ok(csp.includes('connect-src \'self\' wss://site.example'));
 assert.ok(!csp.includes("script-src 'unsafe-inline'"));assert.equal(response.headers.get('cache-control'),'no-store');
 assert.ok(!html.includes('OAI-Sites-Authorization'));assert.ok(!html.includes('DISCORD_BOT_TOKEN'));
});
test('keeper socket requires exact Origin and websocket upgrade before creating a socket',async()=>{
 assert.equal((await worker.fetch(request('/runtime/keeper-socket',{'oai-authenticated-user-id':'owner',Upgrade:'websocket'}),env())).status,403);
 assert.equal((await worker.fetch(request('/runtime/keeper-socket',{'oai-authenticated-user-id':'owner',Origin:'https://site.example'}),env())).status,426);
});
