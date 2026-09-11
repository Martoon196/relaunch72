import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { SOCIAL_IMAGE_CLIENT_SOURCE } from '../src/portal/social-image-client.js';
import { JPEG_FIXTURE } from './social-image-fixture.js';

function browserFixture() {
  const listeners = new Map<string, (event?: any) => any>();
  const sent: any[] = [];
  const nodes = new Map<string, any>();
  for (const id of ['post-image-form','post-image-status','post-image-selection','post-image-preview',
    'post-image-data','post-image-alt','post-image-file','post-image-create','post-image-choose',
    'post-image-drop','post-image-maker','post-image-frame']) {
    nodes.set(id, { value:'', textContent:'', hidden:true, style:{}, focus() {},
      addEventListener(kind:string, fn:any) { listeners.set(`${id}:${kind}`, fn); } });
  }
  nodes.get('post-image-form').elements = { artwork_instructions:{value:'A real screenshot'}, publication_copy:{value:'Saved words'} };
  const popup = { closed:false, postMessage(message:any, origin:string) { sent.push({message,origin}); }, close(){this.closed=true;} };
  nodes.get('post-image-frame').contentWindow=popup;
  const window = { open:()=>{throw new Error('No image popup allowed');}, addEventListener:(kind:string, fn:any)=>listeners.set(`window:${kind}`,fn) };
  let decodes=0;
  const context = vm.createContext({ window, document: {
    getElementById:(id:string)=>nodes.get(id), querySelector:()=>null,
    createElement:()=>({ getContext:()=>({fillStyle:'',fillRect(){},drawImage(){}}),toDataURL:()=>JPEG_FIXTURE }),
  }, crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'}, Blob, Uint8Array, atob,
    URL:{createObjectURL:()=> 'blob:preview',revokeObjectURL(){}},
    createImageBitmap:async()=>{decodes++;return {width:200,height:200,close(){}};},
  });
  vm.runInContext(SOCIAL_IMAGE_CLIENT_SOURCE,context);
  return {nodes,listeners,popup,sent,decodes:()=>decodes};
}

test('image handoff accepts only the embedded PP frame, exact origin and current nonce', () => {
  const b=browserFixture(); b.listeners.get('post-image-create:click')!();
  const data={type:'pp-image-ready',nonce:'11111111-1111-4111-8111-111111111111'};
  const message=b.listeners.get('window:message')!;
  message({origin:'https://attacker.invalid',source:b.popup,data});
  message({origin:'https://propertypredator.com',source:{},data});
  message({origin:'https://propertypredator.com',source:b.popup,data:{...data,nonce:'stale'}});
  assert.equal(b.sent.length,0);
  message({origin:'https://propertypredator.com',source:b.popup,data});
  assert.equal(b.sent.length,1);
  assert.equal(b.sent[0].origin,'https://propertypredator.com');
  assert.equal(b.sent[0].message.prompt,'A real screenshot');
  assert.deepEqual(Object.keys(b.sent[0].message).sort(),['nonce','prompt','type']);
});

test('returned image is decoded and finished locally; selecting does not submit or approve', async () => {
  const b=browserFixture(); b.listeners.get('post-image-create:click')!();
  b.listeners.get('window:message')!({origin:'https://propertypredator.com',source:b.popup,
    data:{type:'pp-image-selected',nonce:'11111111-1111-4111-8111-111111111111',image:JPEG_FIXTURE}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.decodes(),1); assert.equal(b.nodes.get('post-image-data').value,JPEG_FIXTURE);
  assert.equal(b.nodes.get('post-image-selection').hidden,false);
  assert.equal(b.nodes.get('post-image-maker').hidden,true);
  assert.match(b.nodes.get('post-image-status').textContent,/then save/);
});

test('drag and drop uses the same local image preparation without a popup', async () => {
  const b=browserFixture(); let prevented=false;
  b.listeners.get('post-image-drop:drop')!({preventDefault(){prevented=true;},
    dataTransfer:{files:[new Blob(['fixture'],{type:'image/png'})]}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(prevented,true);assert.equal(b.decodes(),1);
  assert.equal(b.nodes.get('post-image-data').value,JPEG_FIXTURE);
});

test('multiple files and unsupported file types give helpful errors', async () => {
  const b=browserFixture();
  b.listeners.get('post-image-drop:drop')!({preventDefault(){},dataTransfer:{files:[{},{}]}});
  assert.match(b.nodes.get('post-image-status').textContent,/one picture/);
  b.listeners.get('post-image-drop:drop')!({preventDefault(){},dataTransfer:{files:[new Blob(['svg'],{type:'image/svg+xml'})]}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.decodes(),0);assert.match(b.nodes.get('post-image-status').textContent,/JPG, PNG or WebP/);
});

test('reopening the in-page maker preserves the existing generation frame', () => {
  const b=browserFixture();b.listeners.get('post-image-create:click')!();
  const url=b.nodes.get('post-image-frame').src;
  assert.match(url,/\/image-maker.html\?hqImage=/);
  b.listeners.get('post-image-create:click')!();
  assert.equal(b.nodes.get('post-image-frame').src,url);
  assert.equal(b.nodes.get('post-image-maker').hidden,false);
});

test('unsupported returned content is ignored and no-picture submit is blocked', () => {
  const b=browserFixture(); b.listeners.get('post-image-create:click')!();
  b.listeners.get('window:message')!({origin:'https://propertypredator.com',source:b.popup,
    data:{type:'pp-image-selected',nonce:'11111111-1111-4111-8111-111111111111',image:'data:image/svg+xml;base64,PHN2Zz4='}});
  let prevented=false;
  b.listeners.get('post-image-form:submit')!({preventDefault(){prevented=true;}});
  assert.equal(prevented,true); assert.equal(b.decodes(),0);
});
