import { mkdirSync,mkdtempSync,lstatSync,readdirSync,copyFileSync,chmodSync,utimesSync,renameSync,rmSync } from 'node:fs';
import { resolve,dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
mkdirSync(resolve(root,'data'),{recursive:true,mode:0o700});
const target=resolve(root,'data/codex-messaging-bridge-cloud.tar.gz');
// Explicit allowlist: never package the active .env, local config, receipts or authentication files.
const files=['package.json','package-lock.json','README.md','CHANGELOG.md','AGENTS.md','agent.md','LICENSE','.env.example','bridge.config.example.json','bridge.discord.example.json','bridge.discord.cloud.example.json','src','bin','scripts','docs','deploy','plugin','tests'];
const work=mkdtempSync(resolve(root,'data/.cloud-package-'));
const stage=join(work,'source'),archive=join(work,'archive.tar.gz');
const excluded=name=>name==='.DS_Store' || name.startsWith('._') || (name.startsWith('.env') && name!=='.env.example') || name==='bridge.config.json' || /\.sqlite.*$|\.log$/.test(name);
function copySource(relative) {
  const source=resolve(root,relative),destination=resolve(stage,relative),info=lstatSync(source);
  if(info.isSymbolicLink())throw new Error(`Refusing to package a symbolic link: ${relative}`);
  if(info.isDirectory()) {
    mkdirSync(destination,{recursive:true,mode:0o755});
    for(const name of readdirSync(source).sort())if(!excluded(name))copySource(join(relative,name));
    chmodSync(destination,0o755);utimesSync(destination,0,0);
  } else if(info.isFile()) {
    copyFileSync(source,destination);chmodSync(destination,info.mode & 0o111?0o755:0o644);utimesSync(destination,0,0);
  } else throw new Error(`Refusing to package a special file: ${relative}`);
}
try {
  mkdirSync(stage,{mode:0o755});
  for(const file of files)copySource(file);
  // Copying into a clean tree drops source ACLs, resource forks and extended attributes.
  // USTAR avoids platform-specific PAX metadata; tar also receives explicit portable ownership.
  const version=execFileSync('tar',['--version'],{encoding:'utf8'});
  const portable=/GNU tar/.test(version)
    ? ['--format=ustar','--owner=0','--group=0','--numeric-owner','--no-acls','--no-xattrs','--sort=name']
    : /bsdtar/.test(version)
      ? ['--format=ustar','--uid','0','--gid','0','--uname','root','--gname','root','--no-acls','--no-xattrs','--no-fflags']
      : null;
  if(!portable)throw new Error('Packaging requires GNU tar or bsdtar');
  execFileSync('tar',[...portable,'-czf',archive,...files],{cwd:stage,env:{...process.env,COPYFILE_DISABLE:'1',COPY_EXTENDED_ATTRIBUTES_DISABLE:'1'},stdio:'inherit'});
  renameSync(archive,target);
} finally {rmSync(work,{recursive:true,force:true});}
console.log(JSON.stringify({artifact:target,includesSecrets:false}));
