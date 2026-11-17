import {creativeMediaErasureForm} from './creative-media-erasure-view.js';
/** Server-rendered private source intake using the existing Creative Studio shell and CSRF. */
import type { VideoSourceRow } from '../creative-studio/media-video-source-pg-store.js';
import { csrfField, layout, type Shell } from './seo-blog-view.js';
import { base, STYLE } from './creative-studio-view.js';
const e=(v:unknown):string=>String(v??'').replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function creativeVideoSourcesPage(shell:Shell,sources:readonly VideoSourceRow[],commandId:string):string {
  const listings=sources.map(s=>'<li><strong>'+e(s.fileName)+'</strong> · '+e(s.mime)
    +' · '+(s.byteLength/1048576).toFixed(2)+' MiB · rights declared: '+e(s.rights)
    +' · <span class="pill warn">'+e(s.state==='verified_technical'?'Ready to edit':s.state==='rejected'?'Could not read this video':s.state==='retry_pending'?'File unavailable — will retry':s.state==='deleted'?'Deleted':'Checking video')+'</span>'

    +'<video controls preload="none" playsinline width="320" src="'+base(shell)+'/sources/'+e(s.id)+'/stream">Private preview unsupported</video>'+creativeMediaErasureForm(shell,'source',s.id)+'</li>').join('');
  const html='<section class="card"><h2>Private video sources</h2>'
    +'<p>Store owned or licensed footage privately in the same Creative Studio asset database.</p>'
    +'<p class="notice">A successful upload is not proof of playability, licence validity or publishing permission. '
    +'Uploading does not post your video.</p>'
    +'<p><a href="'+base(shell)+'">Back to Creative Studio</a></p></section>'
    +'<section class="card"><h2>Upload footage (20 MB maximum)</h2><p>H.264 MP4 up to 1080p. iPhone HEVC / High Efficiency videos and WebM are not supported: export as H.264 / Most Compatible first. Library limit: 50 uploads or 200 MB.</p>'
    +'<form method="post" enctype="multipart/form-data" action="'+base(shell)+'/sources">'+csrfField(shell.csrf)
    +'<input type="hidden" name="commandId" value="'+e(commandId)+'">'
    +'<label>H.264 MP4 source <input type="file" name="video" accept=".mp4" required></label>'
    +'<label>Rights<select name="rights" required><option value="owned">I own this footage</option>'
    +'<option value="licensed">I hold a licence for this footage</option></select></label>'
    +'<label>Licence document (required if licensed)<input type="file" name="licenceEvidence" accept=".pdf,.txt,.png,.jpg,.jpeg"></label>'
    +'<label><input type="checkbox" name="rightsConfirmed" value="1" required> I am authorised to store and use this source.</label>'
    +'<button type="submit">Upload private video</button></form></section>'
    +'<section class="card"><h2>Saved sources ('+sources.length+')</h2>'
    +(sources.length?'<ul>'+listings+'</ul>':'<p>No source videos uploaded yet.</p>')+'</section>';
  return layout(shell,'Private video sources',STYLE+html);
}
