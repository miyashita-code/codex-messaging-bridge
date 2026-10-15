import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {setTimeout} from 'node:timers/promises';

function packageFixture(t) {
  const root=mkdtempSync(join(tmpdir(),'bridge-package-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const put=(path,content='fixture')=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),content);};
  for(const file of ['package.json','package-lock.json','README.md','CHANGELOG.md','SECURITY.md','CONTRIBUTING.md','AGENTS.md','agent.md','LICENSE','.env.example','bridge.config.example.json','bridge.discord.example.json','bridge.discord.cloud.example.json'])put(file);
  for(const dir of ['src','bin','scripts','docs','deploy','plugin','tests'])put(`${dir}/fixture.txt`);
  put('assets/readme-hero.png','public image fixture');
  put('assets/private-preview.png','DO_NOT_DISTRIBUTE');
  for(const file of ['README.md','package.json','drizzle.config.ts','.openai/hosting.json','db/schema.ts','drizzle/0000.sql','worker/index.js','worker/cloud-inbox.js','scripts/build.sh','tests/cloud.test.mjs'])put(`adapters/sites/${file}`);
  for(const file of ['.env','bridge.config.json','data/runtime.sqlite','adapters/sites/.env','adapters/sites/.openai/private.json','adapters/sites/node_modules/private/index.js','adapters/sites/dist/worker.js','adapters/sites/worker/.env','adapters/sites/worker/runtime.sqlite','adapters/sites/worker/debug.log'])put(file,'DO_NOT_DISTRIBUTE');
  copyFileSync(new URL('../scripts/package-cloud.mjs',import.meta.url),join(root,'scripts/package-cloud.mjs'));
  return root;
}

test('cloud handoff includes runnable Sites sources but excludes private runtime and build files', t => {
  const root=packageFixture(t);
  execFileSync(process.execPath,[join(root,'scripts/package-cloud.mjs')],{cwd:root,stdio:'pipe'});
  const archive=join(root,'data/codex-messaging-bridge-cloud.tar.gz');
  const entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).split('\n');
  for(const file of ['adapters/sites/worker/index.js','adapters/sites/worker/cloud-inbox.js','adapters/sites/.openai/hosting.json','adapters/sites/db/schema.ts','adapters/sites/drizzle/0000.sql','adapters/sites/scripts/build.sh','AGENTS.md','SECURITY.md','CONTRIBUTING.md','assets/readme-hero.png'])assert(entries.includes(file),file);
  assert(!entries.includes('assets/private-preview.png'));
  const extracted=join(root,'unpacked');mkdirSync(extracted);
  execFileSync('tar',['-xzf',archive,'-C',extracted]);
  assert(!entries.some(p=>/(^|\/)(data|node_modules|dist)\//.test(p)||/(^|\/)\.env$|\.sqlite$|\.log$|private\.json$/.test(p)));
  assert.equal(readFileSync(join(extracted,'adapters/sites/worker/index.js'),'utf8'),'fixture');
});

test('cloud handoff gzip bytes remain identical across packaging times and unpack without private files', async t => {
  const root=packageFixture(t);
  const archive=join(root,'data/codex-messaging-bridge-cloud.tar.gz');
  const run=()=>{execFileSync(process.execPath,[join(root,'scripts/package-cloud.mjs')],{cwd:root,stdio:'pipe'});return readFileSync(archive);};
  const first=run();
  await setTimeout(1100);
  const second=run();
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(first),digest(second));
  assert.equal(second.readUInt32LE(4),0,'gzip timestamp must not record the packaging time');
  const unpacked=gunzipSync(second);
  assert.deepEqual(unpacked,gunzipSync(first));
  assert(!unpacked.includes(Buffer.from('DO_NOT_DISTRIBUTE')));
  const extracted=join(root,'repro-unpacked');mkdirSync(extracted);
  execFileSync('tar',['-xzf',archive,'-C',extracted]);
  assert.equal(readFileSync(join(extracted,'SECURITY.md'),'utf8'),'fixture');
  assert.equal(readFileSync(join(extracted,'adapters/sites/worker/index.js'),'utf8'),'fixture');
});
