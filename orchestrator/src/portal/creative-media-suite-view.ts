/** Unmounted workspace presentation, backed by the same workspace services. */
import {layout,type Shell} from './seo-blog-view.js';
import {base,STYLE} from './creative-studio-view.js';
export const AFFILIATE_STUDIO_PRESENTATION=Object.freeze({key:'affiliate_studio',name:'RL72 Affiliate Studio',summary:'Turn your products and owned footage into reviewed campaigns.',identity:'canonical_rl72',storage:'canonical_workspace',approval:'canonical_queue'});
const e=(v:unknown)=>String(v??'').replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export interface MediaSuiteModel {audience:'agency'|'affiliate';counts:{products:number;sources:number;timelines:number;renders:number;reports:number};available:ReadonlySet<string>}
export function creativeMediaSuitePage(shell:Shell,model:MediaSuiteModel):string{
 const path=base(shell),name=model.audience==='affiliate'?AFFILIATE_STUDIO_PRESENTATION.name:'RL72 Creative Studio';
 const steps=[['sources','Footage','Upload H.264 up to 1080p privately.',model.counts.sources],['edits','Edit','Trim clips and add captions.',model.counts.timelines],['local-renders','Render','Private MP4 exports, maximum 20 MB.',model.counts.renders],['local-outputs/review','Review','Review rights, claims and visible disclosure.',null]] as const;
 const cards=steps.map(([route,title,description,count])=>'<article class="card"><h2>'+e(title)+(count===null?'':' <span class="pill">'+e(count)+'</span>')+'</h2><p>'+e(description)+'</p>'+(model.available.has(route)?'<a class="btn" href="'+path+'/'+route+'">Open '+e(title.toLowerCase())+'</a>':'<span class="pill warn">Awaiting integration</span>')+'</article>').join('');
 return layout(shell,name,STYLE+'<style>.media-suite-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:16px}.media-suite-grid .card{margin:0}.media-suite-hero{padding:28px;border-left:4px solid var(--accent)}</style><section class="card media-suite-hero"><p class="small muted">PRODUCT → FOOTAGE → EDIT → REVIEW</p><h1>'+e(name)+'</h1><p>'+e(AFFILIATE_STUDIO_PRESENTATION.summary)+'</p><p>Videos stay private until approved in the canonical queue.</p></section><div class="media-suite-grid">'+cards+'</div>');
}
