import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {acceptStaticCatalogue,readStaticCatalogue,staticCataloguePath,STATIC_CATALOGUE_MAX_BYTES} from '../src/seo-blog/publishers/static-catalogue.js';
import type {WebsiteWireTarget} from '../src/seo-blog/website-target.js';
const target:WebsiteWireTarget={siteId:randomUUID(),capabilitiesSha:'a'.repeat(64),rootId:'blog',rootPath:'blog',canonicalUrl:'https://bay.example/blog/article',indexUrl:'https://bay.example/blog',structureId:randomUUID(),structureRevision:1,structureSha:'b'.repeat(64),categories:[{id:randomUUID(),slug:'guides',label:'Old guides'}],categoryIds:[]};
test('static known old revisions preserve newer shared labels; unknown old and conflicting current revisions fail closed',()=>{
  const empty=readStaticCatalogue(null,target.siteId);const first=acceptStaticCatalogue(empty,target);const newer={...target,structureRevision:2,structureSha:'c'.repeat(64),categories:target.categories.map((c)=>({...c,label:'Current guides'}))};const current=acceptStaticCatalogue(first,newer);const older=acceptStaticCatalogue(current,target);
  assert.equal(older.categories[target.categories[0]!.id]!.label,'Current guides');assert.equal(older.lineages[target.structureId]!.latestRevision,2);
  assert.throws(()=>acceptStaticCatalogue(current,{...newer,categories:newer.categories.map((c)=>({...c,label:'Conflicting same revision'}))}),/different immutable/);
  const initiallyNew=acceptStaticCatalogue(empty,newer);assert.throws(()=>acceptStaticCatalogue(initiallyNew,target),/older catalogue revision is unknown/);
});
test('static category identity, lineage and archive address are permanent',()=>{
  const first=acceptStaticCatalogue(readStaticCatalogue(null,target.siteId),target);
  for(const changed of [{...target,structureRevision:2,rootId:'investment-info',rootPath:'investment-info'},{...target,structureRevision:2,categories:target.categories.map((c)=>({...c,slug:'moved'}))},{...target,structureId:randomUUID()},{...target,structureRevision:2,categories:target.categories.map((c)=>({...c,id:randomUUID()}))}])assert.throws(()=>acceptStaticCatalogue(first,changed),/identity or archive address/);
});
test('static catalogue only accepts its exact public source/site/schema and holds corrupt or oversized history',()=>{
  const first=acceptStaticCatalogue(readStaticCatalogue(null,target.siteId),target);assert.deepEqual(readStaticCatalogue(JSON.stringify(first),target.siteId),first);
  assert.throws(()=>readStaticCatalogue(JSON.stringify({...first,source:'human-owned'}),target.siteId),/another source/);assert.throws(()=>readStaticCatalogue(JSON.stringify(first),randomUUID()),/another source/);assert.throws(()=>readStaticCatalogue('{broken',target.siteId),/corrupt/);assert.throws(()=>readStaticCatalogue(' '.repeat(STATIC_CATALOGUE_MAX_BYTES+1),target.siteId),/metadata limit/);assert.throws(()=>readStaticCatalogue(JSON.stringify({...first,credentials:'not allowed here'}),target.siteId),/not an engine-owned/);assert.throws(()=>staticCataloguePath('../outside'),/identity is invalid/);
});
