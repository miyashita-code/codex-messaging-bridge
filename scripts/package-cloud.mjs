import { mkdirSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
mkdirSync(resolve(root,'data'),{recursive:true,mode:0o700});
const target=resolve(root,'data/codex-messaging-bridge-cloud.tar.gz');
// Explicit allowlist: never package the active .env, local config, receipts or authentication files.
const files=['package.json','package-lock.json','README.md','LICENSE','.env.example','bridge.config.example.json','bridge.discord.example.json','bridge.discord.cloud.example.json','src','bin','scripts','docs','deploy','plugin','tests'];
execFileSync('tar',['-czf',target,...files],{cwd:root,stdio:'inherit'});
console.log(JSON.stringify({artifact:target,includesSecrets:false}));
