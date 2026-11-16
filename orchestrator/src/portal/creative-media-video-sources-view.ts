import {creativeMediaErasureForm} from './creative-media-erasure-view.js';
/** Server-rendered private source intake using the existing Creative Studio shell and CSRF. */
import type { VideoSourceRow } from '../creative-studio/media-video-source-pg-store.js';
import { csrfField, layout, type Shell } from './seo-blog-view.js';
import { base, STYLE } from './creative-studio-view.js';
const e=(v:unknown):string=>String(v??'').replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function creativeVideoSourcesPage(shell:Shell,sources:readonly VideoSourceRow[],commandId:string):string {
  const listings=sources.map(s=>'<li><strong>'+e(s.fileName)+'</strong> · '+e(s.mime)
    +' · '+(s.byteLength/1048576).toFixed(2)+' MiB · rights declared: '+e(s.rights)
    +' · <span class="pill warn">Awaiting probe</span>'

    +'<video controls preload="none" playsinline width="320" src="'+base(shell)+'/sources/'+e(s.id)+'/stream">Private preview unsupported</video>'+creativeMediaErasureForm(shell,'source',s.id)+'</li>').join('');
  const html='<section class="card"><h2>Private video sources</h2>'
    +'<p>Store owned or licensed footage privately in the same Creative Studio asset database.</p>'
    +'<p class="notice">A successful upload is not proof of playability, licence validity or publishing permission. '
    +'These files cannot trigger a provider charge, clip creation or social publication.</p>'
    +'<p><a href="'+base(shell)+'">Back to Creative Studio</a></p></section>'
    +'<section class="card"><h2>Upload source footage (20 MB maximum)</h2>'
    +'<form method="post" enctype="multipart/form-data" action="'+base(shell)+'/sources">'+csrfField(shell.csrf)
    +'<input type="hidden" name="commandId" value="'+e(commandId)+'">'
    +'<label>MP4 or WebM source <input type="file" name="video" accept=".mp4,.webm" required></label>'
    +'<label>Rights<select name="rights" required><option value="owned">I own this footage</option>'
    +'<option value="licensed">I hold a licence for this footage</option></select></label>'
    +'<label>Licence document (required if licensed)<input type="file" name="licenceEvidence" accept=".pdf,.txt,.png,.jpg,.jpeg"></label>'
    +'<label><input type="checkbox" name="rightsConfirmed" value="1" required> I am authorised to store and use this source.</label>'
    +'<button type="submit">Store privately — no video service calls</button></form></section>'
    +'<section class="card"><h2>Saved sources ('+sources.length+')</h2>'
    +(sources.length?'<ul>'+listings+'</ul>':'<p>No source videos uploaded yet.</p>')+'</section>';
  return layout(shell,'Private video sources',STYLE+html);
}
