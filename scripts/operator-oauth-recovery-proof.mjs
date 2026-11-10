// Prepared recovery binary (released 147 + one admission clause) and the candidate against an exact disposable148.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
const url=new URL(process.env.TEST_DATABASE_URL??'');
assert(['localhost','127.0.0.1'].includes(url.hostname));
assert.equal(url.pathname,'/relaunch72_test');
assert.equal(process.env.RELAUNCH72_DATABASE_INTEGRATION,'explicit-disposable-run');
const recovery=path.resolve(process.env.RECOVERY_SOURCE??'recovery-source');
const {assertRuntimeSchemaCurrent:recover}=await import(pathToFileURL(path.join(recovery,'orchestrator/src/db/runtime-readiness.ts')).href);
const {assertRuntimeSchemaCurrent:current}=await import('../orchestrator/src/db/runtime-readiness.ts');
const recoveryMigrations=path.join(recovery,'orchestrator/src/db/migrations');
const admin=new pg.Pool({connectionString:url.toString(),max:1});
let runtime;
try{
 const password=randomUUID()+randomUUID();
 await admin.query((await admin.query("SELECT format('ALTER ROLE r72_web PASSWORD %L',$1::text) AS sql",[password])).rows[0].sql);
 url.username='r72_web';url.password=password;
 runtime=new pg.Pool({connectionString:url.toString(),max:1});
 await recover(runtime,recoveryMigrations,{});
 await current(runtime,undefined,{});
 const {rows}=await runtime.query('SELECT filename,checksum FROM app_private.runtime_schema_migrations() ORDER BY filename');
 assert.equal(rows.length,148);
 assert.equal(rows.at(-1).filename,'0148_operator_oauth_tokens.sql');
 const pendingRows=rows.slice(0,-1);
 await current({query:async()=>({rows:pendingRows})},undefined,{});
 await recover({query:async()=>({rows:pendingRows})},recoveryMigrations,{});
 for(const check of [recover,current]){
   const dir=check===recover?recoveryMigrations:undefined;
   await assert.rejects(check({query:async()=>({rows:rows.map((r,i)=>i===147?{...r,checksum:'0'.repeat(64)}:r)})},dir,{}));
   await assert.rejects(check({query:async()=>({rows:[...rows,{filename:'0149_unreviewed.sql',checksum:'a'.repeat(64)}]})},dir,{}));
 }
 console.log(JSON.stringify({proof:'prepared147RecoveryAndCandidateOnExact148',role:'r72_web',pass:8,fail:0,production:false}));
}finally{await runtime?.end();await admin.end();}
