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
  "0157_creative_media_products.sql",
  "0158_creative_media_reports.sql",
  "0159_creative_media_video_jobs.sql",
  "0160_creative_media_source_videos.sql",
  "0161_creative_source_video_private_preview.sql",
  "0162_creative_media_video_probe.sql",
  "0163_creative_media_video_output_capture.sql",
  "0164_creative_media_access_grants.sql",
  "0165_creative_video_private_output_preview.sql",
  "0166_creative_media_edit_projects.sql",
  "0167_creative_media_global_budget.sql"
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
