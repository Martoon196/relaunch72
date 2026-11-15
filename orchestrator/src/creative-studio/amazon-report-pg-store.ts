/**
 * Owner-session-bound, immutable Amazon report uploads (migration 0157).
 * Parsing is local and deterministic: reports cannot create orders/commission
 * attribution that Amazon does not actually supply.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { PgSeoBlogPrincipal } from '../seo-blog/pg-store.js';
import { SeoBlogError } from '../seo-blog/types.js';
import { parseAmazonTrackingReport, type AmazonTrackingIdReport } from './amazon-tracking-report.js';

export interface SavedReportSummary {
  readonly id:string;
  readonly source:string;
  readonly reportStart:string;
  readonly reportEnd:string;
  readonly currency:'GBP';
  readonly summary:Omit<AmazonTrackingIdReport,'rows'>;
  readonly createdAt:string;
}
const dateCheck=(s:string):boolean=>{
  if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(s))return false;
  const date=new Date(s+'T00:00:00Z');
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===s;
};
export class PgAmazonTrackingReports {
  private readonly hash:Buffer|null;
  constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal){
    this.hash=principal.kind==='user'?createHash('sha256').update(principal.sessionToken).digest():null;
  }
  private async call<T>(workspaceId:string,action:'list'|'save',body:Record<string,unknown>):Promise<T>{
    const p=this.principal;
    if(p.kind!=='user'||!this.hash)throw new SeoBlogError(403,'A signed-in brand owner is required');
    try{
      return await withTransaction(this.pool,{
        actorKind:'user',workspaceId,userId:p.userId,requestId:p.requestId,
        portalSessionTokenHash:this.hash,
      },async(t)=>{
        const r=await t.query<{value:T}>(
          'SELECT app_private.creative_media_report_command($1,$2,$3,$4) AS value',
          [workspaceId,this.hash,action,JSON.stringify(body)]);
        return r.rows[0]!.value;
      });
    }catch(e){
      const code=(e as {code?:string}).code;
      if(code==='42501')throw new SeoBlogError(403,'Owner session or brand permission could not be confirmed');
      if(code==='40001'||code==='23505')throw new SeoBlogError(409,'This report is already imported or changed');
      if(code==='22023'||code==='22P02'||code==='23514'||code==='22008')throw new SeoBlogError(400,'Check the report and dates');
      if(code==='55000')throw new SeoBlogError(409,'Report import allowance is full');
      throw e;
    }
  }
  list(workspaceId:string):Promise<SavedReportSummary[]>{
    return this.call(workspaceId,'list',{});
  }
  save(input:{
    readonly workspaceId:string;readonly reportStart:string;readonly reportEnd:string;
    readonly originalText:string;readonly commandId?:string;
  }):Promise<{replayed:boolean;id:string}>{
    if(!dateCheck(input.reportStart)||!dateCheck(input.reportEnd)||
      input.reportStart>input.reportEnd||
      (Date.parse(input.reportEnd+'T00:00:00Z')-Date.parse(input.reportStart+'T00:00:00Z'))>366*86400*1000)
      throw new SeoBlogError(400,'Enter a valid report range (up to 366 days)');
    const parsed=parseAmazonTrackingReport(input.originalText);
    const id=input.commandId??randomUUID();
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id))
      throw new SeoBlogError(400,'Invalid import command');
    const sourceSha=createHash('sha256').update(input.originalText,'utf8').digest('hex');
    const payload={...parsed,warning:parsed.warning};
    const inputSha=createHash('sha256').update(JSON.stringify({
      sourceSha,reportStart:input.reportStart,reportEnd:input.reportEnd,payload,
    })).digest('hex');
    return this.call(input.workspaceId,'save',{
      id,sourceSha,inputSha,source:parsed.source,
      currency:parsed.currency,reportStart:input.reportStart,
      reportEnd:input.reportEnd,payload,
    });
  }
}
