import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {MEDIA_CUT_EDITOR_SCRIPT} from '../src/portal/media-cut-editor.js';
import {creativeMediaEditorPage} from '../src/portal/creative-media-editor-view.js';
test('native editor enhances owner form without an external network call',()=>{
 const script=new vm.Script(MEDIA_CUT_EDITOR_SCRIPT);
 assert.doesNotThrow(()=>script.runInNewContext({document:{querySelectorAll:()=>[]}}));
 assert.match(MEDIA_CUT_EDITOR_SCRIPT,/Move earlier/);
 assert.match(MEDIA_CUT_EDITOR_SCRIPT,/Add clip/);
 assert.doesNotMatch(MEDIA_CUT_EDITOR_SCRIPT,/fetch\s*\(|XMLHttpRequest|sendBeacon/);
});
test('owner CSRF form escapes hostile source filenames and saves only via POST',()=>{
 const shell={csrf:'csrf-123',applicationName:'RL72',brands:[],creativeAvailable:true,
  tab:'creative',brand:{id:'11111111-1111-4111-8111-111111111111',name:'Test'}} as never;
 const sources=[{id:'22222222-2222-4222-8222-222222222222',sha256:'a'.repeat(64),
  fileName:'<img src=x onerror=alert(1)>',mime:'video/mp4',
  rights:'owned',state:'awaiting_probe',byteLength:1024,createdAt:'2026-11-15'}] as never;
 const html=creativeMediaEditorPage(shell,sources,[],()=>'33333333-3333-4333-8333-333333333333');
 assert.match(html,/name="_csrf"/);
 assert.match(html,/name="planJson"/);
 assert.doesNotMatch(html,/<img src=x onerror/);
 assert.match(html,/media-cut-editor\.js/);
});
