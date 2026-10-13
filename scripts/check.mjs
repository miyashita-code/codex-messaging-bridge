import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
for (const dir of ['src','scripts','tests']) for (const f of readdirSync(dir)) if(f.endsWith('.mjs')) execFileSync(process.execPath,['--check',`${dir}/${f}`],{stdio:'inherit'});
console.log('Syntax checks passed');
