/** Pull-only, private-owner CLI. No synthetic fixture is passed off as live coverage. */
import { readFile,writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ApolloDiscovery,CompaniesHouseClient } from '../orchestrator/src/integrations/apollo/index.js';
import { PgApolloStore } from '../orchestrator/src/integrations/apollo/pg-store.js';
import { coverage,readCompanyCsv } from '../orchestrator/src/integrations/apollo/coverage.js';
const args=process.argv.slice(2),option=(key:string)=>{const i=args.indexOf(key);return i>=0?args[i+1]:undefined;};
const input=option('--input'),output=option('--output'),brand=option('--brand');
const cap=Number(option('--max-credits')??'0');
if(!input||!output||!brand||!Number.isInteger(cap)||cap<0||cap>25)throw new Error('Usage: --input firms.csv --brand WORKSPACE_UUID --output report.json [--max-credits 0..25]');
if(process.env.APOLLO_ENABLED!=='true')throw new Error('Apollo is disabled (APOLLO_ENABLED must be true after private enrolment)');
for(const key of ['APOLLO_API_KEY','COMPANIES_HOUSE_API_KEY','DATABASE_CONTENT_COMMAND_URL','APOLLO_OWNER_USER_ID','APOLLO_OWNER_SESSION_TOKEN','APOLLO_OWNER_SELECTED_WORKSPACE']){
  if(!process.env[key]?.trim())throw new Error(`${key} is required; keep secrets out of command arguments/logs`);
}
const seeds=readCompanyCsv(await readFile(input,'utf8'));
const pool=new pg.Pool({connectionString:process.env.DATABASE_CONTENT_COMMAND_URL,max:2});
try{
  const store=new PgApolloStore(pool,{userId:process.env.APOLLO_OWNER_USER_ID!,sessionToken:process.env.APOLLO_OWNER_SESSION_TOKEN!,workspaceId:process.env.APOLLO_OWNER_SELECTED_WORKSPACE!,userEmail:''},brand,randomUUID());
  const discovery=new ApolloDiscovery(store,new CompaniesHouseClient(process.env.COMPANIES_HOUSE_API_KEY!),{
    enabled:true,apiKey:process.env.APOLLO_API_KEY!,maxRunCredits:cap,log:entry=>process.stderr.write(JSON.stringify(entry)+'\n')});
  const report=await coverage(discovery,seeds);
  await writeFile(output,JSON.stringify({...report,live:true,generatedAt:new Date().toISOString()},null,2),{mode:0o600});
  console.table(report.segments);console.log(JSON.stringify({credits:report.credits,report:output}));
  if(report.rows.some(r=>r.hold))process.exitCode=2;
}finally{await pool.end();}
