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
 assert.match(html,/type="hidden" name="planJson"/);
 assert.doesNotMatch(html,/<textarea[^>]*name="planJson"/);
 assert.doesNotMatch(html,/<img src=x onerror/);
 assert.match(html,/media-cut-editor\.js/);
});

test('interactive editor builds real input/select/textarea controls and safely initializes preview',()=>{
 const created:Array<{tag:string;type?:string;value?:string;attributes:Record<string,string>;children:unknown[];
   append:(...values:unknown[])=>void;replaceChildren:(...values:unknown[])=>void;
   setAttribute:(name:string,value:string)=>void;addEventListener:(name:string,fn:()=>void)=>void;
   closest:(name:string)=>unknown;getAttribute:(name:string)=>string|null;
   textContent?:string;maxLength?:number;src?:string;}>=[];
 function element(tag:string){
  const x={
   tag,attributes:{} as Record<string,string>,children:[] as unknown[],value:'',
   append(...values:unknown[]){this.children.push(...values);},
   replaceChildren(...values:unknown[]){this.children=[...values];},
   setAttribute(name:string,value:string){this.attributes[name]=value;},
   addEventListener(_name:string,_handler:()=>void){},
   closest(_name:string){return {tag:'label'};},
   getAttribute(name:string){return this.attributes[name]??null;},
   textContent:'',type:undefined as string|undefined,maxLength:undefined as number|undefined,
   src:undefined as string|undefined,
  };
  created.push(x);return x;
 }
 const textarea=element('textarea');textarea.value=JSON.stringify({
  canvas:'portrait',disclosure:'#ad',
  clips:[{startMs:0,endMs:2000,caption:'Hello',transition:'cut',speed:1}],
 });
 const source=element('input');
 source.value='22222222-2222-4222-8222-222222222222:'+ 'a'.repeat(64);
 const form={querySelector:()=>textarea,elements:{namedItem:()=>source},
  getAttribute:()=>'/portal/seo-blog/b/11111111-1111-4111-8111-111111111111/creative',
  insertBefore:(_node:unknown,_before:unknown)=>{},
  addEventListener:(_name:string,_handler:()=>void)=>{},
 };
 const document={querySelectorAll:()=>[form],createElement:element};
 assert.doesNotThrow(()=>new vm.Script(MEDIA_CUT_EDITOR_SCRIPT).runInNewContext({document}));
 const tags=created.map(v=>v.tag);
 assert.ok(tags.filter(t=>t==='input').length>=3);
 assert.ok(tags.filter(t=>t==='select').length>=3);
 assert.ok(tags.filter(t=>t==='textarea').length>=1);
 assert.ok(!tags.includes('number')&&!tags.includes('text'));
 assert.ok(created.some(v=>v.tag==='input'&&v.type==='number'));
 assert.ok(created.some(v=>v.tag==='input'&&v.type==='text'));
 assert.ok(created.some(v=>v.tag==='video'&&v.src?.endsWith('/sources/22222222-2222-4222-8222-222222222222/stream')));
 assert.equal(JSON.parse(textarea.value).clips[0].endMs,2000);
});
