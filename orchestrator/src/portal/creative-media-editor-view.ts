/** Editable private video plan versions in the SAME PostgreSQL Creative Studio. */
import type {VideoSourceRow} from '../creative-studio/media-video-source-pg-store.js';
import type {VideoEditVersion} from '../creative-studio/media-edit-pg-store.js';
import {layout,csrfField,type Shell} from './seo-blog-view.js';
import {base,STYLE} from './creative-studio-view.js';
const e=(v:unknown)=>String(v??'').replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const blank={canvas:'portrait',disclosure:'',clips:[{startMs:0,endMs:5000,caption:'',transition:'cut',speed:1}]};
export function creativeMediaEditorPage(shell:Shell,sources:readonly VideoSourceRow[],
  projects:readonly VideoEditVersion[],newCommand:()=>string):string{
 const select='<label>Owned/private source<select name="source" required>'+sources.map(s=>
  '<option value="'+e(s.id+':'+s.sha256)+'">'+e(s.fileName)+'</option>').join('')+'</select></label>';
 const form=(p?:VideoEditVersion)=>'<form method="post" data-rl72-cut-editor data-rl72-preview-base="'+base(shell)+'" action="'+base(shell)+'/edits">'
  +csrfField(shell.csrf)
  +'<input type="hidden" name="commandId" value="'+e(newCommand())+'">'
  +'<input type="hidden" name="projectId" value="'+e(p?.id??'')+'">'
  +'<input type="hidden" name="expectedRevision" value="'+(p?.revision??0)+'">'
  +(p?'<input type="hidden" name="source" value="'+e(p.sourceId+':'+p.sourceSha256)+'">':select)
  +'<label>Editable timeline draft (JSON fallback)<textarea name="planJson" maxlength="12000" rows="8" required>'
  +e(JSON.stringify(p?.plan??blank,null,2))+'</textarea></label>'
  +'<button type="submit">Save new private timeline version</button></form>';
 const items=projects.map(p=>'<details class="card"><summary>Timeline '+e(p.id.slice(0,8))
  +' · version '+p.revision+' · '+e(p.plan.canvas)+'</summary>'+form(p)+'</details>').join('');
 const editorStyle='<style>.rl72-cut-editor{padding:14px;border:1px solid var(--line);border-radius:10px;margin:12px 0}.rl72-cut-settings,.rl72-cut-range,.rl72-cut-actions,.rl72-cut-tools{display:flex;flex-wrap:wrap;gap:8px}.rl72-cut-clip{margin:10px 0;min-width:220px}.rl72-cut-editor label{display:grid;gap:4px;min-width:140px}.rl72-cut-editor label input{min-width:90px}.rl72-cut-editor video{max-width:100%;margin:8px 0}.rl72-cut-editor output{display:block;margin:8px 0}</style>';
 return layout(shell,'Video timeline editor',STYLE+editorStyle
  +'<section class="card"><h1>Video timeline editor</h1>'
  +'<p>Trim source clips, reorder scenes, caption and select output format. Each save is a new private, immutable revision.</p>'
  +'<p class="notice">Saving is not rendering or approval. No external provider, affiliate promotion or social post is triggered.</p>'
  +'<p><a href="'+base(shell)+'">Back to Creative Studio</a> · <a href="'+base(shell)+'/sources">Video sources</a></p></section>'
  +(sources.length?'<section class="card"><h2>New timeline</h2>'+form()+'</section>':
    '<section class="card">Upload private source footage to create an edit.</section>')
  +'<section><h2>Existing timelines ('+projects.length+')</h2>'
  +(items||'<p>No saved edits yet.</p>')+'</section>',
  '<script src="/portal/seo-blog/media-cut-editor.js" defer></script>');
}
