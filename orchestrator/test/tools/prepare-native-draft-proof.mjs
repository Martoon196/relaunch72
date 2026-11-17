import pg from 'pg';
const raw=process.env.RL72_METHODS_PG_TEST_URL,u=new URL(raw??'');
if(process.env.RELAUNCH72_DATABASE_INTEGRATION!=='explicit-disposable-run'||!['localhost','127.0.0.1'].includes(u.hostname)||u.pathname!=='/relaunch72_test')throw Error('Disposable localhost only');
const db=new pg.Client({connectionString:raw});await db.connect();
try{await db.query("DO $f$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_media_job_definer') THEN CREATE ROLE r72_media_job_definer NOLOGIN NOINHERIT; END IF; END $f$");console.log('Legacy media role exists under separate creator; native migrator must leave it untouched');}finally{await db.end();}
