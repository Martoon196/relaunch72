import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Pool} from 'pg';
import {discoverMigrations} from '../../src/db/migrate.js';
import {assertRuntimeSchemaCurrent} from '../../src/db/runtime-readiness.js';
test('137 booking bridge admits only exact138; capable138 refuses137 and both reject missing/changed/unknown rows',async()=>{
 const migrations=await discoverMigrations(),rows=migrations.map(({filename,checksum})=>({filename,checksum}));
 const pool=(r:typeof rows)=>({query:async()=>({rows:r})}) as unknown as Pick<Pool,'query'>;
 const directory=await mkdtemp(path.join(tmpdir(),'r72-booking-bridge-'));
 try{
  await Promise.all(migrations.slice(0,137).map(m=>writeFile(path.join(directory,m.filename),m.sql)));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows.slice(0,137)),directory));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows),directory));
  await assert.rejects(assertRuntimeSchemaCurrent(pool(rows.slice(0,137))),/schema is behind/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool(rows.map((r,i)=>i===137?{...r,checksum:'0'.repeat(64)}:r)),directory),/migration not present/);
  for(const r of [rows.slice(1),rows.filter((_,i)=>i!==136),[...rows,rows[137]!],[...rows,{filename:'0139_future.sql',checksum:'a'.repeat(64)}]])await assert.rejects(assertRuntimeSchemaCurrent(pool(r),directory));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows)));
 }finally{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));assert.match(path.basename(resolved),/^r72-booking-bridge-/);await rm(resolved,{recursive:true,force:true});}
});
