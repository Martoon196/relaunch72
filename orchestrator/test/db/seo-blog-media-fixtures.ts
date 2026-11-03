/** Disposable proof helpers only: importing this module never connects, resets or registers tests. */
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {assertDisposableTestDatabase} from './database-helper.js';
import {DEFAULT_BRAND_SETTINGS} from '../../src/seo-blog/types.js';
import {PgSeoBlogMediaStore} from '../../src/seo-blog/media-store.js';
export const MEDIA_STORAGE_TEST_ORIGIN='https://media-proof.example.test';
const MEDIA_PROOF_ROLES=['r72_content_command','r72_content_adapter','r72_web','r72_zernio_social_command','r72_owned_social_worker_command'] as const;
export type MediaProofRole=(typeof MEDIA_PROOF_ROLES)[number];
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export async function loginMediaProofRole(admin:pg.Pool,role:MediaProofRole) {
  assertDisposableTestDatabase(process.env.TEST_DATABASE_URL??'');
  if(!MEDIA_PROOF_ROLES.includes(role))throw new Error('Unsupported disposable media proof role.');
  const expected=decodeURIComponent(new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1));
  if((await admin.query('SELECT current_database() AS name')).rows[0].name!==expected)throw new Error('Role bootstrap pool does not match guarded disposable database.');
  const password=randomUUID()+randomUUID();
  const statement=await admin.query<{sql:string}>('SELECT format(\'ALTER ROLE %I PASSWORD %L\',$1::text,$2::text) AS sql',[role,password]);
  await admin.query(statement.rows[0]!.sql);
  const url=new URL(process.env.TEST_DATABASE_URL!);url.username=role;url.password=password;
  return new pg.Pool({connectionString:url.toString(),max:8,application_name:'relaunch72-disposable-media-storage'});
}
/** Minimal storage-only source fixture; actual prompt/codec journeys must replace it with a full truthful profile/article. */
export async function seedMediaStorageFixture(admin:pg.Pool,content:pg.Pool,origin=MEDIA_STORAGE_TEST_ORIGIN) {
  const org=randomUUID(),user=randomUUID(),home=randomUUID(),brand=randomUUID(),article=randomUUID(),version=randomUUID(),token=randomUUID()+randomUUID();
  await admin.query("INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,'Media proof',$2,'direct_customer')",[org,`media-${org}`]);
  await admin.query("INSERT INTO app.users(id,email,status) VALUES($1,$2,'active')",[user,`media-${user}@example.test`]);
  await admin.query("INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')",[org,user]);
  await admin.query("INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$3,'Home',$4),($2,$3,'Media brand',$5)",[home,brand,org,`home-${home}`,`brand-${brand}`]);
  await admin.query("INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status,source_organization_id) VALUES($1,$3,$4,'owner','active',$3),($2,$3,$4,'owner','active',$3)",[home,brand,org,user]);
  await admin.query("INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '2 hours')",[Buffer.from(sha(token),'hex'),Buffer.from(sha(`csrf${token}`),'hex'),user,home]);
  const settings={...DEFAULT_BRAND_SETTINGS,ongoingProduction:true,media:{imageGenerationEnabled:true},budgets:{modelTokensPerMonth:0,searchCallsPerMonth:0,imagesPerMonth:60}};
  await admin.query('INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,website,settings) VALUES($1,$2,$3,$4,$5)',[brand,org,user,origin,JSON.stringify(settings)]);
  const profile={brandId:brand,version:1,knowledge:[],factsSha:sha('facts'),confirmedAt:new Date().toISOString(),confirmedBy:user};
  await admin.query("INSERT INTO app.seo_blog_records(workspace_id,kind,id,data) VALUES($1,'profile','00000001',$2)",[brand,JSON.stringify(profile)]);
  const articleData={id:article,brandId:brand,currentVersionId:version,requiresApproval:true,hold:null,approval:{versionId:version,contentSha:sha('article')},checks:{versionId:version,contentSha:sha('article'),status:'pass'}};
  await admin.query('INSERT INTO app.seo_blog_articles(workspace_id,id,brief_id,slug,data) VALUES($1,$2,$3,$4,$5)',[brand,article,randomUUID(),`article-${article}`,JSON.stringify(articleData)]);
  await admin.query('INSERT INTO app.seo_blog_article_versions(workspace_id,id,article_id,number,content_sha256,data) VALUES($1,$2,$3,1,$4,$5)',[brand,version,article,sha('article'),JSON.stringify({id:version,body:{image:null},contentSha:sha('article'),promotionPack:{canonicalUrl:`${origin}/blog/article-${article}`}})]);
  const owner=new PgSeoBlogMediaStore(content,{kind:'user',userId:user,selectedWorkspaceId:home,sessionToken:token,requestId:randomUUID()},{publicOrigin:origin});
  return {org,user,home,brand,article,version,token,owner};
}
export type MediaStorageProofFixture=Awaited<ReturnType<typeof seedMediaStorageFixture>>;
