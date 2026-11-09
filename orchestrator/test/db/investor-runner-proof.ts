/** Explicit isolated suffix proof. Use an externally provisioned protected secret; never pass a URL in shell arguments. */
import { readFile,writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { runMigrations,assertSchemaCurrent,discoverMigrations } from '../../src/db/migrate.js';
const config={connectionString:process.env.TEST_DATABASE_URL??''};
const branch=process.env.INVESTOR_TEST_BRANCH_ID;
if(!config.connectionString||!branch||process.env.INVESTOR_FRESH_TEST_BRANCH!=='confirmed')throw new Error('Protected TEST_DATABASE_URL and explicit fresh test branch confirmation required');
const url=new URL(config.connectionString);
if(!url.pathname.includes('test')||!url.hostname.includes('neon.tech'))throw new Error('Explicit isolated Neon test database required');
const pool=new Pool({connectionString:config.connectionString,max:1,connectionTimeoutMillis:20_000});
const proofs=['investor-programme-proof.sql','investor-two-business-proof.sql','investor-site-proof.sql','investor-mail-review-proof.sql','investor-mail-dispatch-proof.sql','investor-mail-reply-proof.sql'];
const receipt:{branch:string;database:string;migrations:unknown;checksums:unknown;proofs:{name:string;result:string}[];providerCalls:number}={branch,database:decodeURIComponent(url.pathname.slice(1)),migrations:null,checksums:null,proofs:[],providerCalls:0};
try {
 const result=await runMigrations(pool);receipt.migrations={applied:result.applied,retained:result.alreadyApplied.length};
 await assertSchemaCurrent(pool);
 receipt.checksums=(await discoverMigrations()).filter(m=>m.version>=107).map(m=>({filename:m.filename,checksum:m.checksum}));
 for(const name of proofs){const client=await pool.connect();try{await client.query('BEGIN');await client.query(await readFile(new URL(name,import.meta.url),'utf8'));await client.query('COMMIT');receipt.proofs.push({name,result:'pass'});console.log(`${name}: pass`);}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
 await writeFile(new URL('../../../docs/investor-preview/database-runner-receipt.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify({applied:result.applied.length,retained:result.alreadyApplied.length,proofs:receipt.proofs.length,failed:0,skipped:0,providerCalls:0}));
}catch(error){console.error(error instanceof Error?error.message:'Isolated database proof failed');process.exitCode=1;}
finally{await pool.end();}
