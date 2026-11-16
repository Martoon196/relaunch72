/**
 * Unmounted owner-only output review screen for Claude to wire at integration.
 * Displaying a review is never equivalent to authorising a social publication.
 */
import type {LocalRenderOutputRow} from '../creative-studio/media-local-render-pg-store.js';
import type {PrivateOutputReview} from '../creative-studio/media-output-review.js';
import {layout,csrfField,type Shell} from './seo-blog-view.js';
import {base,STYLE} from './creative-studio-view.js';

const e=(value:unknown):string=>String(value??'').replace(/[&<>"']/gu,
 c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

function decisionForm(shell:Shell,record:PrivateOutputReview,newCommand:()=>string,
 decision:'reviewed_private'|'rejected_private'|'withdrawn_private'):string {
 const approving=decision==='reviewed_private',name=approving?'Record private review':
  decision==='withdrawn_private'?'Withdraw private review':'Reject this output';
 return '<form method="post" action="'+base(shell)+'/local-outputs/review">'
  +csrfField(shell.csrf)
  +'<input type="hidden" name="commandId" value="'+e(newCommand())+'">'
  +'<input type="hidden" name="outputId" value="'+e(record.outputId)+'">'
  +'<input type="hidden" name="outputSha256" value="'+e(record.sha256)+'">'
  +'<input type="hidden" name="expectedRevision" value="'+record.revision+'">'
  +'<input type="hidden" name="decision" value="'+decision+'">'
  +(approving?'<div class="stack">'
    +'<label><input type="checkbox" name="rightsConfirmed" value="1" required> I confirm I have rights to use every source in this exact video.</label>'
    +'<label><input type="checkbox" name="claimsConfirmed" value="1" required> I checked every factual and promotional claim in this exact video.</label>'
    +'<label><input type="checkbox" name="disclosureConfirmed" value="1" required> I checked required affiliate disclosures, endorsements and platform rules.</label>'
    +'</div>':'')
  +'<button type="submit">'+name+'</button></form>';
}
export function creativeMediaLocalOutputReviewPage(
 shell:Shell,outputs:readonly LocalRenderOutputRow[],reviews:readonly PrivateOutputReview[],
 newCommand:()=>string,
):string {
 const items=outputs.map(output=>{
  const r=reviews.find(v=>v.outputId===output.id&&v.sha256===output.sha256)??{
    outputId:output.id,revision:0,sha256:output.sha256,decision:null,
    reviewedBy:null,createdAt:null,technicalStatus:'awaiting_probe' as const,
    durationMs:null,width:null,height:null,
  };
  const technical=r.technicalStatus==='verified_technical'
   ?'Video technically measured · '+e(r.width)+'×'+e(r.height)
      +' · '+e((r.durationMs??0)/1000)+' s'
   :r.technicalStatus==='rejected'?'Technical probe rejected this video'
   :'Awaiting technical measurement by a trusted worker';
  const actions=r.decision==='reviewed_private'
   ?decisionForm(shell,r,newCommand,'withdrawn_private')
   :'<div class="stack">'
      +(r.technicalStatus==='verified_technical'
         ?decisionForm(shell,r,newCommand,'reviewed_private'):'')
      +decisionForm(shell,r,newCommand,'rejected_private')+'</div>';
  return '<details class="card"><summary>Output '+e(output.id.slice(0,8))
   +' · <span class="pill warn">'+e(r.decision??'unreviewed')+'</span></summary>'

   +'<p>'+technical+'</p>'
   +'<p><video controls playsinline preload="none" width="320" src="'+base(shell)
   +'/local-outputs/'+e(output.id)+'/stream">Private video preview</video></p>'
   +'<p class="small muted">Owner review is private only. It does not certify a licence, '
   +'approve public distribution or schedule a social post.</p>'
   +actions+'</details>';
 }).join('');
 return layout(shell,'Video output reviews',STYLE
  +'<section class="card"><h1>Review exact video outputs</h1>'
  +'<p>Offline renders have a trusted technical receipt and require an explicit '
  +'owner review of rights, claims and disclosures.</p>'
  +'<p class="notice">Private review is NOT a publish button. Distribution requires '
  +'separate exact-version approval and platform policy checks.</p>'
  +'<p><a href="'+base(shell)+'/workbench">Back to media workbench</a></p></section>'
  +'<section><h2>Private output records ('+outputs.length+')</h2>'
  +(items||'<p>No local output has been rendered yet.</p>')+'</section>');
}
