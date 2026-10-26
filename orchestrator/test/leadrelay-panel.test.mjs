import test from 'node:test';
import assert from 'node:assert/strict';
import { mountLeadRelay } from '../src/integrations/leadrelay/hq-panel.js';

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.classList={add(){}};this.files=[];}
  setAttribute(){}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
}
const find=(node,predicate)=>predicate(node)?node:node.children.map(c=>find(c,predicate)).find(Boolean);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function harness(csrfToken,extra={}){
  const old={HTMLElement:globalThis.HTMLElement,document:globalThis.document,fetch:globalThis.fetch,confirm:globalThis.confirm};
  globalThis.HTMLElement=Element;globalThis.document={createElement:tag=>new Element(tag)};
  let confirms=0;globalThis.confirm=()=>{confirms++;return true;};
  const posts=[];
  globalThis.fetch=async (url,opts)=>{
    if(opts.method==='POST') posts.push(url);
    return {ok:true,json:async()=>url.endsWith('/installations')?
      ['a','b'].map(id=>({id,label:id,actions:extra.actions || ['GET:status','POST:pack-import']})):
      {business_name:url.includes('/a/')?'Business A':'Business B',jobs:{},sections:[],setup:[]}};
  };
  const root=new Element('root');const panel=mountLeadRelay(root,{csrfToken,...(extra.loadBuilder ? {loadBuilder:extra.loadBuilder} : {})});await panel.ready;
  return {root,panel,posts,confirms:()=>confirms,restore:()=>Object.assign(globalThis,old)};
}

test('deferred file read cannot import into switched installation',async()=>{
  const h=await harness(async()=> 'csrf');
  try {
    const read=deferred();const file=find(h.root,n=>n.type==='file');
    file.files=[{size:20,text:()=>read.promise}];
    const button=find(h.root,n=>n.textContent==='Import paused setup');
    const pending=button.onclick();
    const select=find(h.root,n=>n.tag==='select');select.value='b';await select.onchange();
    read.resolve('{"name":"Pack for A"}');await pending;
    assert.deepEqual(h.posts,[]);assert.equal(h.confirms(),0);
    assert.match(find(h.root,n=>n.className==='lrhq-message').textContent,/Installation changed/);
  } finally {h.restore();}
});

test('installation switch during async CSRF cancels bound import POST',async()=>{
  const csrf=deferred();const entered=deferred();
  const h=await harness(()=>{entered.resolve();return csrf.promise;});
  try {
    find(h.root,n=>n.type==='file').files=[{size:20,text:async()=>'{"name":"Pack for A"}'}];
    const pending=find(h.root,n=>n.textContent==='Import paused setup').onclick();await entered.promise;
    const select=find(h.root,n=>n.tag==='select');select.value='b';await select.onchange();
    csrf.resolve('csrf');await pending;
    assert.deepEqual(h.posts,[]);assert.equal(h.confirms(),1);
  } finally {h.restore();}
});


test('agent setup is hidden without an explicit read grant',async()=>{
  const h=await harness(async()=> 'csrf');
  try { assert.equal(find(h.root,n=>n.textContent==='Create an agent'),undefined); }
  finally {h.restore();}
});

test('selection switch during builder import cannot render or write another installation',async()=>{
  const load=deferred();let mounts=0;
  const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-status','POST:agent-scan'],loadBuilder:()=>load.promise});
  try {
    const pending=find(h.root,n=>n.textContent==='Create an agent').onclick();
    const select=find(h.root,n=>n.tag==='select');select.value='b';await select.onchange();
    load.resolve({mountAgentBuilder:async()=>{mounts++;}});await pending;
    assert.equal(mounts,0);assert.deepEqual(h.posts,[]);
  } finally {h.restore();}
});

test('embedded builder maps only fixed operations with its own action grants',async()=>{
  let api;
  const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-status','POST:agent-scan'],loadBuilder:async()=>({mountAgentBuilder:async(_root,call)=>{api=call;}})});
  try {
    await find(h.root,n=>n.textContent==='Create an agent').onclick();
    await api('/api/agent-builder/scan',{method:'POST',body:{url:'https://business.example/'}});
    assert.deepEqual(h.posts,['/api/leadrelay/installations/a/agent-scan']);
    await assert.rejects(api('/api/agent-builder/test-call',{method:'POST',body:{}}),/role/);
    await assert.rejects(api('https://evil.invalid',{method:'POST',body:{}}),/not supported/);
    await assert.rejects(api('/api/agent-builder/scan',{method:'POST',headers:{authorization:'override'},body:{}}),/override/);
    assert.equal(h.posts.length,1);
  } finally {h.restore();}
});

test('selection switch during builder CSRF prevents its previously bound POST',async()=>{
  const csrf=deferred(),entered=deferred();let api;
  const h=await harness(()=>{entered.resolve();return csrf.promise;},{actions:['GET:status','GET:agent-status','POST:agent-scan'],loadBuilder:async()=>({mountAgentBuilder:async(_root,call)=>{api=call;}})});
  try {
    await find(h.root,n=>n.textContent==='Create an agent').onclick();
    const pending=api('/api/agent-builder/scan',{method:'POST',body:{url:'https://business.example/'}});
    await entered.promise;
    const select=find(h.root,n=>n.tag==='select');select.value='b';await select.onchange();
    csrf.resolve('csrf');await assert.rejects(pending,/Installation changed/);
    assert.deepEqual(h.posts,[]);
  } finally {h.restore();}
});


test('destroying the panel during builder CSRF cancels its pending write',async()=>{
  const csrf=deferred(),entered=deferred();let api;
  const h=await harness(()=>{entered.resolve();return csrf.promise;},{actions:['GET:status','GET:agent-status','POST:agent-scan'],loadBuilder:async()=>({mountAgentBuilder:async(_root,call)=>{api=call;}})});
  try {
    await find(h.root,n=>n.textContent==='Create an agent').onclick();
    const pending=api('/api/agent-builder/scan',{method:'POST',body:{url:'https://business.example/'}});
    await entered.promise;h.panel.destroy();csrf.resolve('csrf');
    await assert.rejects(pending,/Installation changed/);assert.deepEqual(h.posts,[]);
  } finally {h.restore();}
});
