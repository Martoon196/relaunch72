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
   +'<p>Private MP4 exports have a 20 MB limit. Captions show a maximum six wrapped lines; longer captions are shortened. The #ad label stays on its own line.</p>'
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
   +'<button type="submit">Create private video</button>'
   +'</form></details>';
 };
 const jobs=model.jobs.map(j=>'<li><strong>'+e(({queued:'Waiting',claimed:'Creating video',completed:'Ready',failed:'Could not create video'})[j.state])+'</strong>'
   +' · saved plan v'+e(j.revision)+' · '
   +e(j.createdAt.slice(0,16))+(j.failureReason?'<p>'+e(({source_changed:'The source was deleted or changed. Choose another video.',render_failed:'The video could not be created. Retrying if possible.',renderer_unavailable:'Video processing is temporarily unavailable. We will retry.',output_invalid:'The finished video could not be checked. Try a different edit.',tool_limit:'This video exceeded a processing or storage limit. Shorten the edit or free some space.'} as Record<string,string>)[j.failureReason]??'The video could not be created. Try again.')+'</p>':'')+'</li>').join('');
 const outputs=model.outputs.map(o=>'<li><strong>Private video</strong>'
   +' · '+e(o.width)+'×'+e(o.height)+' · '
   +(o.durationMs/1000).toFixed(1)+'s'
   +'<p><video controls playsinline preload="none" width="320" src="'+path
   +'/local-outputs/'+e(o.id)+'/stream">Private review preview only</video></p>'
   +'<p class="small muted">Private render'
   +'. Review and approve before posting.</p>'+creativeMediaErasureForm(shell,'local_output',o.id)+'</li>').join('');
 const intro='<section class="card"><h1>Create a video</h1>'
  +'<p>Choose a checked video and your saved edit.'
  +' Videos can be up to five minutes long, with a 20 MB download limit. Quality adjusts to fit. We trim clips, preserve audio and add your captions.'
  +'</p>'
  +'<p class="notice">Creating a video does not post it. Check your rights, factual claims,'
  +' and advertising disclosures before posting.</p>'
  +'<p><a href="'+path+'/edits">Edit timeline</a> · <a href="'+path+'/sources">Private sources</a></p></section>';
 const content='<section><h2>Ready to render ('+eligible.length+')</h2>'
   +(eligible.map(item).join('')||'<p>Verify and save an eligible source timeline first.</p>')
   +'</section><section class="card"><h2>Private render jobs ('+model.jobs.length+')</h2>'
   +'<ul>'+jobs+'</ul></section><section class="card"><h2>Private outputs ('
   +model.outputs.length+')</h2><ul>'+outputs+'</ul></section>';
 return layout(shell,'Create a video',STYLE+intro+content);
}
