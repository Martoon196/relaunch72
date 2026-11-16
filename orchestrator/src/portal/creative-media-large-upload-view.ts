import {MEDIA_STREAMING_SHA256} from './media-streaming-sha256.js';
import {layout,csrfField,type Shell} from './seo-blog-view.js';
import {base,STYLE} from './creative-studio-view.js';
export function creativeMediaLargeUploadPage(shell:Shell):string{
 return layout(shell,'Resumable private upload',STYLE+'<section class="card"><h1>Upload private footage</h1><p>MP4 or WebM, up to 1 GB. Pause and resume with the same file; each part and the finished file are checksum checked.</p><form data-media-large-upload data-base="'+base(shell)+'">'+csrfField(shell.csrf)+'<label>Video <input type="file" name="video" accept="video/mp4,video/webm,.mp4,.webm" required></label><label>Rights <select name="rights"><option value="owned">I own this footage</option><option value="licensed">I have a licence</option></select></label><label>Licence document <input type="file" name="licenceEvidence"></label><label><input type="checkbox" name="rightsConfirmed" required>I confirm the rights to store and edit this exact source.</label><button type="submit">Upload or resume</button><button type="button" data-pause>Pause</button><button type="button" data-cancel>Cancel upload</button><progress value="0" max="100" aria-label="Upload progress"></progress><output aria-live="polite">Choose a file to begin.</output></form><p>Uploaded footage awaits a trusted technical probe. This upload does not render or publish.</p></section>','<script src="/portal/seo-blog/media-large-upload.js" defer></script>');
}
const WORKER=MEDIA_STREAMING_SHA256+String.raw`
self.onmessage=async event=>{try{const file=event.data,hash=new RL72Sha256();for(let offset=0;offset<file.size;offset+=1048576){hash.update(new Uint8Array(await file.slice(offset,offset+1048576).arrayBuffer()));self.postMessage({progress:Math.round(Math.min(file.size,offset+1048576)/file.size*100)});}self.postMessage({sha256:hash.hex()});}catch{self.postMessage({error:'Could not read file checksum'});}};`;
export const MEDIA_LARGE_UPLOAD_SCRIPT='const RL72_HASH_WORKER_SOURCE='+JSON.stringify(WORKER)+String.raw`;(()=>{
async function evidenceDigest(file){if(!(file instanceof File)||!file.size)return null;if(file.size>5000000)throw Error('Licence document must be below 5 MB');return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))).map(v=>v.toString(16).padStart(2,'0')).join('');}'use strict';
for(const form of document.querySelectorAll('[data-media-large-upload]')){
 let worker=null,controller=null,current=null,busy=false,cancelling=false;
 const output=form.querySelector('output'),progress=form.querySelector('progress'),base=form.dataset.base;
 const stop=()=>{worker?.terminate();worker=null;controller?.abort();};
 const json=body=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const request=async(path,options={})=>{const response=await fetch(base+'/object-uploads/'+path,{...options,credentials:'same-origin',redirect:'error',signal:options.signal??controller?.signal,headers:{'x-csrf-token':form.elements.namedItem('_csrf').value,...options.headers}});if(!response.ok)throw Error('Upload not confirmed. Resume to check saved parts, or cancel and start again.');return response.json();};
 form.querySelector('[data-pause]').addEventListener('click',()=>{stop();output.textContent='Paused. Select the same file to resume.';});
 form.querySelector('[data-cancel]').addEventListener('click',async()=>{stop();if(!current)return;cancelling=true;try{await request(current.id+'/cancel',{...json({}),signal:AbortSignal.timeout(15000)});sessionStorage.removeItem(current.key);current=null;progress.value=0;output.textContent='Upload cancelled.';}catch(e){output.textContent=e.message;}finally{cancelling=false;busy=false;}});
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy||cancelling)return;const file=form.elements.namedItem('video').files[0];if(!file||file.size<1024||file.size>1073741824||!/\.(mp4|webm)$/i.test(file.name)||!form.elements.namedItem('rightsConfirmed').checked){output.textContent='Choose MP4/WebM up to 1 GB and confirm source rights.';return;}
  busy=true;controller=new AbortController();const signal=controller.signal;
  try{
   output.textContent='Checking file checksum without loading the whole file…';
   const sha256=await new Promise((resolve,reject)=>{const url=URL.createObjectURL(new Blob([RL72_HASH_WORKER_SOURCE],{type:'text/javascript'}));worker=new Worker(url);URL.revokeObjectURL(url);signal.addEventListener('abort',()=>reject(new DOMException('Paused','AbortError')),{once:true});worker.onmessage=e=>{if(e.data.error)reject(Error(e.data.error));else if(e.data.sha256)resolve(e.data.sha256);else output.textContent='Checking checksum: '+e.data.progress+'%';};worker.onerror=()=>reject(Error('Checksum worker unavailable'));worker.postMessage(file);});worker?.terminate();worker=null;
   if(signal.aborted)throw new DOMException('Paused','AbortError');
   const key='rl72-object-upload:'+base+':'+sha256,old=sessionStorage.getItem(key),id=old&&/^[a-f0-9-]{36}$/.test(old)?old:crypto.randomUUID();current={key,id};sessionStorage.setItem(key,id);
   const rights=form.elements.namedItem('rights').value,evidenceSha256=await evidenceDigest(form.elements.namedItem('licenceEvidence').files[0]);
   if(rights==='licensed'&&!/^[a-f0-9]{64}$/.test(evidenceSha256||''))throw Error('Upload your licence document.');
   await request('begin',json({uploadId:id,byteLength:file.size,sha256,fileName:file.name,mime:/\.webm$/i.test(file.name)?'video/webm':'video/mp4',rights,evidenceSha256,rightsConfirmed:true}));
   const saved=await request(id),parts=new Map((saved.parts||[]).map(x=>[x.index,x.sha256]));
   if(saved.state==='cancelled'||Date.parse(saved.expiresAt)<=Date.now()){sessionStorage.removeItem(key);throw Error('Upload expired or cancelled. Submit again for a new upload.');}
   if(saved.state!=='completed')for(let index=0;index<Math.ceil(file.size/8388608);index++){
    if(signal.aborted)throw new DOMException('Paused','AbortError');const bytes=await file.slice(index*8388608,Math.min(file.size,(index+1)*8388608)).arrayBuffer();
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
    if(parts.has(index)&&parts.get(index)!==digest)throw Error('A saved part changed. Cancel this upload and start again.');
    if(!parts.has(index))await request(id+'/parts/'+index,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:bytes});
    progress.value=Math.round(Math.min(file.size,(index+1)*8388608)/file.size*100);output.textContent='Saved '+progress.value+'%';
   }
   await request(id+'/complete',json({}));sessionStorage.removeItem(key);progress.value=100;output.textContent='Stored privately. Awaiting technical probe.';
  }catch(e){output.textContent=e.name==='AbortError'?'Paused. Resume with the same file.':e.message;}
  finally{worker?.terminate();worker=null;if(controller?.signal===signal){controller=null;busy=false;}}
 });
}
})();`;
