import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';

type Row={filename:string;checksum:string};
const pool=(rows:Row[])=>({query:async()=>({rows})}) as unknown as Pick<Pool,'query'>;
const migrations=await discoverMigrations();
const rows=migrations.map(({filename,checksum})=>({filename,checksum}));

test('exact old-app bridge stays ready before, throughout and after the approved 106–112 suffix',async()=>{
  for(let count=106;count<=112;count++)await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows.slice(0,count))));
});
test('bridge refuses missing baseline and gapped suffix ledger rows',async()=>{
  await assert.rejects(assertRuntimeSchemaCurrent(pool(rows.slice(0,105))),/schema is behind/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows.slice(0,106),rows[107]!])),/not a contiguous prefix/);
});
test('bridge refuses changed baseline and suffix checksums',async()=>{
  for(const index of [0,105,106,111]){
    const changed=rows.map((row,i)=>i===index?{...row,checksum:'0'.repeat(64)}:row);
    await assert.rejects(assertRuntimeSchemaCurrent(pool(changed)),/checksum changed/);
  }
});
test('bridge refuses unknown migration and duplicate ledger rows',async()=>{
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows,{filename:'0113_unknown.sql',checksum:'0'.repeat(64)}])),/migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows,rows[106]!])),/invalid runtime migration ledger/);
});
test('pending suffix exception requires the exact bundled candidate suffix',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'r72-investor-bridge-'));
  await Promise.all(migrations.map(m=>writeFile(path.join(directory,m.filename),m.version===107?m.sql+'\n-- modified source\n':m.sql)));
  await assert.rejects(assertRuntimeSchemaCurrent(pool(rows.slice(0,106)),directory),/schema is behind by 6/);
});
test('recovery has no investor HTTP/service composition or readiness bypass',async()=>{
  const sources=await Promise.all(['../../src/server/app.ts','../../src/server/index.ts','../../src/portal/postgres-platform.ts','../../src/portal/router.ts'].map(p=>readFile(new URL(p,import.meta.url),'utf8')));
  assert.ok(sources.every(source=>!source.includes('InvestorMailService')&&!source.includes('INVESTOR_ROUTE')));
  const manifest=await readFile(new URL('../../../render.property-predator.production.yaml',import.meta.url),'utf8');
  assert.match(manifest,/healthCheckPath: \/ready/);
});
