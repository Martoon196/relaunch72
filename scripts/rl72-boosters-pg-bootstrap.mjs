// Explicit disposable CI only. Refuse all remote or non-test database targets.
import assert from 'node:assert/strict';
import pg from 'pg';
import { runMigrations } from '../orchestrator/src/db/migrate.ts';
const url=new URL(process.env.RL72_METHODS_PG_TEST_URL??'');
assert.equal(process.env.RELAUNCH72_DATABASE_INTEGRATION,'explicit-disposable-run');
assert(['localhost','127.0.0.1'].includes(url.hostname));
assert.equal(url.pathname,'/relaunch72_test');
const pool=new pg.Pool({connectionString:url.toString(),max:1});
try{
 // Match the existing release proof: ordinary CREATEROLE database owner, not a superuser migrator.
 await pool.query("CREATE ROLE ci_migrator LOGIN CREATEROLE CREATEDB PASSWORD 'ci-owner-test-only'; ALTER DATABASE relaunch72_test OWNER TO ci_migrator");
 const migrationUrl=new URL(url);migrationUrl.username='ci_migrator';migrationUrl.password='ci-owner-test-only';
 const migrator=new pg.Pool({connectionString:migrationUrl.toString(),max:1});
 try{
  const result=await runMigrations(migrator);
  console.log(JSON.stringify({disposableOnly:true,migrationsApplied:result.applied.length,last:result.applied.at(-1)}));
 }finally{await migrator.end();}
 await pool.query("ALTER ROLE r72_content_command PASSWORD 'local-methods-test-only'");
}finally{await pool.end();}
