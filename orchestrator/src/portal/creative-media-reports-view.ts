/**
 * Private Amazon report importer. Shows actual user-uploaded report figures,
 * not invented conversion or per-product affiliate attribution.
 */
import { csrfField, layout, type Shell } from './seo-blog-view.js';
import { base, STYLE } from './creative-studio-view.js';
import type { SavedReportSummary } from '../creative-studio/amazon-report-pg-store.js';
const e=(v:unknown)=>String(v??'').replace(/[&<>"']/gu,(c)=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
}[c]!));
const gbp=(p:number):string=>'£'+(p/100).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});

export function creativeMediaReportsPage(shell:Shell,reports:readonly SavedReportSummary[],commandId:string):string{
  const form='<section class="card"><h2>Import Amazon Associates report</h2>'
    +'<p class="small muted">Open Amazon Associates Central &gt; Reports &gt; Tracking ID Summary &gt; Download Reports. '
    +'Use the CSV/.txt export, then choose the exact report date range. This is stored privately in your business workspace.</p>'
    +'<form method="post" action="'+base(shell)+'/reports" enctype="multipart/form-data">'
    +csrfField(shell.csrf)+'<input type="hidden" name="commandId" value="'+e(commandId)+'">'
    +'<div class="row"><div><label for="report-start">First report date</label><input id="report-start" name="reportStart" type="date" required></div>'
    +'<div><label for="report-end">Last report date</label><input id="report-end" name="reportEnd" type="date" required></div></div>'
    +'<label for="report-file">Amazon Tracking ID Summary report (.txt or .csv, max 2 MB)</label>'
    +'<input id="report-file" name="file" type="file" required accept=".csv,.txt,text/plain,text/csv">'
    +'<p class="small muted">No customer records, generated Amazon orders or fake commissions. '
    +'We keep the parsed tracking-ID summary, not the original file.</p>'
    +'<button type="submit">Import real report</button></form></section>';
  const records=reports.map((r)=>{
    const s=r.summary;
    const unknown=s.unknownEarningsRows;
    return '<article class="card"><h3>'+e(r.reportStart)+' to '+e(r.reportEnd)+'</h3>'
      +'<p><strong>'+gbp(s.knownEarningsMinor)+'</strong> known earnings'
      +(unknown?' · <span class="pill warn">'+unknown+' rows unknown</span>':'')+'</p>'
      +'<p class="small muted">'+gbp(s.unallocatedEarningsMinor)+' recorded in Others/unallocated.'
      +' This must not be assigned to specific videos or products.</p>'
      +'<p class="small muted">Known clicks: '+String(s.clicksKnown)+' · Unknown click rows: '
      +String(s.clicksUnknownRows)+' · Uploaded '+e(r.createdAt.slice(0,10))+'</p>'
      +'</article>';
  }).join('');
  const lead='<section class="card"><h1>Affiliate earnings reports</h1>'
    +'<p class="muted">Import actual Tracking ID Summary figures to see earnings reported by Amazon. '
    +'An unknown or suppressed figure is not zero, and reported earnings are not necessarily money paid out. '
    +'Views and outbound clicks are separate metrics.</p>'
    +'<p><a href="'+base(shell)+'">Back to Creative Studio</a> · '
    +'<a href="'+base(shell)+'/products">Manage products</a></p></section>';
  return layout(shell,'Affiliate reports',STYLE+lead+form+'<section><h2>Imported statements ('
    +String(reports.length)+')</h2>'+(records||'<p>No reports uploaded yet.</p>')+'</section>');
}
