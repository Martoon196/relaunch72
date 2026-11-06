/** Pull-only, private-owner CLI. No synthetic fixture is passed off as live coverage. */
import { readFile,writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ApolloDiscovery,CompaniesHouseClient } from '../orchestrator/src/integrations/apollo/index.js';
import { PgApolloStore } from '../orchestrator/src/integrations/apollo/pg-store.js';
import { coverage,readCompanyCsv } from '../orchestrator/src/integrations/apollo/coverage.js';
import { validateCoverageTarget } from '../orchestrator/src/integrations/apollo/target-plan.js';
import { PgSeoBlogStore } from '../orchestrator/src/seo-blog/pg-store.js';
async function main():Promise<void>{
const args=process.argv.slice(2),option=(key:string)=>{const i=args.indexOf(key);return i>=0?args[i+1]:undefined;};
const input=option('--input'),output=option('--output'),brand=option('--brand'),targetPath=option('--target-plan');
const cap=Number(option('--max-credits')??'0');
if(!input||!output||!brand||!targetPath||!Number.isInteger(cap)||cap!==0)throw new Error('Usage: --input firms.csv --brand WORKSPACE_UUID --target-plan target.json --output report.json [--max-credits 0]');
if(process.env.APOLLO_ENABLED!=='true')throw new Error('Apollo is disabled (APOLLO_ENABLED must be true after private enrolment)');
for(const key of ['APOLLO_API_KEY','COMPANIES_HOUSE_API_KEY','DATABASE_CONTENT_COMMAND_URL','APOLLO_OWNER_USER_ID','APOLLO_OWNER_SESSION_TOKEN','APOLLO_OWNER_SELECTED_WORKSPACE']){
  if(!process.env[key]?.trim())throw new Error(`${key} is required; keep secrets out of command arguments/logs`);
}
const seeds=readCompanyCsv(await readFile(input,'utf8'));
const targetText=await readFile(targetPath,'utf8');
if(Buffer.byteLength(targetText)>16384)throw new Error('Target plan exceeds 16 KB');
const targetRaw:unknown=JSON.parse(targetText);
const pool=new pg.Pool({connectionString:process.env.DATABASE_CONTENT_COMMAND_URL,max:2});
try{
  const store=new PgApolloStore(pool,{userId:process.env.APOLLO_OWNER_USER_ID!,sessionToken:process.env.APOLLO_OWNER_SESSION_TOKEN!,workspaceId:process.env.APOLLO_OWNER_SELECTED_WORKSPACE!,userEmail:''},brand,randomUUID());
  const blogs=new PgSeoBlogStore(pool,{kind:'user',userId:process.env.APOLLO_OWNER_USER_ID!,sessionToken:process.env.APOLLO_OWNER_SESSION_TOKEN!,selectedWorkspaceId:process.env.APOLLO_OWNER_SELECTED_WORKSPACE!,requestId:randomUUID()});
  const targetNow=async()=>{
    if(!await blogs.canManage(process.env.APOLLO_OWNER_USER_ID!,brand))throw new Error('target_brand_access_denied');
    return validateCoverageTarget(targetRaw,brand,await blogs.latestProfile(brand),await blogs.listKnowledge(brand));
  };
  const target=await targetNow();
  const discovery=new ApolloDiscovery(store,new CompaniesHouseClient(process.env.COMPANIES_HOUSE_API_KEY!),{
    enabled:true,apiKey:process.env.APOLLO_API_KEY!,maxRunCredits:cap,log:entry=>process.stderr.write(JSON.stringify(entry)+'\n')});
  const report=await coverage(discovery,seeds,{filters:target.plan.filters,beforeEach:async()=>{
    const current=await targetNow();
    if(current.sha256!==target.sha256||current.knowledgeSha256!==target.knowledgeSha256)throw new Error('target_changed_during_run');
  }});
  await writeFile(output,JSON.stringify({...report,live:true,brandId:brand,target,generatedAt:new Date().toISOString()},null,2),{mode:0o600});
  console.table(report.segments);console.log(JSON.stringify({credits:report.credits,report:output}));
  if(report.rows.some(r=>r.hold))process.exitCode=2;
}finally{await pool.end();}
}
main().catch(error=>{
  const message=error instanceof Error?error.message:'';
  const safe=/^(Usage:|Apollo is disabled|[A-Z_]+ is required;|Target plan exceeds|target_|apollo_|Coverage accepts|CSV |Every firm|Unsupported segment|Duplicate firms|Unterminated CSV|Invalid CSV|Text after CSV)/.test(message)?message:'Coverage failed; reconcile the held run before retrying.';
  process.stderr.write(JSON.stringify({error:safe})+'\n');process.exitCode=1;
});
