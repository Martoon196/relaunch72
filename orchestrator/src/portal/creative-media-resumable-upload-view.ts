/** Unmounted, bounded private uploader. The authenticated routes remain Claude-owned. */
import {layout,csrfField,type Shell} from './seo-blog-view.js';
import {base,STYLE} from './creative-studio-view.js';
export function creativeMediaResumableUploadPage(shell:Shell):string{
 return layout(shell,'Resumable private upload',STYLE+'<section class="card"><h1>Upload private footage</h1><p>MP4 or WebM, up to 20 MB. Pause and resume with the same file; each part and the finished file are checksum checked.</p><form data-media-resumable data-base="'+base(shell)+'">'+csrfField(shell.csrf)+'<label>Video <input type="file" name="video" accept="video/mp4,video/webm,.mp4,.webm" required></label><label>Rights <select name="rights"><option value="owned">I own this footage</option><option value="licensed">I have a licence</option></select></label><label>Licence evidence SHA256 <input name="evidenceSha256" pattern="[a-f0-9]{64}"></label><label><input type="checkbox" name="rightsConfirmed" required>I confirm the rights to store and edit this exact source.</label><button type="submit">Upload or resume</button><button type="button" data-pause>Pause</button><button type="button" data-cancel>Cancel upload</button><progress value="0" max="100" aria-label="Upload progress"></progress><output aria-live="polite">Choose a file to begin.</output></form><p>Uploaded footage awaits a trusted technical probe. This upload does not render or publish.</p></section>','<script src="/portal/seo-blog/media-resumable-upload.js" defer></script>');
}
export const MEDIA_RESUMABLE_UPLOAD_SCRIPT=String.raw`(()=>{'use strict';
for(const form of document.querySelectorAll('[data-media-resumable]')){
 const output=form.querySelector('output'),progress=form.querySelector('progress'),base=form.dataset.base;
 let controller=null,upload=null,busy=false,cancelling=false;
 const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
 const request=async(path,options={})=>{
  const response=await fetch(base+'/uploads/'+path,{...options,credentials:'same-origin',redirect:'error',signal:options.signal??controller?.signal,
   headers:{'x-csrf-token':form.elements.namedItem('_csrf').value,...options.headers}});
  if(!response.ok)throw Error(response.status===409?'Upload changed or expired. Start again with a new upload.':'Upload could not be confirmed. Resume to check its saved state.');
  return response.json();
 };
 const json=body=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 form.querySelector('[data-pause]').addEventListener('click',()=>{controller?.abort();output.textContent='Paused. Select the same file and resume.';});
 form.querySelector('[data-cancel]').addEventListener('click',async()=>{
  controller?.abort();if(!upload)return;cancelling=true;
  try{await request(upload.id+'/cancel',{...json({}),signal:AbortSignal.timeout(15000)});sessionStorage.removeItem(upload.key);upload=null;progress.value=0;output.textContent='Upload cancelled.';}catch(e){output.textContent=e.message;}finally{cancelling=false;}
 });
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy||cancelling)return;const file=form.elements.namedItem('video').files[0];
  if(!file||file.size<1024||file.size>20000000||!/\.(mp4|webm)$/i.test(file.name)||!form.elements.namedItem('rightsConfirmed').checked){output.textContent='Choose an MP4/WebM up to 20 MB and confirm source rights.';return;}
  busy=true;controller=new AbortController();
  try{
   output.textContent='Checking exact file checksum…';const bytes=await file.arrayBuffer(),sha=await digest(bytes);
   const key='rl72-upload:'+base+':'+sha;
   const existing=sessionStorage.getItem(key),id=existing&&/^[a-f0-9-]{36}$/.test(existing)?existing:crypto.randomUUID();
   upload={key,id};sessionStorage.setItem(key,id);
   const rights=form.elements.namedItem('rights').value,evidence=form.elements.namedItem('evidenceSha256').value||null;
   if(rights==='licensed'&&!/^[a-f0-9]{64}$/.test(evidence||''))throw Error('A licence evidence checksum is required.');
   let status=await request('begin',json({uploadId:id,byteLength:file.size,sha256:sha,metadata:{fileName:file.name,mime:/\.webm$/i.test(file.name)?'video/webm':'video/mp4',rights,evidenceSha256:evidence,rightsConfirmed:true}}));
   if(status.state==='cancelled'||Date.parse(status.expiresAt)<=Date.now()){sessionStorage.removeItem(key);throw Error('This upload expired or was cancelled. Submit again to start a new upload.');}
   if(status.state!=='completed')for(let part=0;part<Math.ceil(file.size/1000000);part++){
    if(controller.signal.aborted)throw new DOMException('Paused','AbortError');
    if(!status.parts.includes(part))status=await request(id+'/parts/'+part,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:bytes.slice(part*1000000,Math.min(file.size,(part+1)*1000000))});
    progress.value=Math.round(Math.min(file.size,(part+1)*1000000)/file.size*100);output.textContent='Saved '+progress.value+'%';
   }
   await request(id+'/complete',json({}));progress.value=100;sessionStorage.removeItem(key);output.textContent='Stored privately. Awaiting technical verification.';
  }catch(e){output.textContent=e.name==='AbortError'?'Paused. Resume with the same file.':e.message;}
  finally{busy=false;controller=null;}
 });
}
})();`;
