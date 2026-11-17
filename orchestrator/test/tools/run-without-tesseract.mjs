/** Run the full suite with a PATH containing no Tesseract executable. No system binary is changed. */
import {mkdtemp,readdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
const dir=await mkdtemp(join(tmpdir(),'rl72-without-ocr-')),seen=new Set();
try{
 for(const base of (process.env.PATH??'').split(':')){let names=[];try{names=await readdir(base);}catch{continue;}for(const name of names){if(name==='tesseract'||seen.has(name))continue;try{await symlink(join(base,name),join(dir,name));seen.add(name);}catch{}}}
 const env={...process.env,PATH:dir};if(spawnSync('tesseract',['--version'],{env}).status===0)throw Error('Tesseract still reachable');
 const result=spawnSync(process.execPath,['--import','./test/windows-node24-shim.mjs','--import','tsx','--test','--test-concurrency=2','test/*.test.ts','test/*.test.mjs','test/db/*.test.ts'],{cwd:'orchestrator',env,stdio:'inherit'});process.exitCode=result.status??1;
}finally{await rm(dir,{recursive:true,force:true});}
