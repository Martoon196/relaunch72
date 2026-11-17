import test from 'node:test';
import assert from 'node:assert/strict';
import {wrappedVideoCaption,localRenderBitrate,assertLocalRenderCapacity,renderLocalVideo} from '../src/creative-studio/media-local-render.js';
import {checkVideoEditPlan} from '../src/creative-studio/media-edit-plan.js';
import {captionWidth} from '../src/creative-studio/media-caption-font.js';
import {creativeMediaLocalRenderPage} from '../src/portal/creative-media-local-render-view.js';
import {creativeVideoSourcesPage} from '../src/portal/creative-media-video-sources-view.js';
import {creativeMediaLocalOutputReviewPage} from '../src/portal/creative-media-local-output-review-view.js';
import {nativeVideoReleaseForm} from '../src/portal/creative-media-release-view.js';
import {creativeMediaErasureForm} from '../src/portal/creative-media-erasure-view.js';
const id='11111111-1111-4111-8111-111111111111';
const plan={canvas:'portrait' as const,disclosure:'#ad',clips:[{startMs:0,endMs:1000,speed:1 as const,transition:'cut' as const,caption:'Caption wraps at word boundaries'}]};
test('caption wrapping preserves whole words using bundled glyph widths; unsupported glyphs are refused',()=>{
 const text='A long caption must never hide the advertising disclosure. This caption wraps on spaces.';
 const wrapped=wrappedVideoCaption(text,720);
 assert.equal(wrapped.replaceAll('\n',' '),text);
 for(const line of wrapped.split('\n'))assert.ok(captionWidth(line)<=720*.78);
 for(const caption of ['Hello 😀','مرحبا','字'])assert.throws(()=>checkVideoEditPlan({...plan,clips:[{...plan.clips[0]!,caption}]}),/not supported/);
 assert.doesNotThrow(()=>checkVideoEditPlan({...plan,clips:[{...plan.clips[0]!,caption:'Café — £20'}]}));
 assert.throws(()=>checkVideoEditPlan({...plan,clips:[{...plan.clips[0]!,endMs:500}]}),/1–120/);
});
test('one five-minute limit; bitrate adjusts to fit the download cap',()=>{
 const long={...plan,clips:Array.from({length:3},()=>({...plan.clips[0]!,endMs:100000}))};
 assert.ok(localRenderBitrate(long)<480000);assert.ok(assertLocalRenderCapacity(long)<20000000);
 assert.throws(()=>checkVideoEditPlan({...long,clips:[...long.clips,{...plan.clips[0]!,endMs:1000}]}),/five.minute/);
});
test('owner screens have plain visible words, including populated failure states',()=>{
 const shell={csrf:'x',applicationName:'RL72',brands:[],creativeAvailable:true,tab:'creative',brand:{id,name:'Example'}} as never;
 const job={id,projectId:id,revision:1,sourceId:id,sourceSha256:'a'.repeat(64),planSha256:'b'.repeat(64),state:'failed' as const,outputId:null,failureReason:'renderer_unavailable',createdAt:'2026-11-17T00:00:00Z',updatedAt:'2026-11-17T00:00:00Z'};
 const pages=[creativeMediaLocalRenderPage(shell,{projects:[],sources:[],probes:[],jobs:[job],outputs:[],newCommand:()=>id,newJob:()=>id}),creativeVideoSourcesPage(shell,[],id),creativeMediaLocalOutputReviewPage(shell,[],[],()=>id),nativeVideoReleaseForm(shell,{jobId:id,contentVersionId:id,outputSha256:'a'.repeat(64),caption:'Example',network:'instagram',scheduledFor:'Tomorrow',authorized:false},id),creativeMediaErasureForm(shell,'source',id)];
 for(const html of pages){const visible=html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/giu,'').replace(/<[^>]*>/gu,' ');assert.doesNotMatch(visible,/vizard|shotstack|canonical|provider|workbench|technical receipt|asset database|offline renders|reviewed_private|awaiting_probe|\bclaimed\b|[a-f0-9]{8}-[a-f0-9-]{20}/iu);}
 assert.match(pages[0]!,/temporarily unavailable/);assert.match(pages[1]!,/H.264 MP4 up to 1080p/);assert.match(pages[1]!,/HEVC/);
});

test('a transient fresh probe failure is retryable, not a changed source',async()=>{
 const {createHash}=await import('node:crypto');const bytes=Buffer.alloc(1024);
 await assert.rejects(renderLocalVideo({bytes,sha256:createHash('sha256').update(bytes).digest('hex'),probe:{status:'verified_technical',checkerVersion:'rl72-ffprobe-v1',durationMs:2000,width:320,height:180,frameRate:30,videoCodec:'h264',audioPresent:false}},plan,{measure:async()=>({status:'rejected',checkerVersion:'rl72-ffprobe-v1',rejectionCode:'probe_failed'})}),e=>(e as {status?:number}).status===503);
});
