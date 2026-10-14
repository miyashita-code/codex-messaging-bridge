import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

const endpoint='https://test.invalid/runtime/discord-probe';
test('runtime probe stays disabled without a short valid expiry and never calls the network',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('network must stay disabled');});
  for(const env of [{},{BRIDGE_RUNTIME_PROBE_UNTIL:'invalid'},{BRIDGE_RUNTIME_PROBE_UNTIL:new Date(Date.now()-1000).toISOString()},{BRIDGE_RUNTIME_PROBE_UNTIL:new Date(Date.now()+7200000).toISOString()},{BRIDGE_RUNTIME:'companion',BRIDGE_RUNTIME_PROBE_UNTIL:new Date(Date.now()+60000).toISOString()}]){
    const r=await worker.fetch(new Request(endpoint),env);
    assert.equal(r.status,404);
  }
  assert.equal(calls,0);
});
test('enabled diagnostic rejects writes and cross-origin browser requests without connecting',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('network must stay disabled');});
  const env={BRIDGE_RUNTIME_PROBE_UNTIL:new Date(Date.now()+60000).toISOString()};
  assert.equal((await worker.fetch(new Request(endpoint,{method:'POST'}),env)).status,405);
  assert.equal((await worker.fetch(new Request(endpoint,{headers:{origin:'https://other.invalid'}}),env)).status,403);
  assert.equal(calls,0);
});
test('a private active diagnostic returns only bounded transport evidence and sends no Bot identity',async t=>{
  let listener;const calls=[];
  const socket={readyState:1,addEventListener(type,fn){if(type==='message')listener=fn;},removeEventListener(){},accept(){listener({data:JSON.stringify({op:10,d:{heartbeat_interval:45000}})});},close(){this.readyState=3;}};
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push([url,options]);return calls.length===1?{status:200,json:async()=>({url:'wss://gateway.discord.gg'})}:{status:101,webSocket:socket};});
  const r=await worker.fetch(new Request(endpoint),{BRIDGE_RUNTIME_PROBE_UNTIL:new Date(Date.now()+60000).toISOString(),DISCORD_BOT_TOKEN:'must-not-leave-this-test'});
  const value=await r.json();assert.equal(r.status,200);assert.equal(value.https.ok,true);assert.equal(value.wss.hello,true);assert.equal(value.uptimeVerified,false);assert.equal(value.runtimeVerified,false);assert.equal(socket.readyState,3);
  assert.equal(calls.length,2);for(const [,options]of calls)assert.equal(new Headers(options.headers).has('authorization'),false);
  assert.doesNotMatch(JSON.stringify(value),/must-not-leave/);
});
