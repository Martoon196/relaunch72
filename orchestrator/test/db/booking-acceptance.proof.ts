/** Explicit isolated Neon branch only. No provider calls or production target. */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {runMigrations,assertSchemaCurrent,discoverMigrations} from '../../src/db/migrate.js';
const folder=process.env.BOOKING_PROOF_FOLDER;if(!folder)throw Error('Explicit proof folder required');
const target=JSON.parse(await fs.readFile(folder+'/booking-proof-target.json','utf8')) as {branch:string;host:string};
const connectionString=(await fs.readFile(folder+'/.booking-proof-connection','utf8')).trim(),url=new URL(connectionString);
if(target.branch!=='br-noisy-cell-b2orkzcm'||url.hostname!==target.host||url.pathname!=='/neondb'||!url.hostname.endsWith('.neon.tech'))throw Error('Isolated branch mismatch');
url.searchParams.set('sslmode','verify-full');
const pool=new Pool({connectionString:url.toString(),max:3,connectionTimeoutMillis:20000});
try{
 const migration=await runMigrations(pool);await assertSchemaCurrent(pool);
 const fixture=await fs.readFile(new URL('booking-proof.sql',import.meta.url),'utf8');
 const client=await pool.connect();let start:string;
 try{await client.query('BEGIN');await client.query(fixture);start=(await client.query("SELECT current_setting('test.booking_start')::timestamptz+interval '2 hours' AS stamp")).rows[0].stamp.toISOString();await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 const person={name:'Concurrent visitor',email:'concurrent-booking@example.invalid',answers:{}};
 async function race(commands:[string,string]) {
  const a=await pool.connect(),b=await pool.connect();
  try{
   await Promise.all([a,b].map(c=>c.query('BEGIN;SET LOCAL ROLE r72_identity_command')));
   return await Promise.allSettled([a,b].map(async(c,i)=>{
    try{const r=await c.query('SELECT app_private.booking_hold($1,$2,$3,$4,$5,$6,$7,$8,$9) AS value',['b1380000-0000-4000-8000-000000000032',false,commands[i],start,person,Buffer.alloc(32,0xda),Buffer.alloc(32,0xdb),2,2]);await c.query('COMMIT');return r.rows[0].value;}
    catch(error){await c.query('ROLLBACK');throw error;}
   }));
  }finally{a.release();b.release();}
 }
 const clash=await race([randomUUID(),randomUUID()]);assert.equal(clash.filter(r=>r.status==='fulfilled').length,1);assert.equal(clash.filter(r=>r.status==='rejected'&&r.reason.code==='23P01').length,1);
 start=new Date(Date.parse(start)+3600000).toISOString();const command=randomUUID(),replay=await race([command,command]);
 assert.ok(replay.every(r=>r.status==='fulfilled'));const values=replay.map(r=>(r as PromiseFulfilledResult<{id:string;created:boolean}>).value);assert.equal(values[0]!.id,values[1]!.id);assert.equal(values.filter(v=>v.created).length,1);
 const receipt={branch:target.branch,migrations: migration,sql:(await discoverMigrations()).at(-1),proofPackages:1,concurrentConflict:'one winner / one exclusion',concurrentReplay:'one creation / one identical receipt',providerCalls:0,productionChanges:0};
 await fs.writeFile(folder+'/booking-db-acceptance.json',JSON.stringify({...receipt,sql:{filename:receipt.sql!.filename,checksum:receipt.sql!.checksum}},null,2)+'\n');
 console.log(JSON.stringify({branch:target.branch,proofPackages:1,races:2,failed:0,providerCalls:0,productionChanges:0}));
}catch(error){console.error(error instanceof Error?error.message:'Isolated booking acceptance failed');process.exitCode=1;}
finally{await pool.end();}
