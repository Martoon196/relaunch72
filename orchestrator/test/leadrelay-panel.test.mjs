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
  const posts=[],requests=[];
  globalThis.fetch=async (url,opts)=>{
    requests.push({url,opts});
    if(opts.method==='POST') posts.push(url);
    return {ok:true,json:async()=>url.endsWith('/installations')?
      ['a','b'].map(id=>({id,label:id,actions:extra.actions || ['GET:status','POST:pack-import']})):
      url.endsWith('/providers') ? [{definition:{port:'voice',name:'Voice',providers:[{id:'retell',name:'Retell',setup_url:'https://dashboard.retellai.com/'}]},selected:'retell'}] :
      {business_name:url.includes('/a/')?'Business A':'Business B',jobs:{},sections:[],setup:[]}};
  };
  const root=new Element('root');const panel=mountLeadRelay(root,{csrfToken,...(extra.loadBuilder ? {loadBuilder:extra.loadBuilder} : {}),...(extra.loadProvider ? {loadProvider:extra.loadProvider} : {}),...(extra.loadSettings ? {loadSettings:extra.loadSettings} : {})});await panel.ready;
  return {root,panel,posts,requests,confirms:()=>confirms,restore:()=>Object.assign(globalThis,old)};
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

test('native AI connection is hidden without its explicit read grant',async()=>{
  const h=await harness(async()=> 'csrf');
  try { assert.equal(find(h.root,n=>n.textContent==='AI connection'),undefined); }
  finally {h.restore();}
});

test('selection switch during provider module import cannot mount another installation',async()=>{
  const load=deferred();let mounts=0;
  const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-connection'],loadProvider:()=>load.promise});
  try {
    const pending=find(h.root,n=>n.textContent==='AI connection').onclick();
    const select=find(h.root,n=>n.tag==='select');select.value='b';await select.onchange();
    load.resolve({mountProviderSetup:async()=>{mounts++;}});await pending;
    assert.equal(mounts,0);assert.deepEqual(h.posts,[]);
  } finally {h.restore();}
});

test('native provider shim maps only granted fixed routes and never serializes its view guard',async()=>{
  let api,options;
  const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-connection','POST:agent-voices'],loadProvider:async()=>({mountProviderSetup:async(_root,call,opts)=>{api=call;options=opts;}})});
  try {
    await find(h.root,n=>n.textContent==='AI connection').onclick();
    assert.equal(options.canRead,true);assert.equal(options.canListVoices,true);assert.equal(options.canListNumbers,false);assert.equal(options.canVerify,false);
    await api('/api/agent-builder/connection/voices',{method:'POST',body:{secret:'fictional-api-key'},guard:()=>true});
    const sent=h.requests.at(-1);
    assert.equal(sent.url,'/api/leadrelay/installations/a/agent-voices');
    assert.deepEqual(JSON.parse(sent.opts.body),{secret:'fictional-api-key'});
    assert.equal(Object.hasOwn(sent.opts,'guard'),false);
    assert.equal(sent.opts.headers['X-CSRF-Token'],'csrf');
    assert.equal(sent.opts.credentials,'same-origin');
    await assert.rejects(api('/api/agent-builder/connection/verify',{method:'POST',body:{voice_id:'a'}}),/role/);
    await assert.rejects(api('/api/agent-builder/connection/phone-numbers',{method:'POST',body:{}}),/role/);
    await assert.rejects(api('https://evil.invalid',{method:'POST',body:{}}),/not supported/);
    await assert.rejects(api('/api/agent-builder/connection/voices',{method:'POST',headers:{authorization:'override'},body:{}}),/override/);
    await assert.rejects(api('/api/agent-builder/connection/voices',{method:'POST',guard:true,body:{}}),/guard must be a function/);
    assert.equal(h.posts.length,1);
  } finally {h.restore();}
});

test('provider view guard is checked before and after asynchronous HQ CSRF',async()=>{
  let api,current=true,csrfRequests=0;
  const csrf=deferred(),entered=deferred();
  const h=await harness(()=>{csrfRequests++;entered.resolve();return csrf.promise;},{actions:['GET:status','GET:agent-connection','POST:agent-connect'],loadProvider:async()=>({mountProviderSetup:async(_root,call)=>{api=call;}})});
  try {
    await find(h.root,n=>n.textContent==='AI connection').onclick();
    await assert.rejects(api('/api/agent-builder/connection/verify',{method:'POST',body:{voice_id:'a'},guard:()=>false}),/changed/);
    assert.equal(csrfRequests,0);
    const pending=api('/api/agent-builder/connection/verify',{method:'POST',body:{voice_id:'a',secret:'fictional-api-key'},guard:()=>current});
    await entered.promise;current=false;csrf.resolve('csrf');
    await assert.rejects(pending,/changed/);assert.equal(csrfRequests,1);assert.deepEqual(h.posts,[]);
  } finally {h.restore();}
});

test('owned number loading uses its own explicitly granted native connection operation',async()=>{
  let api,options;
  const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-connection','POST:agent-phone-numbers'],loadProvider:async()=>({mountProviderSetup:async(_root,call,opts)=>{api=call;options=opts;}})});
  try {
    await find(h.root,n=>n.textContent==='AI connection').onclick();
    assert.equal(options.canListNumbers,true);assert.equal(options.canListVoices,false);assert.equal(options.canVerify,false);
    await api('/api/agent-builder/connection/phone-numbers',{method:'POST',body:{},guard:()=>true});
    assert.deepEqual(h.posts,['/api/leadrelay/installations/a/agent-phone-numbers']);
    await assert.rejects(api('/api/agent-builder/connection/purchase-number',{method:'POST',body:{}}),/not supported/);
  } finally {h.restore();}
});

test('switching views inside the same business cancels a pending provider write',async()=>{
  const csrf=deferred(),entered=deferred();let api,disposals=0;
  const h=await harness(()=>{entered.resolve();return csrf.promise;},{actions:['GET:status','GET:agent-status','GET:agent-connection','POST:agent-connect'],loadBuilder:async()=>({mountAgentBuilder:async()=>{}}),loadProvider:async()=>({mountProviderSetup:async(_root,call)=>{api=call;return {dispose(){disposals++;}};}})});
  try {
    await find(h.root,n=>n.textContent==='AI connection').onclick();
    const pending=api('/api/agent-builder/connection/verify',{method:'POST',body:{voice_id:'a',secret:'fictional-api-key'},guard:()=>true});
    await entered.promise;
    await find(h.root,n=>n.textContent==='Create an agent').onclick();
    csrf.resolve('csrf');await assert.rejects(pending,/changed/);
    assert.deepEqual(h.posts,[]);assert.equal(disposals,1);
  } finally {h.restore();}
});

test('opening native connection cancels a pending builder write for the same installation',async()=>{
  const csrf=deferred(),entered=deferred();let api;
  const h=await harness(()=>{entered.resolve();return csrf.promise;},{actions:['GET:status','GET:agent-status','POST:agent-publish','GET:agent-connection'],loadBuilder:async()=>({mountAgentBuilder:async(_root,call)=>{api=call;}}),loadProvider:async()=>({mountProviderSetup:async()=>{}})});
  try {
    await find(h.root,n=>n.textContent==='Create an agent').onclick();
    const pending=api('/api/agent-builder/publish',{method:'POST',body:{version_id:'v'}});
    await entered.promise;
    await find(h.root,n=>n.textContent==='AI connection').onclick();
    csrf.resolve('csrf');await assert.rejects(pending,/changed/);
    assert.deepEqual(h.posts,[]);
  } finally {h.restore();}
});

test('switching installation during provider CSRF cancels the previously bound credential POST',async()=>{
  const csrf=deferred(),entered=deferred();let api;
  const h=await harness(()=>{entered.resolve();return csrf.promise;},{actions:['GET:status','GET:agent-connection','POST:agent-voices'],loadProvider:async()=>({mountProviderSetup:async(_root,call)=>{api=call;}})});
  try {
    await find(h.root,n=>n.textContent==='AI connection').onclick();
    const pending=api('/api/agent-builder/connection/voices',{method:'POST',body:{secret:'fictional-api-key'},guard:()=>true});
    await entered.promise;
    const select=find(h.root,n=>n.tag==='select');select.value='b';await select.onchange();
    csrf.resolve('csrf');await assert.rejects(pending,/changed/);
    assert.deepEqual(h.posts,[]);
  } finally {h.restore();}
});

test('verified connection keeps its feedback until the explicit return to agent creation',async()=>{
  let options,builderMounts=0;
  const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-status','GET:agent-connection'],loadBuilder:async()=>({mountAgentBuilder:async()=>{builderMounts++;}}),loadProvider:async()=>({mountProviderSetup:async(_root,_call,opts)=>{options=opts;return {dispose(){}};}})});
  try {
    await find(h.root,n=>n.textContent==='AI connection').onclick();
    await options.onVerified();
    assert.equal(builderMounts,0);
    assert.match(find(h.root,n=>n.className==='lrhq-message').textContent,/verified and saved/);
    await find(h.root,n=>n.textContent==='Continue to Create an agent').onclick();
    assert.equal(builderMounts,1);
  } finally {h.restore();}
});

test('embedded builder connection control opens native provider setup instead of another login',async()=>{
  let builderOptions,providerMounts=0;
  const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-status','GET:agent-connection'],loadBuilder:async()=>({mountAgentBuilder:async(_root,_call,opts)=>{builderOptions=opts;}}),loadProvider:async()=>({mountProviderSetup:async()=>{providerMounts++;}})});
  try {
    await find(h.root,n=>n.textContent==='Create an agent').onclick();
    assert.equal(typeof builderOptions.onOpenConnections,'function');
    await builderOptions.onOpenConnections();
    assert.equal(providerMounts,1);
  } finally {h.restore();}
});

test('Retell preference setup directs users to real native verification',async()=>{
  let providerMounts=0;
  const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:settings','GET:providers','PUT:provider','GET:agent-connection'],loadProvider:async()=>({mountProviderSetup:async()=>{providerMounts++;}})});
  try {
    await find(h.root,n=>n.textContent==='Business setup').onclick();
    assert.equal(find(h.root,n=>n.textContent==='Save preference').disabled,true);
    await find(h.root,n=>n.textContent==='Verify Retell API connection').onclick();
    assert.equal(providerMounts,1);
  } finally {h.restore();}
});

test('failed provider imports leave the visible builder usable until a replacement validates',async()=>{
  for(const fail of [async()=>{throw Error('Provider module load failed');},async()=>({})]) {
    let api,builderRoot;
    const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-status','POST:agent-scan','GET:agent-connection'],loadBuilder:async()=>({mountAgentBuilder:async(root,call)=>{builderRoot=root;api=call;}}),loadProvider:fail});
    try {
      await find(h.root,n=>n.textContent==='Create an agent').onclick();
      await find(h.root,n=>n.textContent==='AI connection').onclick();
      assert.equal(find(h.root,n=>n===builderRoot),builderRoot);
      await api('/api/agent-builder/scan',{method:'POST',body:{url:'https://business.example/'}});
      assert.deepEqual(h.posts,['/api/leadrelay/installations/a/agent-scan']);
    } finally {h.restore();}
  }
});

test('failed builder imports preserve the visible provider and do not dispose its secret controls',async()=>{
  for(const fail of [async()=>{throw Error('Builder module load failed');},async()=>({})]) {
    let api,providerRoot,isCurrent,disposals=0;
    const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-status','GET:agent-connection','POST:agent-voices'],loadBuilder:fail,loadProvider:async()=>({mountProviderSetup:async(root,call,options)=>{providerRoot=root;api=call;isCurrent=options.isCurrent;return {dispose(){disposals++;}};}})});
    try {
      await find(h.root,n=>n.textContent==='AI connection').onclick();
      await find(h.root,n=>n.textContent==='Create an agent').onclick();
      assert.equal(find(h.root,n=>n===providerRoot),providerRoot);
      assert.equal(isCurrent(),true);assert.equal(disposals,0);
      await api('/api/agent-builder/connection/voices',{method:'POST',body:{secret:'fictional-api-key'},guard:()=>true});
      assert.deepEqual(h.posts,['/api/leadrelay/installations/a/agent-voices']);
    } finally {h.restore();}
  }
});

test('same-installation view changes fence pending builder and provider imports',async()=>{
  for(const kind of ['builder','provider']) {
    const wait=deferred();let mounts=0;
    const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-status','GET:agent-connection'],loadBuilder:kind==='builder'?()=>wait.promise:async()=>({mountAgentBuilder:async()=>{}}),loadProvider:kind==='provider'?()=>wait.promise:async()=>({mountProviderSetup:async()=>({dispose(){}})})});
    try {
      const pending=find(h.root,n=>n.textContent===(kind==='builder'?'Create an agent':'AI connection')).onclick();
      await h.panel.refresh();
      wait.resolve(kind==='builder'?{mountAgentBuilder:async()=>{mounts++;}}:{mountProviderSetup:async()=>{mounts++;}});
      await pending;
      assert.equal(mounts,0);assert.deepEqual(h.posts,[]);
    } finally {h.restore();}
  }
});

test('native Call me forwards a stable owner intent through only the existing test action',async()=>{
  let api;
  const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-status','POST:agent-test-call'],loadBuilder:async()=>({mountAgentBuilder:async(_root,call)=>{api=call;}})});
  try {
    await find(h.root,n=>n.textContent==='Create an agent').onclick();
    const body={version_id:'version-a',own_contact_confirmed:true,ai_call_consent:true,
      confirmation:'PLACE ONE PAID TEST CALL TO MY OWN NUMBER',mode:'call_me',request_id:'9aca7ecd-9a94-43e0-9414-8af424b29c13'};
    await api('/api/agent-builder/test-call',{method:'POST',body,guard:()=>true});
    assert.deepEqual(h.posts,['/api/leadrelay/installations/a/agent-test-call']);
    assert.deepEqual(JSON.parse(h.requests.at(-1).opts.body),body);
    assert.equal(h.requests.at(-1).opts.headers['X-CSRF-Token'],'csrf');
    assert.equal(Object.hasOwn(h.requests.at(-1).opts,'guard'),false);
    await assert.rejects(api('/api/control/settings',{method:'PUT',body:{paused:false}}),/not supported/);
  } finally {h.restore();}
});

test('Agent settings require their own read grants and expose only explicitly granted capabilities',async()=>{
  const denied=await harness(async()=> 'csrf');
  try {assert.equal(find(denied.root,n=>n.textContent==='Agent settings'),undefined);}finally{denied.restore();}
  let api,options;
  const actions=['GET:status','GET:agent-voice-settings','POST:agent-voice-catalog','GET:agent-training-profile','GET:agent-training-sources','POST:agent-training-source'];
  const h=await harness(async()=> 'csrf',{actions,loadSettings:async()=>({mountAgentSettings:async(_root,call,opts)=>{api=call;options=opts;}})});
  try {
    await find(h.root,n=>n.textContent==='Agent settings').onclick();
    assert.deepEqual(options.voice,{canRead:true,canListVoices:false,canCatalog:true,canPreview:false,canSaveChoice:false,canApplyVoice:false});
    assert.deepEqual(options.training,{canRead:true,canTrain:false});
    await api('/api/agent-builder/voice-catalog',{method:'POST',body:{query:'Eve'}});
    await api('/api/agent-builder/training/source',{method:'POST',body:{title:'Draft',content:'Facts'}});
    assert.deepEqual(h.posts,['/api/leadrelay/installations/a/agent-voice-catalog','/api/leadrelay/installations/a/agent-training-source']);
    await assert.rejects(api('/api/agent-builder/voice-preview',{method:'POST',body:{voice_id:'a'}}),/role/);
    await assert.rejects(api('/api/agent-builder/training/profile',{method:'POST',body:{}}),/role/);
    await assert.rejects(api('/api/agent-builder/publish',{method:'POST',body:{}}),/not supported/);
    await assert.rejects(api('https://evil.invalid',{method:'POST',body:{}}),/not supported/);
    await assert.rejects(api('/api/agent-builder/voice-catalog',{method:'POST',headers:{authorization:'other'},body:{}}),/override/);
  }finally{h.restore();}
});

test('Training edit controls require every individually granted training write',async()=>{
  let options;
  const actions=['GET:status','GET:agent-training-profile','GET:agent-training-sources',...['source','upload','review','profile','approve'].map(name=>'POST:agent-training-'+name)];
  const h=await harness(async()=> 'csrf',{actions,loadSettings:async()=>({mountAgentSettings:async(_root,_api,opts)=>{options=opts;}})});
  try{
    await find(h.root,n=>n.textContent==='Agent settings').onclick();
    assert.equal(options.training.canTrain,true);assert.equal(options.voice.canRead,false);
  }finally{h.restore();}
});

test('Training file guards are rechecked after asynchronous CSRF without serializing them',async()=>{
  let api,current=true;const csrf=deferred(),entered=deferred();
  const h=await harness(()=>{entered.resolve();return csrf.promise;},{actions:['GET:status','GET:agent-training-profile','GET:agent-training-sources','POST:agent-training-upload'],loadSettings:async()=>({mountAgentSettings:async(_root,call)=>{api=call;}})});
  try{
    await find(h.root,n=>n.textContent==='Agent settings').onclick();
    const pending=api('/api/agent-builder/training/upload',{method:'POST',body:{filename:'facts.txt',content_base64:'RmFjdHM='},guard:()=>current});
    await entered.promise;current=false;csrf.resolve('csrf');
    await assert.rejects(pending,/changed/);assert.deepEqual(h.posts,[]);
  }finally{h.restore();}
});

test('A failed settings import leaves the existing provider usable',async()=>{
  let api,isCurrent,disposals=0;
  const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-voice-settings','GET:agent-connection','POST:agent-voices'],loadProvider:async()=>({mountProviderSetup:async(_root,call,options)=>{api=call;isCurrent=options.isCurrent;return {dispose(){disposals++;}};}}),loadSettings:async()=>{throw Error('Settings module load failed');}});
  try{
    await find(h.root,n=>n.textContent==='AI connection').onclick();
    await find(h.root,n=>n.textContent==='Agent settings').onclick();
    assert.equal(isCurrent(),true);assert.equal(disposals,0);
    await api('/api/agent-builder/connection/voices',{method:'POST',body:{secret:'fictional-api-key'}});
    assert.equal(h.posts.length,1);
  }finally{h.restore();}
});

test('Installation changes fence a pending settings import',async()=>{
  const load=deferred();let mounts=0;
  const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-voice-settings'],loadSettings:()=>load.promise});
  try{
    const pending=find(h.root,n=>n.textContent==='Agent settings').onclick();
    const select=find(h.root,n=>n.tag==='select');select.value='b';await select.onchange();
    load.resolve({mountAgentSettings:async()=>{mounts++;}});await pending;
    assert.equal(mounts,0);
  }finally{h.restore();}
});

test('Settings child guards cancel callback navigation after a tab change during import',async()=>{
  for(const destination of ['builder','provider']){
    const load=deferred();let options,current=true,mounts=0;
    const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-status','GET:agent-connection','GET:agent-voice-settings'],loadSettings:async()=>({mountAgentSettings:async(_root,_api,opts)=>{options=opts;}}),loadBuilder:()=>load.promise,loadProvider:()=>load.promise});
    try{
      await find(h.root,n=>n.textContent==='Agent settings').onclick();
      const pending=(destination==='builder'?options.onReturnBuilder:options.onOpenConnections)({isCurrent:()=>current});
      current=false;
      load.resolve(destination==='builder'?{mountAgentBuilder:async()=>{mounts++;}}:{mountProviderSetup:async()=>{mounts++;}});
      await assert.rejects(pending,/changed/);assert.equal(mounts,0);
      assert.equal(options.isCurrent(),true);
    }finally{h.restore();}
  }
});

test('Builder Agent settings callbacks open the native wrapper',async()=>{
  let options,mounts=0;
  const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-status','GET:agent-voice-settings'],loadBuilder:async()=>({mountAgentBuilder:async(_root,_api,opts)=>{options=opts;}}),loadSettings:async()=>({mountAgentSettings:async()=>{mounts++;}})});
  try{
    await find(h.root,n=>n.textContent==='Create an agent').onclick();
    assert.equal(typeof options.onOpenSettings,'function');
    assert.equal(options.onOpenAgentSettings,options.onOpenSettings);
    await options.onOpenSettings({isCurrent:()=>true});assert.equal(mounts,1);
  }finally{h.restore();}
});


test('Existing builder read permits only the read-only Website chatbot tab without new voice or training actions',async()=>{
  let builderOptions,settingsOptions,settingsApi,loads=0;
  const h=await harness(async()=> 'csrf',{actions:['GET:status','GET:agent-status'],loadBuilder:async()=>({mountAgentBuilder:async(_root,_api,value)=>{builderOptions=value;}}),loadSettings:async()=>{loads++;return {mountAgentSettings:async(_root,api,value)=>{settingsApi=api;settingsOptions=value;}};}});
  try {
    await find(h.root,n=>n.textContent==='Create an agent').onclick();
    await builderOptions.onOpenSettings({isCurrent:()=>true}); assert.equal(loads,1);
    assert.equal(settingsOptions.websiteChat.canRead,true);assert.equal(settingsOptions.voice.canRead,false);assert.equal(settingsOptions.training.canRead,false);
    await settingsApi('/api/agent-builder');
    await assert.rejects(settingsApi('/api/agent-builder/deploy',{method:'POST',body:{}}),/not supported/);
    assert.deepEqual(h.posts,[]);
  } finally {h.restore();}
});
