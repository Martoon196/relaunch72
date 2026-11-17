import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { MEDIA_SCENE_TIMELINE_SCRIPT } from '../src/portal/media-scene-timeline.js';

test('storyboard timeline JavaScript parses without a bundler and is a no-op without forms',()=>{
  const script=new vm.Script(MEDIA_SCENE_TIMELINE_SCRIPT,{filename:'rl72-scene-timeline.js'});
  assert.ok(script);
  const document={querySelectorAll:()=>[]};
  assert.doesNotThrow(()=>script.runInNewContext({document}));
});
test('timeline is local-only, owner form remains the only saved source',()=>{
  assert.match(MEDIA_SCENE_TIMELINE_SCRIPT,/data-rl72-scene-editor/);
  assert.match(MEDIA_SCENE_TIMELINE_SCRIPT,/requestAnimationFrame/);
  assert.match(MEDIA_SCENE_TIMELINE_SCRIPT,/Move scene/);
  assert.match(MEDIA_SCENE_TIMELINE_SCRIPT,/Undo/);
  assert.match(MEDIA_SCENE_TIMELINE_SCRIPT,/Redo/);
  assert.doesNotMatch(MEDIA_SCENE_TIMELINE_SCRIPT,/fetch\s*\(/);
  assert.doesNotMatch(MEDIA_SCENE_TIMELINE_SCRIPT,/XMLHttpRequest|navigator\.sendBeacon/);
  assert.doesNotMatch(MEDIA_SCENE_TIMELINE_SCRIPT,/form\.submit\s*\(/);
});
