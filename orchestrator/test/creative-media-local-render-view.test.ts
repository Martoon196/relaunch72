import test from 'node:test';
import assert from 'node:assert/strict';
import {creativeMediaLocalRenderPage} from '../src/portal/creative-media-local-render-view.js';
const shell={csrf:'csrf-token',brand:{id:'11111111-1111-4111-8111-111111111111',
 slug:'owner-brand',name:'Owner brand'},brands:[],tab:'creative'} as never;
const file={id:'22222222-2222-4222-8222-222222222222',sha256:'a'.repeat(64),
 fileName:'<script>alert(1)</script>',mime:'video/mp4',byteLength:1024,
 rights:'owned',evidenceSha256:null,state:'awaiting_probe',createdAt:'2026-11-15T19:00:00Z'} as const;
const edit={id:'33333333-3333-4333-8333-333333333333',revision:1,
 sourceId:file.id,sourceSha256:file.sha256,planSha256:'b'.repeat(64),
 plan:{canvas:'portrait',disclosure:'',clips:[
 {startMs:0,endMs:2000,caption:'hello',transition:'cut',speed:1}]},
 createdAt:'2026-11-15T19:00:00Z'} as const;
const model={projects:[edit],sources:[file],probes:[
 {sourceId:file.id,status:'verified_technical' as const}],
 jobs:[],outputs:[],
 newCommand:()=> '44444444-4444-4444-8444-444444444444',
 newJob:()=> '55555555-5555-4555-8555-555555555555'};
test('owner view only offers exact-digest private render when technical source probe passed',()=>{
 const html=creativeMediaLocalRenderPage(shell,model as never);
 assert.match(html,/Ready to render \(1\)/);
 assert.match(html,/name="rightsConfirmed"/);
 assert.match(html,/name="_csrf"/);
 assert.match(html,/name="planSha256"/);
 assert.match(html,/Queue private local render/);
 assert.doesNotMatch(html,/<script>alert\(1\)<\/script>/);
 assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
 assert.doesNotMatch(html,/Publish now|Send to social account/i);
});
test('unchecked source technical state blocks render controls, never overrides SQL gate',()=>{
 const html=creativeMediaLocalRenderPage(shell,{
  ...model,probes:[{sourceId:file.id,status:'rejected'}]} as never);
 assert.match(html,/Ready to render \(0\)/);
 assert.doesNotMatch(html,/Queue private local render/);
});
