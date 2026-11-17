import {creativeMediaErasureForm} from './creative-media-erasure-view.js';
/**
 * UNMOUNTED owner view for offline native video render requests.
 * Claude will connect GET/POST and private byte-range preview after reviewing
 * canonical session/CSRF, SQL and worker rollout. No live route is added here.
 */
import type { VideoEditVersion } from '../creative-studio/media-edit-pg-store.js';
import type { VideoSourceRow } from '../creative-studio/media-video-source-pg-store.js';
import type { LocalRenderJobRow,LocalRenderOutputRow } from '../creative-studio/media-local-render-pg-store.js';
import { layout, csrfField, type Shell } from './seo-blog-view.js';
import { base, STYLE } from './creative-studio-view.js';

const e=(v:unknown):string=>String(v??'').replace(/[&<>"']/gu,c=>
 ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function creativeMediaLocalRenderPage(shell:Shell, model:{
 readonly projects:readonly VideoEditVersion[];
 readonly sources:readonly VideoSourceRow[];
 readonly probes:readonly {sourceId:string;status:'verified_technical'|'rejected'}[];
 readonly jobs:readonly LocalRenderJobRow[];
 readonly outputs:readonly LocalRenderOutputRow[];
 readonly newCommand:()=>string;
 readonly newJob:()=>string;
}):string {
 const path=base(shell);
 const sourceById=new Map(model.sources.map(x=>[x.id,x]));
 const probeBySource=new Map(model.probes.map(x=>[x.sourceId,x.status]));
 const eligible=model.projects.filter(p=>
  sourceById.has(p.sourceId)
  &&probeBySource.get(p.sourceId)==='verified_technical'
  &&sourceById.get(p.sourceId)!.sha256===p.sourceSha256);
 const item=(p:VideoEditVersion)=>{
  const source=sourceById.get(p.sourceId);
  const duration=p.plan.clips.reduce((sum,c)=>sum+(c.endMs-c.startMs)/c.speed,0)/1000;
  return '<details class="card"><summary><strong>'+e(source?.fileName??'Video source')
   +'</strong> · '+e(p.plan.canvas)+' · v'+e(p.revision)
   +' · '+duration.toFixed(1)+' s</summary>'
   +'<p>Private MP4 exports have a 20 MB limit. Captions show a maximum four wrapped lines; longer captions are shortened. The #ad label stays on its own line.</p>'
   +'<form method="post" action="'+path+'/local-renders">'
   +csrfField(shell.csrf)
   +'<input type="hidden" name="commandId" value="'+e(model.newCommand())+'">'
   +'<input type="hidden" name="jobId" value="'+e(model.newJob())+'">'
   +'<input type="hidden" name="projectId" value="'+e(p.id)+'">'
   +'<input type="hidden" name="revision" value="'+e(p.revision)+'">'
   +'<input type="hidden" name="sourceSha256" value="'+e(p.sourceSha256)+'">'
   +'<input type="hidden" name="planSha256" value="'+e(p.planSha256)+'">'
   +'<label><input type="checkbox" name="rightsConfirmed" value="1" required>'
   +' I confirm I own this source or hold the necessary licence to render this exact version.</label>'
   +'<button type="submit">Queue private local render — no paid video service</button>'
   +'</form></details>';
 };
 const jobs=model.jobs.map(j=>'<li><strong>'+e(j.state)+'</strong> · '+e(j.id.slice(0,8))
   +' · saved plan v'+e(j.revision)+' · '
   +e(j.createdAt.slice(0,16))+'</li>').join('');
 const outputs=model.outputs.map(o=>'<li><strong>Private MP4 '+e(o.id.slice(0,8))+'</strong>'
   +' · '+e(o.width)+'×'+e(o.height)+' · '
   +(o.durationMs/1000).toFixed(1)+'s'
   +'<p><video controls playsinline preload="none" width="320" src="'+path
   +'/local-outputs/'+e(o.id)+'/stream">Private review preview only</video></p>'
   +'<p class="small muted">Private render'
   +'. Canonical approval required.</p>'+creativeMediaErasureForm(shell,'local_output',o.id)+'</li>').join('');
 const intro='<section class="card"><h1>Offline native video renders</h1>'
  +'<p>Use an independently probed private video and your saved edit plan.'
  +' Exports are limited to 20 MB; timelines that cannot fit are rejected before encoding. The trusted worker will trim clips, preserve audio, add captions and export a new private MP4.'
  +' No external Vizard or Shotstack call is needed.</p>'
  +'<p class="notice">Draft workspace only. Rendering is not social publishing, affiliate compliance,'
  +' merchant approval or proof of a video licence. This screen is not connected to the live portal.</p>'
  +'<p><a href="'+path+'/edits">Edit timeline</a> · <a href="'+path+'/sources">Private sources</a></p></section>';
 const content='<section><h2>Ready to render ('+eligible.length+')</h2>'
   +(eligible.map(item).join('')||'<p>Verify and save an eligible source timeline first.</p>')
   +'</section><section class="card"><h2>Private render jobs ('+model.jobs.length+')</h2>'
   +'<ul>'+jobs+'</ul></section><section class="card"><h2>Private outputs ('
   +model.outputs.length+')</h2><ul>'+outputs+'</ul></section>';
 return layout(shell,'Offline video renders',STYLE+intro+content);
}
