import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderLocalVideo,localRenderFilterGraph,localRenderDimensions} from '../src/creative-studio/media-local-render.js';
import {ffprobeFromBytes} from '../src/creative-studio/media-source-probe.js';
import type {VideoEditPlan} from '../src/creative-studio/media-edit-plan.js';

const plan:VideoEditPlan={canvas:'portrait',disclosure:'#ad',
 clips:[
  {startMs:500,endMs:1500,caption:'First scene',transition:'cut',speed:1},
  {startMs:1500,endMs:2500,caption:'Second scene',transition:'fade',speed:2},
 ]};
test('bounded filter graph maps two clips, checked captions, audio, fade and measured duration',()=>{
 const graph=localRenderFilterGraph(plan,3000,true,['/tmp/cap0.txt','/tmp/cap1.txt']);
 assert.deepEqual(graph.dimensions,localRenderDimensions('portrait'));
 assert.equal(graph.expectedDurationMs,1500);
 assert.match(graph.graph,/trim=start=0.5:end=1.5/);
 assert.match(graph.graph,/atempo=2/);
 assert.match(graph.graph,/concat=n=2:v=1:a=1/);
 assert.match(graph.graph,/fade=t=in/);
 assert.match(graph.graph,/drawtext=textfile=\/tmp\/cap0.txt/);
 assert.throws(()=>localRenderFilterGraph(plan,2000,true,['/tmp/a','/tmp/b']),/extends beyond/);
 assert.throws(()=>localRenderFilterGraph(plan,3000,true,['/tmp/a']),/caption files/);
 assert.throws(()=>localRenderFilterGraph(plan,3000,true,['/tmp/a','https://bad.test/asset']),/not trusted/);
});
test('audio-less source receives bounded silent track without external media URLs',()=>{
 const graph=localRenderFilterGraph({...plan,canvas:'square',disclosure:'#ad'},3000,false,
  ['/tmp/c0','/tmp/c1']);
 assert.match(graph.graph,/anullsrc=r=44100:cl=stereo/);
 assert.match(graph.graph,/scale=720:720/);
 assert.doesNotMatch(graph.graph,/https?:/);
});
test('rejects tampered source or missing independent technical probe before launching FFmpeg',async()=>{
 const bytes=Buffer.alloc(1024);
 const src={bytes,sha256:'0'.repeat(64),probe:{status:'rejected' as const,
  checkerVersion:'rl72-ffprobe-v1',rejectionCode:'malformed' as const}};
 await assert.rejects(renderLocalVideo(src,plan),/no longer match/);
 const validHash=createHash('sha256').update(bytes).digest('hex');
 await assert.rejects(renderLocalVideo({...src,sha256:validHash},plan),/technical probe required/);
});
const ffmpegAvailable=spawnSync('ffmpeg',['-version'],{encoding:'utf8',timeout:5000}).status===0;
const ffprobeAvailable=spawnSync('ffprobe',['-version'],{encoding:'utf8',timeout:5000}).status===0;
test('real offline FFmpeg: measured MP4 source to private portrait multicut render', {
 skip:!ffmpegAvailable||!ffprobeAvailable?'FFmpeg and FFprobe binaries not installed on this isolated worker':false,
 timeout:120_000,
},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rl72-local-render-smoke-'));
 try {
  const fs=await import('node:fs/promises');
  const input=join(dir,'fixture.mp4');
  const ff=spawnSync('ffmpeg',[
    '-hide_banner','-loglevel','error','-nostdin','-y',
    '-f','lavfi','-i','testsrc2=size=320x180:rate=30',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=44100',
    '-t','3.0','-c:v','libx264','-preset','ultrafast','-crf','33',
    '-c:a','aac','-b:a','64k',input],
    {encoding:'utf8',timeout:20_000});
  assert.equal(ff.status,0,ff.stderr.slice(0,500));
  const bytes=await readFile(input);
  const sourceProbe=await ffprobeFromBytes(bytes);
  assert.equal(sourceProbe.status,'verified_technical');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const rendered=await renderLocalVideo({bytes,sha256,probe:sourceProbe},plan);
  assert.equal(rendered.sourceSha256,sha256);
  assert.equal(rendered.planSha256.length,64);
  assert.equal(rendered.mime,'video/mp4');
  assert.equal(rendered.width,720);assert.equal(rendered.height,1280);
  assert.ok(rendered.durationMs>=1400&&rendered.durationMs<=2800);
  assert.equal(rendered.audioPresent,true);
  assert.ok(rendered.bytes.length>=1024&&rendered.bytes.length<20_000_000);
  assert.equal(rendered.sha256,createHash('sha256').update(rendered.bytes).digest('hex'));
  await fs.writeFile(join(dir,'result.mp4'),rendered.bytes);
  const fresh=await ffprobeFromBytes(rendered.bytes);
  assert.equal(fresh.status,'verified_technical');
  assert.equal(fresh.videoCodec,'h264');
 }finally{await rm(dir,{recursive:true,force:true});}
});
