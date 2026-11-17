import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,mkdir,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {renderLocalVideo,assertLocalRenderCapacity} from '../src/creative-studio/media-local-render.js';
import {ffprobeFromBytes} from '../src/creative-studio/media-source-probe.js';
const caption=('A long caption must never hide the advertising disclosure. ').repeat(5).slice(0,240);
const run=(bin:string,args:string[])=>{const r=spawnSync(bin,args,{encoding:'utf8',timeout:120000});assert.equal(r.status,0,r.stderr);return r.stdout;};
test('a 240-character caption leaves #ad readable in rendered safe area for every canvas',{timeout:180000,skip:spawnSync('tesseract',['--version']).status!==0?'Tesseract is not installed':false},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rl72-visible-ad-'));
 try{
  const input=join(dir,'input.mp4');run('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=navy:s=320x180:r=30','-t','2','-c:v','libx264','-threads','1',input]);
  const bytes=await readFile(input),probe=await ffprobeFromBytes(bytes);assert.equal(caption.length,240);
  for(const canvas of ['portrait','square','landscape'] as const){
   const output=await renderLocalVideo({bytes,sha256:createHash('sha256').update(bytes).digest('hex'),probe},{canvas,disclosure:'#ad',clips:[{startMs:0,endMs:2000,speed:1,transition:'fade',caption}]});
   const video=join(dir,canvas+'.mp4'),frame=join(dir,canvas+'.png');await writeFile(video,output.bytes);
   run('ffmpeg',['-hide_banner','-loglevel','error','-y','-ss','1','-i',video,'-frames:v','1',frame]);
   // OCR reads pixels from the actual exported frame, not filter text or caption files.
   const crop=join(dir,canvas+'-safe.png');run('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',frame,'-vf','crop=180:100:iw*0.13:ih*0.20,scale=360:200','-frames:v','1',crop]);
   assert.match(run('tesseract',[crop,'stdout','--psm','7']),/#ad\b/iu);
   if(process.env.RL72_MEDIA_FRAME_EVIDENCE==='write'){const evidence=resolve('docs/rl72-media-audit-evidence');await mkdir(evidence,{recursive:true});await copyFile(frame,join(evidence,'visible-ad-240-'+canvas+'.png'));}
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('five-minute timelines receive a fitting bitrate before encoding',()=>{
 assert.ok(assertLocalRenderCapacity({canvas:'portrait',disclosure:'#ad',clips:Array.from({length:3},()=>({startMs:0,endMs:100000,speed:1,transition:'cut' as const,caption:''}))})<20_000_000);
});
