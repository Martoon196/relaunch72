/**
 * Apply PRIVATE MEDIA DRAFTS to a disposable localhost database only.
 * This is a test harness, not a migration runner. Claude owns migration
 * numbering and production integration. No secrets appear in this script.
 */
import pg from 'pg';
import { readFile } from 'node:fs/promises';

const DATABASE=process.env.RL72_METHODS_PG_TEST_URL;
const u=DATABASE?new URL(DATABASE):null;
if(process.env.RELAUNCH72_DATABASE_INTEGRATION!=='explicit-disposable-run'
  ||!u||!['127.0.0.1','localhost'].includes(u.hostname)
  ||u.pathname!=='/relaunch72_test'||!DATABASE)
  throw new Error('Media schema drafts may be tested only in an explicitly authorised disposable localhost database');

const draftFiles=[
  "native-video-role.sql",
  "media-erasure-table.sql",
  "source-videos.sql",
  "source-private-preview.sql",
  "source-video-probe.sql",
  "edit-projects.sql",
  "local-render-jobs.sql",
  "local-output-private-review.sql",
  "media-worker-dispatch.sql",
  "local-video-canonical-handoff.sql",
  "private-object-sources.sql",
  "native-video-release.sql",
  "media-retention.sql",
  "native-video-jit.sql",
  "native-video-planner.sql",
  "native-video-call-trigger.sql"
];

const client=new pg.Client({connectionString:DATABASE});
await client.connect();
try{
 for(const name of draftFiles){
  const sql=await readFile(new URL('./'+name,import.meta.url),'utf8');
  if(!sql.trim())throw new Error('Empty media schema draft');
  await client.query('BEGIN');
  try{
   await client.query(sql);
   await client.query('COMMIT');
  }catch(error){
   await client.query('ROLLBACK');
   throw new Error('Isolated media draft could not be applied: '+name,{cause:error});
  }
 }
 console.log('Applied '+draftFiles.length+' unnumbered-for-production media schema drafts to disposable localhost PostgreSQL');
}finally{
 await client.end();
}
