import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaStore, MediaError } from '../src/media/store.js';
import { MediaEngine } from '../src/media/engine.js';
import { VizardClips, ShotstackRender } from '../src/media/providers.js';

async function context(fn: (engine:MediaEngine) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rl72-media-'));
  try {
    const fakeClips = {
      configured: true,
      start: async () => '12345',
      check: async () => ({ status: 'done' as const, clips: [
        { title:'Clip 1', url:'https://cdn.example.com/clip1.mp4', transcript:'Original transcript' },
        { title:'Clip 2', url:'https://cdn.example.com/clip2.mp4', transcript:'Another original transcript' },
      ] }),
    } as unknown as VizardClips;
    const fakeRender = {
      configured: true,
      start: async () => 'render-12345',
      check: async () => ({ status: 'done' as const, url:'https://cdn.example.com/render.mp4',credits:1.2 }),
    } as unknown as ShotstackRender;
    await fn(new MediaEngine(new MediaStore(dir),fakeClips,fakeRender,''));
  } finally { await rm(dir,{force:true,recursive:true}); }
}

test('standalone affiliate campaigns and marketing campaigns share an isolated engine', async () => context(async (e) => {
  const a=await e.create('tenant-a',{name:'Prepper shop',brief:'Emergency gear for UK households',mode:'affiliate'});
  const b=await e.create('tenant-b',{name:'Local electrician',brief:'Educational clips',mode:'general'});
  assert.notEqual(a.id,b.id);
  assert.equal((await e.list('tenant-a')).campaigns.length,1);
  assert.equal((await e.list('tenant-b')).campaigns[0]?.name,'Local electrician');
  assert.equal((await e.list('tenant-b')).campaigns[0]?.products.length,0);
  await assert.rejects(e.product('tenant-b',a.id,{name:'Radio',merchant:'Amazon',productUrl:'https://www.amazon.co.uk/'}),
    (err:unknown)=>err instanceof MediaError && err.status===404);
}));

test('source URLs require rights, and licensed use requires evidence before API spend', async () => context(async (e) => {
  await assert.rejects(e.create('t1',{name:'Bad source',brief:'Repurpose video',sourceUrl:'https://youtube.com/watch?v=1234',rights:'none'}), /owned or licensed/);
  await assert.rejects(e.create('t1',{name:'No licence',brief:'Repurpose video',sourceUrl:'https://youtube.com/watch?v=1234',rights:'licensed'}), /licence reference/);
  await assert.rejects(e.create('t1',{name:'Unsafe',brief:'Test',sourceUrl:'http://localhost/private',rights:'owned'}), /HTTPS/);
  const c=await e.create('t1',{name:'Owned footage',brief:'Clip an original interview',sourceUrl:'https://www.youtube.com/watch?v=1234',rights:'owned'});
  assert.equal(c.rights,'owned');
}));

test('product management accepts affiliate destinations without fabricating sales', async () => context(async (e) => {
  const c=await e.create('shop',{name:'Gear',brief:'Useful camping supplies'});
  const p=await e.product('shop',c.id,{name:'Solar lantern',merchant:'Amazon',productUrl:'https://www.amazon.co.uk/dp/EXAMPLE',affiliateUrl:'https://amzn.to/example'});
  assert.equal(p.affiliateUrl,'https://amzn.to/example');
  const snapshot=await e.list('shop');
  assert.equal(snapshot.campaigns[0]?.products.length,1);
  assert.ok(!('sales' in snapshot.campaigns[0]!.products[0]!));
}));

test('human approval and editing invalidate prior approvals', async () => context(async (e) => {
  const c=await e.create('t1',{name:'Radio',brief:'Emergency radio demo'});
  const v=await e.saveScript('t1',c.id,'#ad This is a product overview.','Draft 1');
  await assert.rejects(e.approve('t1',c.id,v.id,{claimsVerified:true,rightsVerified:true}),/confirm/);
  const a=await e.approve('t1',c.id,v.id,{claimsVerified:true,rightsVerified:true,adDisclosure:true});
  assert.equal(a.status,'approved');
  const edited=await e.edit('t1',c.id,v.id,{script:'#ad Updated copy'});
  assert.equal(edited.status,'editing');
  assert.equal(edited.approvedAt,null);
}));

test('Vizard repurposing creates editable variants once; retries do not duplicate', async () => context(async (e) => {
  const c=await e.create('t1',{name:'Interview',brief:'Clip our original interview',
    sourceUrl:'https://www.youtube.com/watch?v=1234',rights:'owned'});
  const j=await e.repurpose('t1',c.id);
  assert.equal(j.status,'processing');
  await assert.rejects(e.repurpose('t1',c.id),/already running/);
  const done=await e.poll('t1',c.id,j.id);
  assert.equal(done.status,'done');
  await e.poll('t1',c.id,j.id);
  const data=await e.list('t1');
  assert.equal(data.campaigns[0]?.variants.length,2);
  assert.equal(data.campaigns[0]?.variants[0]?.script,'Original transcript');
}));

test('Shotstack render returns an output but demands fresh approval', async () => context(async (e) => {
  const c=await e.create('t1',{name:'Product intro',brief:'Short-form ad'});
  const v=await e.saveScript('t1',c.id,'#ad An original product introduction.');
  await e.edit('t1',c.id,v.id,{timeline:{timeline:{tracks:[]},output:{format:'mp4',resolution:'sd'}}});
  await e.approve('t1',c.id,v.id,{claimsVerified:true,rightsVerified:true,adDisclosure:true});
  const j=await e.render('t1',c.id,v.id);
  assert.equal(j.status,'processing');
  assert.equal((await e.poll('t1',c.id,j.id)).status,'done');
  const saved=(await e.list('t1')).campaigns[0]?.variants[0];
  assert.equal(saved?.mediaUrl,'https://cdn.example.com/render.mp4');
  assert.equal(saved?.status,'editing'); // video output changed => previous approval invalid
}));

test('simultaneous updates to the same tenant do not lose products', async () => context(async (e) => {
  const c=await e.create('t1',{name:'Products',brief:'Catalogue'});
  await Promise.all(Array.from({length:20},(_,i)=>
    e.product('t1',c.id,{name:'Product '+i,merchant:'Amazon',productUrl:'https://www.amazon.co.uk/dp/P'+i})
  ));
  assert.equal((await e.list('t1')).campaigns[0]?.products.length,20);
}));

test('media store returns safe errors when attempting tenant path escape', async () => context(async (e) => {
  await assert.rejects(e.create('../../someone',{name:'bad',brief:'bad'}),/Invalid tenant ID/);
}));
