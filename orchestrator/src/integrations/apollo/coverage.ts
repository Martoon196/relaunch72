import type { ApolloDiscovery,CompanySeed,SearchPreview } from './index.js';
/** Small RFC4180 reader: quoted commas/newlines and escaped quotes are preserved. */
export function readCompanyCsv(csv:string):CompanySeed[]{
  if(Buffer.byteLength(csv)>1_000_000)throw new Error('CSV exceeds 1 MB');
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
  for(let i=0;i<csv.length;i++){
    const c=csv[i]!;
    if(quoted){if(c==='"'){if(csv[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
    if(c==='"'){if(cell||closed)throw new Error('Invalid CSV quote');quoted=true;}
    else if(c===','){row.push(cell);cell='';closed=false;}
    else if(c==='\r'||c==='\n'){if(c==='\r'&&csv[i+1]==='\n')i++;row.push(cell);if(row.some(Boolean))rows.push(row);row=[];cell='';closed=false;}
    else{if(closed)throw new Error('Text after CSV quote');cell+=c;}
  }
  if(quoted)throw new Error('Unterminated CSV quote');row.push(cell);if(row.some(Boolean))rows.push(row);
  const header=rows.shift()?.map(x=>x.replace(/^\uFEFF/,'').trim());
  if(!header||!['name','domain','segment'].every(k=>header.includes(k)))throw new Error('CSV needs name,domain,company_number,segment (postcode may replace company_number)');
  if(rows.length>100)throw new Error('Coverage accepts at most 100 firms per run');
  const seeds=rows.map(r=>{if(r.length!==header.length)throw new Error('CSV row width mismatch');const v=Object.fromEntries(header.map((h,i)=>[h,r[i]!.trim()]));
    if(!v.name||!v.domain||!v.segment||(!v.company_number&&!v.postcode))throw new Error('Every firm needs a name, approved domain, segment and CH number/postcode');
    if(!['agent','developer','landlord','broker'].includes(v.segment))throw new Error('Unsupported segment');
    return {name:v.name,domain:v.domain,company_number:v.company_number||undefined,postcode:v.postcode||undefined,segment:v.segment};});
  if(new Set(seeds.map(s=>`${s.company_number??s.name.toLowerCase()}|${s.domain.toLowerCase()}`)).size!==seeds.length)throw new Error('Duplicate firms in CSV');
  return seeds;
}
export interface CoverageRow {name:string;segment:string;organizationFound:boolean|null;peopleMatched:number|null;directorOrOwner:boolean|null;verifiedEmailIndicated:boolean|null;hold:string|null}
export async function coverage(discovery:ApolloDiscovery,seeds:CompanySeed[]):Promise<{rows:CoverageRow[];segments:Record<string,unknown>;credits:typeof discovery.totals}>{
  const rows:CoverageRow[]=[];
  for(const seed of seeds){
    try{const p:SearchPreview=await discovery.preview(seed);rows.push({name:seed.name,segment:seed.segment,organizationFound:p.orgFound,peopleMatched:p.peopleMatched,directorOrOwner:p.directorOrOwner,verifiedEmailIndicated:p.verifiedEmailIndicated,hold:null});}
    catch(e){rows.push({name:seed.name,segment:seed.segment,organizationFound:null,peopleMatched:null,directorOrOwner:null,verifiedEmailIndicated:null,hold:e instanceof Error?e.message:'held'});
      // Permission/plan failures stop the whole coverage run: never try a different endpoint/account.
      if(e instanceof Error&&/^apollo_http_(401|402|403|422)$/.test(e.message))break;
    }
  }
  const segments=Object.fromEntries([...new Set(seeds.map(s=>s.segment))].map(segment=>{
    const list=rows.filter(r=>r.segment===segment);return [segment,{input:seeds.filter(s=>s.segment===segment).length,tested:list.length,
      organizationsFound:list.filter(r=>r.organizationFound===true).length,peopleMatched:list.reduce((n,r)=>n+(r.peopleMatched??0),0),
      directorOrOwner:list.filter(r=>r.directorOrOwner===true).length,verifiedEmailIndicated:list.filter(r=>r.verifiedEmailIndicated===true).length,
      unknownOrganization:list.filter(r=>r.organizationFound===null).length,held:list.filter(r=>r.hold).length}];}));
  return {rows,segments,credits:{...discovery.totals}};
}
