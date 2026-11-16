// Explicit local disposable PG18 harness. No system service or production URL.
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import pg from 'pg';
const home=process.env.RL72_TEST_PG_HOME;if(!home||!process.env.RL72_TEST_FAKETIME_LIBRARY)throw Error('Explicit private PG18 binaries and libfaketime required');
const dir=await mkdtemp(join(tmpdir(),'rl72-native-clock-')),clock=join(dir,'clock'),data=join(dir,'data'),log=await open(join(dir,'server.log'),'w');
await writeFile(clock,'+0\n');await writeFile(join(dir,'password'),'local-ci-test-only\n',{mode:0o600});
const base={...process.env,LD_LIBRARY_PATH:process.env.RL72_TEST_PG_LIBRARY_PATH??''};
const init=spawnSync(join(home,'bin/initdb'),['-D',data,'-L',resolve(home,'../../../share/postgresql/18'),'-U','postgres','--pwfile='+join(dir,'password'),'--auth-local=trust','--auth-host=scram-sha-256','--no-locale','--encoding=UTF8'],{env:base,encoding:'utf8'});if(init.status!==0)throw Error(init.stderr);
const server=spawn(join(home,'bin/postgres'),['-D',data,'-h','127.0.0.1','-p','36215','-c','unix_socket_directories=','-c','timezone=UTC'],{env:{...base,LD_PRELOAD:process.env.RL72_TEST_FAKETIME_LIBRARY,FAKETIME_TIMESTAMP_FILE:clock,FAKETIME_NO_CACHE:'1',FAKETIME_DONT_FAKE_MONOTONIC:'1'},stdio:['ignore',log.fd,log.fd]});
const url='postgresql://postgres:local-ci-test-only@127.0.0.1:36215/relaunch72_test';
try{
 let admin;
 for(let n=0;n<100;n++){const candidate=new pg.Client({connectionString:url.replace('/relaunch72_test','/postgres')});try{await candidate.connect();admin=candidate;break;}catch{await candidate.end().catch(()=>{});await new Promise(r=>setTimeout(r,100));}}
 if(!admin)throw Error('Disposable PG failed to start: '+dir);
 await admin.query('CREATE DATABASE relaunch72_test');await admin.end();
 const env={...process.env,RL72_METHODS_PG_TEST_URL:url,RELAUNCH72_DATABASE_INTEGRATION:'explicit-disposable-run',RL72_MEDIA_CLOCK_FILE:clock};
 for(const args of [['--import','tsx','scripts/rl72-boosters-pg-bootstrap.mjs'],['orchestrator/src/creative-studio/migration-drafts/apply-to-disposable.mjs'],['--import','tsx','--test','orchestrator/test/db/creative-media-products-pg.integration.test.ts','orchestrator/test/db/creative-media-output-review-pg.integration.test.ts','orchestrator/test/db/creative-media-local-render-pg.integration.test.ts'],['--import','tsx','--test','orchestrator/test/db/creative-media-native-calendar-pg.integration.test.ts']]){
  const result=spawnSync(process.execPath,args,{env,stdio:'inherit'});if(result.status!==0)throw Error('Disposable step failed: '+args.join(' '));
 }
}finally{server.kill('SIGTERM');await new Promise(r=>{server.once('close',r);setTimeout(()=>{server.kill('SIGKILL');r();},3000).unref();});await log.close();console.log('Disposable clock evidence directory:',dir);}
