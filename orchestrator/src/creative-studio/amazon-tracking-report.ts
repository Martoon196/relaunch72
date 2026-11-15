/**
 * Parse user-provided Amazon UK Associates tracking-ID reports.
 *
 * Reports Centre provides CSV-style .txt downloads which may actually be
 * tab-delimited. The data is seller-supplied merchant report data; it is NOT a
 * live verified Amazon API response. Per-tracking-ID "Others"/hidden cells
 * must never be allocated to individual products or treated as zero.
 * Source: https://affiliate-program.amazon.co.uk/help/node/topic/GQ5FS7J76MT59WLW
 */
export interface TrackingIdReportRow {
  readonly trackingId: string;
  readonly clicks: number | null;
  readonly orderedItems: number | null;
  readonly shippedItems: number | null;
  readonly earningsMinor: number | null;
  readonly isOther: boolean;
}
export interface AmazonTrackingIdReport {
  readonly source: 'user_uploaded_amazon_tracking_id_summary';
  readonly currency: 'GBP';
  readonly rows: readonly TrackingIdReportRow[];
  readonly knownEarningsMinor: number;
  readonly unallocatedEarningsMinor: number;
  readonly unknownEarningsRows: number;
  readonly clicksKnown: number;
  readonly clicksUnknownRows: number;
  readonly hasUnallocatedEarnings: boolean;
  readonly warning: string;
}
export class AmazonReportError extends Error {
  constructor(message: string) { super(message); this.name='AmazonReportError'; }
}
function normalise(s:string):string { return s.trim().toLowerCase().replace(/[\u00a0\s\-_./()]+/gu,''); }
function parseDelimited(text:string,delimiter:string):string[][] {
  const lines:string[][]=[];let row:string[]=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i]!;
    if(quoted){
      if(ch==='"'&&text[i+1]==='"'){cell+='"';i++;continue;}
      if(ch==='"'){quoted=false;continue;}
      cell+=ch;
    }else{
      if(ch==='"'&&cell.trim()===''){quoted=true;cell='';continue;}
      if(ch===delimiter){row.push(cell.trim());cell='';continue;}
      if(ch==='\n'){row.push(cell.trim());cell='';if(row.some(Boolean))lines.push(row);row=[];continue;}
      if(ch==='\r'){if(text[i+1]==='\n')continue;row.push(cell.trim());cell='';if(row.some(Boolean))lines.push(row);row=[];continue;}
      cell+=ch;
    }
    if(lines.length>3000)throw new AmazonReportError('Report exceeds 3,000 rows');
  }
  if(quoted)throw new AmazonReportError('Unclosed quoted field in report');
  if(cell||row.length){row.push(cell.trim());if(row.some(Boolean))lines.push(row);}
  return lines;
}
function chooseDelimiter(text:string):string{
  const first=(text.split(/\r?\n/u)[0]??'').slice(0,2000);
  return (first.match(/\t/gu)??[]).length>(first.match(/,/gu)??[]).length?'\t':',';
}
const isUnknown=(s:string):boolean=>!s.trim()||/^(?:—|–|-|n\/a|hidden|suppressed|not available)$/iu.test(s.trim());
function numberCell(v:string,label:string):number|null{
  if(isUnknown(v))return null;
  const value=v.replace(/,/gu,'').trim();
  if(!/^[0-9]+$/u.test(value))throw new AmazonReportError('Invalid '+label+' figure in report');
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n>1_000_000_000)throw new AmazonReportError('Report '+label+' figure is out of range');
  return n;
}
function poundsCell(v:string):number|null{
  if(isUnknown(v))return null;
  let s=v.trim();
  const accounting=s.startsWith('(')&&s.endsWith(')');
  if(accounting)s=s.slice(1,-1);
  if(/[$€]/u.test(s))throw new AmazonReportError('Foreign currency mixed into a GBP report');
  s=s.replace(/[£,\u00a0\s]/gu,'');
  if(!/^-?[0-9]+(?:\.[0-9]{1,2})?$/u.test(s))throw new AmazonReportError('Invalid GBP earnings amount');
  if(accounting)s='-'+s;
  const [whole,fraction='']=s.replace('-','').split('.');
  const pennies=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(pennies)||pennies>9_000_000_000_000)
    throw new AmazonReportError('GBP earnings amount is out of range');
  return s.startsWith('-')?-pennies:pennies;
}
function column(headers:string[],names:string[]):number{
  return headers.findIndex(h=>names.includes(normalise(h)));
}
export function parseAmazonTrackingReport(text:string):AmazonTrackingIdReport{
  if(typeof text!=='string'||text.length<15||Buffer.byteLength(text,'utf8')>2_000_000)
    throw new AmazonReportError('Choose a small, nonempty Amazon report (maximum 2 MB)');
  const clean=text.replace(/^\uFEFF/u,'').replace(/\u0000/gu,'');
  const rows=parseDelimited(clean,chooseDelimiter(clean));
  if(rows.length<2)throw new AmazonReportError('Report contains no tracking-ID data');
  // Some exported files prepend a title/date above the actual column names.
  const headerAt=rows.findIndex(r=>r.some(c=>['trackingid','trackingids'].includes(normalise(c))));
  if(headerAt<0||headerAt>12)throw new AmazonReportError('This is not a Tracking ID Summary report');
  const headers=rows[headerAt]!;
  const idColumn=column(headers,['trackingid','trackingids']);
  const clicks=column(headers,['clicks','productlinkclicks','linkclicks']);
  const ordered=column(headers,['ordereditems','itemsordered','orders']);
  const shipped=column(headers,['shippeditems','itemsshipped','dispatcheditems','itemsdispatched']);
  const earnings=column(headers,['earnings','totalearnings','commissionincome','referralfees','advertisingfees','totaladvertisingfees']);
  if(idColumn<0||earnings<0)throw new AmazonReportError('Tracking ID and Earnings columns are required');
  if(rows.length-headerAt-1>2000)throw new AmazonReportError('Too many tracking IDs; split the download');
  const output:TrackingIdReportRow[]=[];
  for(const r of rows.slice(headerAt+1)){
    const id=(r[idColumn]??'').trim();
    if(!id)continue;
    if(/^(?:total|grand total|all tracking ids|summary)$/iu.test(id))continue; // prevent double-count
    if(id.length>120||/[\u0000-\u001f<>]/u.test(id))throw new AmazonReportError('Invalid tracking ID');
    const item:TrackingIdReportRow={
      trackingId:id,
      clicks:clicks<0?null:numberCell(r[clicks]??'','clicks'),
      orderedItems:ordered<0?null:numberCell(r[ordered]??'','ordered items'),
      shippedItems:shipped<0?null:numberCell(r[shipped]??'','shipped items'),
      earningsMinor:poundsCell(r[earnings]??''),
      isOther:/^(?:others?|unattributed|unallocated)$/iu.test(id),
    };
    output.push(item);
  }
  if(!output.length)throw new AmazonReportError('Report has no tracking-ID rows');
  const known=output.reduce((n,r)=>n+(r.earningsMinor??0),0);
  const unallocated=output.filter(x=>x.isOther).reduce((n,r)=>n+(r.earningsMinor??0),0);
  const unknown=output.filter(x=>x.earningsMinor===null).length;
  const clicksUnknown=output.filter(x=>x.clicks===null).length;
  const clicksKnown=output.reduce((n,r)=>n+(r.clicks??0),0);
  return Object.freeze({
    source:'user_uploaded_amazon_tracking_id_summary' as const,
    currency:'GBP' as const,rows:Object.freeze(output),
    knownEarningsMinor:known,unallocatedEarningsMinor:unallocated,
    unknownEarningsRows:unknown,clicksKnown,clicksUnknownRows:clicksUnknown,
    hasUnallocatedEarnings:output.some(x=>x.isOther),
    warning:'User-uploaded Amazon report. Unknown cells are not zero; Others cannot be allocated to a campaign or product. Report periods may not align with individual outbound clicks.',
  });
}
