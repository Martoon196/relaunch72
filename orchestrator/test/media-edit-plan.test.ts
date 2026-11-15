import test from 'node:test';
import assert from 'node:assert/strict';
import {checkVideoEditPlan,videoEditDigest,videoPlanToShotstack} from '../src/creative-studio/media-edit-plan.js';
const example={canvas:'portrait' as const,disclosure:'#ad',clips:[
 {startMs:1000,endMs:4000,caption:'Our product',transition:'cut' as const,speed:1 as const},
 {startMs:6000,endMs:12000,caption:'Learn more',transition:'fade' as const,speed:1 as const},
]};
test('video edit is a bounded owner-only draft with deterministic digest',()=>{
 const p=checkVideoEditPlan(example);
 assert.equal(p.clips.length,2);
 assert.equal(videoEditDigest(p),videoEditDigest(checkVideoEditPlan(example)));
 assert.equal(videoEditDigest(p).length,64);
});
test('Shotstack compilation never works without verified rights and measured duration',()=>{
 const plan=checkVideoEditPlan(example);
 for(const bad of [{verified:false,rightsApproved:true},{verified:true,rightsApproved:false}]){
  assert.throws(()=>videoPlanToShotstack(plan,{...bad,url:'https://private-proxy.test/a.mp4',durationMs:20000}),/authorised/);
 }
 assert.throws(()=>videoPlanToShotstack(plan,{verified:true,rightsApproved:true,
  url:'https://private-proxy.test/a.mp4',durationMs:10000}),/exceeds measured/);
 const edit=videoPlanToShotstack(plan,{verified:true,rightsApproved:true,
  url:'https://private-proxy.test/a.mp4',durationMs:20000});
 assert.equal((edit.output as {aspectRatio:string}).aspectRatio,'9:16');
 assert.equal(((edit.timeline as {tracks:unknown[]}).tracks).length,2);
});
test('reject invalid user editing content before server stores it',()=>{
 for(const bad of [
  {...example,canvas:'hexagon'}, {...example,clips:[]},
  {...example,clips:[{...example.clips[0],endMs:-1}]},
  {...example,clips:[{...example.clips[0],caption:'<script>evil</script>'}]},
  {...example,clips:[{...example.clips[0],speed:4}]},
 ])assert.throws(()=>checkVideoEditPlan(bad));
});
