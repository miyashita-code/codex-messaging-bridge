import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {execFileSync} from 'node:child_process';

test('cloud handoff includes runnable Sites sources but excludes private runtime and build files', t => {
  const root=mkdtempSync(join(tmpdir(),'bridge-package-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const put=(path,content='fixture')=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),content);};
  for(const file of ['package.json','package-lock.json','README.md','CHANGELOG.md','AGENTS.md','agent.md','LICENSE','.env.example','bridge.config.example.json','bridge.discord.example.json','bridge.discord.cloud.example.json'])put(file);
  for(const dir of ['src','bin','scripts','docs','deploy','plugin','tests'])put(`${dir}/fixture.txt`);
  for(const file of ['README.md','package.json','drizzle.config.ts','.openai/hosting.json','db/schema.ts','drizzle/0000.sql','worker/index.js','worker/cloud-inbox.js','scripts/build.sh','tests/cloud.test.mjs'])put(`adapters/sites/${file}`);
  for(const file of ['.env','bridge.config.json','data/runtime.sqlite','adapters/sites/.env','adapters/sites/.openai/private.json','adapters/sites/node_modules/private/index.js','adapters/sites/dist/worker.js','adapters/sites/worker/.env','adapters/sites/worker/runtime.sqlite','adapters/sites/worker/debug.log'])put(file,'DO_NOT_DISTRIBUTE');
  copyFileSync(new URL('../scripts/package-cloud.mjs',import.meta.url),join(root,'scripts/package-cloud.mjs'));
  execFileSync(process.execPath,[join(root,'scripts/package-cloud.mjs')],{cwd:root,stdio:'pipe'});
  const archive=join(root,'data/codex-messaging-bridge-cloud.tar.gz');
  const entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).split('\n');
  for(const file of ['adapters/sites/worker/index.js','adapters/sites/worker/cloud-inbox.js','adapters/sites/.openai/hosting.json','adapters/sites/db/schema.ts','adapters/sites/drizzle/0000.sql','adapters/sites/scripts/build.sh','AGENTS.md'])assert(entries.includes(file),file);
  const extracted=join(root,'unpacked');mkdirSync(extracted);
  execFileSync('tar',['-xzf',archive,'-C',extracted]);
  assert(!entries.some(p=>/(^|\/)(data|node_modules|dist)\//.test(p)||/(^|\/)\.env$|\.sqlite$|\.log$|private\.json$/.test(p)));
  assert.equal(readFileSync(join(extracted,'adapters/sites/worker/index.js'),'utf8'),'fixture');
});
