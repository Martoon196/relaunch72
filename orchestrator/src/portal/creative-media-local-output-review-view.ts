/**
 * Unmounted owner-only output review screen for Claude to wire at integration.
 * Displaying a review is never equivalent to authorising a social publication.
 */
import type {LocalRenderOutputRow} from '../creative-studio/media-local-render-pg-store.js';
import type {PrivateOutputReview} from '../creative-studio/media-private-review.js';
import {layout,csrfField,type Shell} from './seo-blog-view.js';
import {base,STYLE} from './creative-studio-view.js';

const e=(value:unknown):string=>String(value??'').replace(/[&<>"']/gu,
 c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

function decisionForm(shell:Shell,record:PrivateOutputReview,newCommand:()=>string,
 decision:'reviewed_private'|'rejected_private'|'withdrawn_private'):string {
 const approving=decision==='reviewed_private',name=approving?'Mark as reviewed':
  decision==='withdrawn_private'?'Undo review':'Needs changes';
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
   ?'Video ready to review · '+e(r.width)+'×'+e(r.height)
      +' · '+e((r.durationMs??0)/1000)+' s'
   :r.technicalStatus==='rejected'?'This video could not be read'
   :'Checking this video';
  const actions=r.decision==='reviewed_private'
   ?decisionForm(shell,r,newCommand,'withdrawn_private')
   :'<div class="stack">'
      +(r.technicalStatus==='verified_technical'
         ?decisionForm(shell,r,newCommand,'reviewed_private'):'')
      +decisionForm(shell,r,newCommand,'rejected_private')+'</div>';
  return '<details class="card"><summary>Video'
   +' · <span class="pill warn">'+e(r.decision==='reviewed_private'?'Reviewed':r.decision==='rejected_private'?'Needs changes':r.decision==='withdrawn_private'?'Review withdrawn':'Needs review')+'</span></summary>'

   +'<p>'+technical+'</p>'
   +'<p><video controls playsinline preload="none" width="320" src="'+base(shell)
   +'/local-outputs/'+e(output.id)+'/stream">Private video preview</video></p>'
   +'<p class="small muted">Check that you have rights to use this video, '
   +'and that its claims and advertising disclosures are correct.</p>'
   +actions+'</details>';
 }).join('');
 return layout(shell,'Review videos',STYLE
  +'<section class="card"><h1>Review your videos</h1>'
  +'<p>Check your finished video before posting. Review the '
  +'rights, claims and advertising disclosures.</p>'
  +'<p class="notice">Reviewing a video does not post it. You choose '
  +'when to publish it.</p>'
  +'<p><a href="'+base(shell)+'/local-renders">Back to videos</a></p></section>'
  +'<section><h2>Your videos ('+outputs.length+')</h2>'
  +(items||'<p>No local output has been rendered yet.</p>')+'</section>');
}
