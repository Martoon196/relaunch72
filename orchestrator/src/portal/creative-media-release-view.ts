import {csrfField,type Shell} from './seo-blog-view.js';
import {base} from './creative-studio-view.js';
const e=(v:unknown)=>String(v??'').replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Embed only with a saved canonical job/media snapshot from this owner workspace. */
export function nativeVideoReleaseForm(shell:Shell,input:{jobId:string;contentVersionId:string;outputSha256:string;caption:string;network:string;scheduledFor:string;authorized:boolean},commandId:string):string{
 const fields=csrfField(shell.csrf)+'<input type="hidden" name="jobId" value="'+e(input.jobId)+'"><input type="hidden" name="contentVersionId" value="'+e(input.contentVersionId)+'"><input type="hidden" name="commandId" value="'+e(commandId)+'">';
 return '<section class="card"><h2>Video distribution</h2><p>'+e(input.network)+' · '+e(input.scheduledFor)+'</p><p>'+e(input.caption)+'</p><p>Approval is managed in the RL72 content queue.</p><form method="post" action="'+base(shell)+'/video-releases">'+fields+'<input type="hidden" name="action" value="withdraw"><input type="hidden" name="consent" value="1"><button type="submit">Take down remaining distribution permission</button></form><p>Stops future attempts. Provider-accepted posts need canonical provider takedown.</p></section>';
}
