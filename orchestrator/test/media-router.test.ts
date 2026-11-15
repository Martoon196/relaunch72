import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MediaEngine } from '../src/media/engine.js';
import { MediaStore } from '../src/media/store.js';
import { handleMediaApi, handleAffiliateRedirect, mediaCsrf } from '../src/media/router.js';

const SECRET='a-secure-test-secret-long-enough-for-hmac';
function request(method:string,url:string,body?:unknown,csrf?:string) {
  const data=body===undefined?[]:[Buffer.from(JSON.stringify(body))];
  const req=Readable.from(data) as Readable & {
    method:string;url:string;headers:Record<string,string>;
  };
  req.method=method;req.url=url;
  req.headers={'content-type':'application/json',...(csrf?{'x-rl72-csrf':csrf}:{})};
  return req as unknown as IncomingMessage;
}
function response() {
  return {
    status:0,headers:{} as Record<string,string>,body:'',
    writeHead(code:number,headers?:Record<string,string>){
      this.status=code;
      if(headers)this.headers=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),String(v)]));
      return this;
    },
    end(body?:string){this.body=body||'';},
  };
}
test('API rejects CSRF for write but accepts correct signed session token',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'r72-media-api-'));
  try{
    const engine=new MediaEngine(new MediaStore(dir));
    const csrf=mediaCsrf(SECRET,'signed-cookie-value');
    let res=response();
    await handleMediaApi(request('POST','/portal/api/media/campaigns',
      {name:'Test',brief:'Original videos'}),res as never,engine,'a',csrf,SECRET);
    assert.equal(res.status,403);
    res=response();
    await handleMediaApi(request('POST','/portal/api/media/campaigns',
      {name:'Test',brief:'Original videos'},csrf),res as never,engine,'a',csrf,SECRET);
    assert.equal(res.status,201);
    const c=JSON.parse(res.body) as {id:string};
    res=response();
    await handleMediaApi(request('GET','/portal/api/media'),res as never,engine,'b',csrf,SECRET);
    assert.equal(res.status,200);
    assert.equal((JSON.parse(res.body) as {campaigns:unknown[]}).campaigns.length,0);
    assert.equal((await engine.list('a')).campaigns[0]?.id,c.id);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('public affiliate redirect is signed, counts only outbound clicks, and cannot switch destinations',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'r72-media-redirect-'));
  try{
    const engine=new MediaEngine(new MediaStore(dir));
    const c=await engine.create('seller1',{name:'Kit',brief:'Emergency supplies'});
    const p=await engine.product('seller1',c.id,{name:'Radio',merchant:'Amazon',productUrl:'https://www.amazon.co.uk/',
      affiliateUrl:'https://amzn.to/test-code'});
    const csrf=mediaCsrf(SECRET,'session');
    let res=response();
    await handleMediaApi(request('GET','/portal/api/media'),res as never,engine,'seller1',csrf,SECRET);
    const output=JSON.parse(res.body) as {campaigns:Array<{products:Array<{trackedPath:string}>}>};
    const route=output.campaigns[0]!.products[0]!.trackedPath;
    res=response();
    await handleAffiliateRedirect(request('GET',route),res as never,engine,SECRET);
    assert.equal(res.status,302);
    assert.equal(res.headers.location,'https://amzn.to/test-code');
    assert.equal((await engine.list('seller1')).campaigns[0]?.products[0]?.clicks,1);
    res=response();
    const tampered=route.slice(0,-1)+(route.endsWith('0')?'1':'0');
    await handleAffiliateRedirect(request('GET',tampered),res as never,engine,SECRET);
    assert.equal(res.status,404);
    assert.equal((await engine.list('seller1')).campaigns[0]?.products[0]?.clicks,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
