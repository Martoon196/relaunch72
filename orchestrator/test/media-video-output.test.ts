import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadProviderVideo} from '../src/creative-studio/media-video-output-pg-store.js';
const mp4=()=>{const b=Buffer.alloc(1024);b.writeUInt32BE(24,0);b.write('ftyp',4);return b;};
test('capture only approved provider host, HTTPS, exact MIME and byte signature',async()=>{
 let calls=0;const http=async()=>{calls++;return new Response(mp4(),{status:200,headers:{'Content-Type':'video/mp4'}});};
 await assert.rejects(downloadProviderVideo('https://evil.example/hijack.mp4',undefined,http as typeof fetch),/allowlist/);
 assert.equal(calls,0);
 const good=await downloadProviderVideo('https://cdn.shotstack.io/demo.mp4',undefined,http as typeof fetch);
 assert.equal(good.sha256.length,64);assert.equal(good.bytes.length,1024);assert.equal(calls,1);
});
test('provider redirects, invalid content types and incorrect file signatures are never stored',async()=>{
 const red=async()=>new Response(null,{status:302,headers:{Location:'https://evil.test/file.mp4'}});
 await assert.rejects(downloadProviderVideo('https://cdn.shotstack.io/demo.mp4',undefined,red as typeof fetch),/redirect/);
 const fake=async()=>new Response(Buffer.alloc(1024),{status:200,headers:{'Content-Type':'video/mp4'}});
 await assert.rejects(downloadProviderVideo('https://cdn.shotstack.io/demo.mp4',undefined,fake as typeof fetch),/signature/);
 const html=async()=>new Response('<html>invalid</html>',{status:200,headers:{'Content-Type':'text/html'}});
 await assert.rejects(downloadProviderVideo('https://cdn.shotstack.io/demo.mp4',undefined,html as typeof fetch),/video type/);
});
