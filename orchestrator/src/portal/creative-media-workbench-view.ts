const money=(n:number)=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'USD'}).format(n/1_000_000);
/** Read-only media workbench: same tenant, same Creative Studio, no automatic approvals. */
import type {MediaAccess} from '../creative-studio/media-access-pg-store.js';
import type {MediaJobSummary} from '../creative-studio/media-admission-pg-store.js';
import type {MediaOutputSummary} from '../creative-studio/media-video-output-owner.js';
import {layout,type Shell} from './seo-blog-view.js';
import {base,STYLE} from './creative-studio-view.js';
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function mediaWorkbenchPage(shell:Shell,info:{access:MediaAccess;jobs:readonly MediaJobSummary[];
 outputs:readonly MediaOutputSummary[]}):string {
 const a=info.access;
 const access='<section class="card"><h2>Shared media access</h2><p><strong>'
  +esc(a.tier??'No active media entitlement')+'</strong> · '+(a.active?'active receipt':'disabled')
  +'</p><p class="small muted">Provenance: '+esc(a.source??'none')
  +' · Billing/checkout not enabled until verified payment provisioning is connected.</p></section>';
 const jobs='<section class="card"><h2>Provider jobs ('+info.jobs.length+')</h2><ul>'
  +info.jobs.map(j=>'<li>'+esc(j.kind)+' · <strong>'+esc(j.state)+'</strong> · reserved '
  +money(j.reservedMicrousd)+' reserved · actual '+(j.actualMicrousd===null?'not reconciled':money(j.actualMicrousd))
  +'</li>').join('')+'</ul></section>';
 const outputs='<section class="card"><h2>Private captured outputs ('+info.outputs.length+')</h2><ul>'
  +info.outputs.map(o=>'<li><strong>'+esc(o.id.slice(0,8))+'</strong> · '+esc(o.mime)
  +' · <span class="pill warn">Unverified, not approved</span>'
  +'<p><video controls playsinline preload="none" width="320" src="'+base(shell)
  +'/outputs/'+esc(o.id)+'/stream">Private video preview</video></p></li>').join('')
  +'</ul></section>';
 return layout(shell,'Media workbench',STYLE
  +'<section class="card"><h1>One RL72 Media Engine</h1>'
  +'<p>Agency brands and standalone affiliate creators share this private workspace and approval system.</p>'
  +'<p><a href="'+base(shell)+'/sources">Source videos</a> · <a href="'+base(shell)+'/products">Affiliate products</a> · <a href="'+base(shell)+'">Creative Studio</a></p>'
  +'<p class="notice">No paid job, public link, or social publication is started by this page.</p></section>'
  +access+jobs+outputs);
}
