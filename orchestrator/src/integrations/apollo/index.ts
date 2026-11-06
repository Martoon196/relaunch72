/** Private discovery only. This module has no campaign, queue or sending dependency. */
import { randomUUID } from 'node:crypto';

export type Operation = 'org-search' | 'people-search' | 'enrich';
export interface CompanySeed { name: string; domain: string; company_number?: string; postcode?: string; segment: string }
export interface CorporateCompany {
  name: string; domain: string; company_number: string; company_status: 'active'; company_type: string;
  sic_codes: string[]; subscriber_class: 'corporate'; domain_source: 'owner-approved-company-seed';
}
export interface Usage {
  enabled: boolean; brandLimit: number; globalLimit: number; brandUsedOrReserved: number;
  globalUsedOrReserved: number; remaining: number; freeAllowanceConfirmed: boolean; resetAt: string | null;
}
export interface Prospect {
  source_vendor: 'apollo'; vendor_record_id: string; retrieved_at: string; vendor_confidence: string | null;
  licence_ref: 'apollo-free-internal'; company_number: string; domain: string; company_status: string;
  company_type: string; sic_codes: string[]; subscriber_class: 'corporate'; email: string | null;
  title: string | null; credits_spent: number | null; credits_reserved: number;
}
export interface ApolloStore {
  usage(): Promise<Usage>;
  seed(company: CorporateCompany): Promise<void>;
  reserve(input: {id: string; operation: Operation; company_number: string; domain: string; vendor_record_id?: string}): Promise<{reserved: number}>;
  settle(id: string, actual: number | null, blocked?: boolean): Promise<void>;
  save(callId: string, record: Prospect): Promise<void>;
}
export class ApolloHold extends Error { constructor(readonly code: string) { super(code); this.name = 'ApolloHold'; } }
type Json = Record<string, unknown>;
const object = (v: unknown): Json => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const text = (v: unknown): string | null => typeof v === 'string' && v.length <= 1000 ? v : null;
export const normaliseEmail = (v: string): string => v.trim().toLowerCase();
export function normaliseDomain(v: string): string {
  const s = v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(s) || s.includes('..') || s.length > 253) throw new ApolloHold('invalid_company_domain');
  return s.replace(/^www\./, '');
}
export function corporateProfile(profile: unknown, seed: CompanySeed): CorporateCompany {
  const p = object(profile), type = text(p.type), number = text(p.company_number);
  if (p.company_status !== 'active' || !type || !['ltd','plc','llp','limited-liability-partnership'].includes(type)
    || !number || !/^[A-Z0-9]{8}$/.test(number) || (seed.company_number && seed.company_number.toUpperCase().padStart(8,'0') !== number)) {
    throw new ApolloHold('not_verified_active_corporate');
  }
  const norm = (v: string) => v.toLowerCase().replace(/\b(limited|ltd|plc|llp)\b/g,'').replace(/[^a-z0-9]/g,'');
  if (!seed.name.trim() || norm(seed.name) !== norm(String(p.company_name ?? ''))) throw new ApolloHold('company_name_mismatch');
  return {name: String(p.company_name), domain: normaliseDomain(seed.domain), company_number: number,
    company_status: 'active', company_type: type, sic_codes: strings(p.sic_codes), subscriber_class: 'corporate', domain_source: 'owner-approved-company-seed'};
}

/** CH first; no Apollo payload is made for an unverified/ambiguous seed. */
export class CompaniesHouseClient {
  constructor(private readonly key: string, private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r,ms))) {}
  private async get(path: string): Promise<Json> {
    if (!this.key) throw new ApolloHold('companies_house_key_missing');
    for (let attempt=0; attempt<3; attempt++) {
      const r=await this.fetcher(`https://api.company-information.service.gov.uk${path}`, {
        headers:{authorization:`Basic ${Buffer.from(`${this.key}:`).toString('base64')}`}, redirect:'error', signal:AbortSignal.timeout(15000)});
      if (r.status===429 && attempt<2) { const wait=Number(r.headers.get('retry-after')??5); await this.sleep(Math.min(300000,Math.max(1000,wait*1000))); continue; }
      if (!r.ok) throw new ApolloHold(`companies_house_http_${r.status}`);
      return object(await r.json());
    }
    throw new ApolloHold('companies_house_rate_limit');
  }
  async verify(seed: CompanySeed): Promise<CorporateCompany> {
    let number=seed.company_number?.trim().toUpperCase().padStart(8,'0');
    if (!number) {
      if (!seed.postcode?.trim()) throw new ApolloHold('company_number_or_postcode_required');
      const result=await this.get(`/search/companies?q=${encodeURIComponent(seed.name)}&items_per_page=100`);
      const postcode=seed.postcode.replace(/\s/g,'').toUpperCase();
      const matches=(Array.isArray(result.items)?result.items:[]).map(object).filter(x=>
        String(object(x.address).postal_code??'').replace(/\s/g,'').toUpperCase()===postcode
        && String(x.title??'').toLowerCase()===seed.name.toLowerCase());
      if(matches.length!==1)throw new ApolloHold('ambiguous_companies_house_match');
      number=text(matches[0]!.company_number)??undefined;
    }
    if (!number || !/^[A-Z0-9]{8}$/.test(number)) throw new ApolloHold('invalid_company_number');
    return corporateProfile(await this.get(`/company/${encodeURIComponent(number)}`),{...seed,company_number:number});
  }
}

export interface PeopleFilters { titles?: string[]; seniorities?: string[]; locations?: string[]; industryIds?: string[] }
export interface SearchPreview { company: CorporateCompany; orgFound: boolean | null; peopleMatched: number;
  directorOrOwner: boolean; verifiedEmailIndicated: boolean | null; previewIds: string[] }
const PATHS: Record<Operation,string> = {'org-search':'mixed_companies/search','people-search':'mixed_people/api_search','enrich':'people/match'};
export class ApolloDiscovery {
  readonly totals={actualCredits:0,reservedCredits:0,unknownCalls:0};
  private stopped=false;
  constructor(private readonly store:ApolloStore,private readonly companies:CompaniesHouseClient,
    private readonly options:{enabled:boolean;apiKey:string;maxRunCredits:number;fetcher?:typeof fetch;
      sleep?:(ms:number)=>Promise<void>;log?:(entry:Record<string,unknown>)=>void}) {
    if(!Number.isInteger(options.maxRunCredits)||options.maxRunCredits<0||options.maxRunCredits>25)throw new ApolloHold('coverage_limit_must_be_0_to_25');
  }
  private async ready():Promise<void>{
    if(!this.options.enabled||this.stopped)throw new ApolloHold('apollo_disabled_or_stopped');
    if(!this.options.apiKey)throw new ApolloHold('apollo_key_missing');
    if(!(await this.store.usage()).enabled)throw new ApolloHold('private_brand_not_enabled');
  }
  private async call(operation:Operation, company:CorporateCompany, payload:Json, vendorId?:string):Promise<{body:Json;id:string;actual:number|null;reserved:number}>{
    await this.ready();
    const bound=operation==='people-search'?0:1;
    if(this.totals.reservedCredits+bound>this.options.maxRunCredits)throw new ApolloHold('coverage_credit_cap');
    const id=randomUUID();
    const reservation=await this.store.reserve({id,operation,company_number:company.company_number,domain:company.domain,...(vendorId?{vendor_record_id:vendorId}:{})});
    this.totals.reservedCredits+=reservation.reserved;
    let actual:number|null=null,blocked=false,status:number|undefined;
    try{
      let response:Response|undefined;
      for(let attempt=0;attempt<3;attempt++){
        response=await (this.options.fetcher??fetch)(`https://api.apollo.io/api/v1/${PATHS[operation]}`,{
          method:'POST',headers:{'content-type':'application/json','x-api-key':this.options.apiKey},
          body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(20000)});
        status=response.status;
        this.options.log?.({vendor:'apollo',attemptId:id,operation,retry:attempt,status,reservedCredits:bound});
        // Only retry a documented zero-credit search. Paid timeouts/5xx/429 retain the reservation.
        if(bound===0&&(status===429||status>=500)&&attempt<2){
          const delay=Number(response.headers.get('retry-after')??2**attempt);
          await (this.options.sleep??(ms=>new Promise(r=>setTimeout(r,ms))))(Math.min(60000,Math.max(250,delay*1000)));continue;
        }
        break;
      }
      if(bound===0)actual=0;
      if(!response)throw new ApolloHold('apollo_no_response');
      if(!response.ok){blocked=[401,402,403,422].includes(response.status);throw new ApolloHold(`apollo_http_${response.status}`);}
      const body=object(await response.json());
      // Never infer a free paid-endpoint call from missing response accounting. Unknown charges hold further paid work.
      if(bound>0 && typeof body.credits_consumed==='number' && Number.isInteger(body.credits_consumed) && body.credits_consumed>=0)actual=body.credits_consumed;
      if(actual!==null&&actual>bound)blocked=true;
      if(blocked)throw new ApolloHold('apollo_cost_exceeded_reserved_bound');
      return {body,id,actual,reserved:reservation.reserved};
    }finally{
      if(actual===null){this.totals.unknownCalls++;if(bound>0)this.stopped=true;}else this.totals.actualCredits+=actual;
      if(blocked)this.stopped=true;
      await this.store.settle(id,actual,blocked);
      this.options.log?.({vendor:'apollo',attemptId:id,operation,status:status??'network_error',actualCredits:actual,reservedCredits:bound,blocked});
    }
  }
  async preview(seed:CompanySeed,filters:PeopleFilters={}):Promise<SearchPreview>{
    await this.ready();
    const company=await this.companies.verify(seed); await this.store.seed(company);
    const list=(a:string[]|undefined)=>a?.slice(0,20).map(x=>x.slice(0,200));
    const r=await this.call('people-search',company,{q_organization_domains_list:[company.domain],per_page:100,page:1,
      person_titles:list(filters.titles),person_seniorities:list(filters.seniorities),person_locations:list(filters.locations),organization_industry_tag_ids:list(filters.industryIds)});
    const people=(Array.isArray(r.body.people)?r.body.people:[]).map(object);
    const ids:string[]=[];
    for(const p of people){
      const id=text(p.id);if(!id)continue;
      const org=object(p.organization),domain=text(org.primary_domain);
      // Returned identities must be bound to the approved company before they can ever be enriched.
      if(!domain||normaliseDomain(domain)!==company.domain)continue;
      const record=this.provenance(p,company,r.actual,r.reserved);await this.store.save(r.id,record);ids.push(id);
    }
    const total=Number(object(r.body.pagination).total_entries??r.body.total_entries??people.length);
    return {company,orgFound:ids.length>0?true:null,peopleMatched:Number.isFinite(total)?total:people.length,
      directorOrOwner:people.some(p=>/\b(owner|founder|director|chief executive|ceo|managing partner)\b/i.test(String(p.title??''))),
      verifiedEmailIndicated:people.some(p=>p.email_status==='verified')?true:null,previewIds:ids};
  }
  async organizations(company:CorporateCompany):Promise<Json>{
    return (await this.call('org-search',company,{q_organization_domains_list:[company.domain],page:1,per_page:100})).body;
  }
  async enrich(company:CorporateCompany,vendorId:string):Promise<Prospect>{
    if(!vendorId.trim()||vendorId.length>200)throw new ApolloHold('invalid_vendor_id');
    const r=await this.call('enrich',company,{id:vendorId,reveal_personal_emails:false,reveal_phone_number:false,run_waterfall_email:false,run_waterfall_phone:false},vendorId);
    const p=object(r.body.person),org=object(p.organization);
    if(p.id!==vendorId || normaliseDomain(String(org.primary_domain??''))!==company.domain)throw new ApolloHold('enrichment_company_mismatch');
    const record=this.provenance(p,company,r.actual,r.reserved);await this.store.save(r.id,record);return record;
  }
  private provenance(p:Json,c:CorporateCompany,actual:number|null,reserved:number):Prospect{
    return {source_vendor:'apollo',vendor_record_id:String(p.id),retrieved_at:new Date().toISOString(),vendor_confidence:text(p.email_status),
      licence_ref:'apollo-free-internal',company_number:c.company_number,domain:c.domain,company_status:c.company_status,company_type:c.company_type,
      sic_codes:c.sic_codes,subscriber_class:'corporate',email:typeof p.email==='string'&&normaliseEmail(p.email).split('@')[1]===c.domain?normaliseEmail(p.email):null,title:text(p.title),credits_spent:actual,credits_reserved:reserved};
  }
}
