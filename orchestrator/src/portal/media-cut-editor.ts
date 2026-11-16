/**
 * In-form HTML5 video timeline — no external editor dependency, no network
 * requests other than the authenticated owner-only source preview route.
 * Hidden JSON remains the canonical CSRF-backed versioned save payload.
 */
export const MEDIA_CUT_EDITOR_SCRIPT=String.raw`(()=>{
'use strict';
for(const form of document.querySelectorAll('[data-rl72-cut-editor]')){
 const textarea=form.querySelector('textarea[name="planJson"]');
 let edit;try{edit=JSON.parse(textarea.value);}catch{continue;}
 if(!edit||!Array.isArray(edit.clips))continue;
 const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
 const root=node('section');root.className='rl72-cut-editor';
 root.setAttribute('aria-label','Private editable video timeline');
 const header=node('h3','Video timeline editor');root.append(header);
 root.append(node('p','Choose a private source, trim and reorder clips, caption them, and save an immutable edit. Saving never renders or publishes.'));
 const preview=node('video');preview.controls=true;preview.preload='none';preview.playsInline=true;
 preview.width=320;preview.setAttribute('aria-label','Private source clip preview');
 root.append(preview);
 const formSource=form.elements.namedItem('source');
 function setPreview(){
  const selected=formSource&&'value' in formSource?String(formSource.value).split(':')[0]:'';
  if(!/^[0-9a-f-]{36}$/i.test(selected))return;
  const base=form.getAttribute('data-rl72-preview-base')||'';
  preview.src=base+'/sources/'+encodeURIComponent(selected)+'/stream';
 }
 if(formSource&&formSource.addEventListener)formSource.addEventListener('change',setPreview);
 setPreview();
 const details=node('div');details.className='rl72-cut-settings';root.append(details);
 const makeControl=(host,labelText,kind,initial,onChange,options)=>{
  const label=node('label',labelText);const field=node(kind==='select'||kind==='textarea'?kind:'input');
  field.setAttribute('aria-label',labelText);
  if(kind==='select'){
   for(const option of options){const el=node('option',option[1]);el.value=option[0];field.append(el);}
  }else{
   if(kind!=='textarea')field.type=kind;
   field.maxLength=labelText==='Caption'?240:280;
  }
  field.value=String(initial??'');
  field.addEventListener('change',()=>onChange(field.value));
  field.addEventListener('input',()=>onChange(field.value));
  label.append(field);host.append(label);return field;
 };
 const history=[];const future=[];let last=JSON.stringify(edit);let restoring=false;
 const sync=()=>{
  const next=JSON.stringify(edit);
  if(next!==last&&!restoring){history.push(last);if(history.length>100)history.shift();future.length=0;}
  textarea.value=next;last=next;
 };
 const restore=(from,to)=>{
  if(!from.length)return;to.push(last);edit=JSON.parse(from.pop());restoring=true;
  format.value=edit.canvas;disclose.value=edit.disclosure;redraw();restoring=false;
 };
 let previewEnd=null;
 preview.addEventListener('timeupdate',()=>{
  if(previewEnd!==null&&preview.currentTime>=previewEnd){preview.pause();previewEnd=null;}
 });
 const status=node('output');status.setAttribute('aria-live','polite');status.setAttribute('tabindex','-1');root.append(status);
 const format=makeControl(details,'Output format','select',edit.canvas,
  value=>{edit.canvas=value;sync();summarise();},
  [['portrait','Portrait 9:16'],['square','Square 1:1'],['landscape','Landscape 16:9']]);
 const disclose=makeControl(details,'Required on-screen #ad disclosure','textarea',edit.disclosure,
  value=>{edit.disclosure=value;sync();},[]);
 const timeline=node('div');timeline.className='rl72-cut-clips';
 timeline.setAttribute('role','group');timeline.setAttribute('aria-label','Clip sequence');root.append(timeline);
 const toolbar=node('div');toolbar.className='rl72-cut-tools';root.append(toolbar);
 function button(host,label,action){
  const b=node('button',label);b.type='button';b.addEventListener('click',action);host.append(b);return b;
 }
 function summarise(){
  const secs=edit.clips.reduce((total,clip)=>total+
   Math.max(0,Number(clip.endMs)-Number(clip.startMs))/Math.max(0.5,Number(clip.speed)||1),0)/1000;
  status.textContent=edit.clips.length+' clips · '+secs.toFixed(1)+'s · '+edit.canvas;
  sync();
 }
 function redraw(){
  timeline.replaceChildren();
  edit.clips.forEach((clip,i)=>{
   const box=node('fieldset');box.className='rl72-cut-clip';
   box.append(node('legend','Scene '+(i+1)));
   const range=node('div');range.className='rl72-cut-range';box.append(range);
   makeControl(range,'Start (ms)','number',clip.startMs,value=>{
    clip.startMs=Number(value);summarise();},[]);
   makeControl(range,'End (ms)','number',clip.endMs,value=>{
    clip.endMs=Number(value);summarise();},[]);
   makeControl(box,'Caption','text',clip.caption,value=>{clip.caption=value;sync();},[]);
   makeControl(box,'Playback speed','select',clip.speed,value=>{
    clip.speed=Number(value);summarise();},[['0.5','0.5×'],['1','1×'],['2','2×']]);
   makeControl(box,'Transition','select',clip.transition,value=>{
    clip.transition=value;sync();},[['cut','Direct cut'],['fade','Fade in/out']]);
   const actions=node('div');actions.className='rl72-cut-actions';box.append(actions);
   makeControl(box,'Audio volume','select',clip.volume??1,value=>{
    clip.volume=Number(value);sync();},[['0','Muted'],['0.25','25%'],['0.5','50%'],['1','100%']]);
   button(actions,'Split at playhead',()=>{
    const at=Math.round(Number(preview.currentTime)*1000);
    if(edit.clips.length>=12||!Number.isSafeInteger(at)
      ||(at-clip.startMs)/clip.speed<500||(clip.endMs-at)/clip.speed<500){
     status.textContent='Place the playhead inside this clip with at least half a second on each side.';return;
    }
    edit.clips.splice(i,1,{...clip,endMs:at},{...clip,startMs:at});redraw();
   });
   button(actions,'Duplicate clip',()=>{
    if(edit.clips.length>=12)return;edit.clips.splice(i+1,0,{...clip});redraw();
   });
   button(actions,'Use playhead as start',()=>{
    const at=Math.round(Number(preview.currentTime)*1000);
    if(Number.isSafeInteger(at)&&at>=0&&(clip.endMs-at)/clip.speed>=500){clip.startMs=at;redraw();}
   });
   button(actions,'Use playhead as end',()=>{
    const at=Math.round(Number(preview.currentTime)*1000);
    if(Number.isSafeInteger(at)&&(at-clip.startMs)/clip.speed>=500){clip.endMs=at;redraw();}
   });
   button(actions,'Preview clip',()=>{
    const sec=Math.max(0,Number(clip.startMs)||0)/1000;
    preview.currentTime=sec;previewEnd=Number(clip.endMs)/1000;
    preview.playbackRate=Number(clip.speed)||1;preview.volume=Number(clip.volume??1);
    const started=preview.play();if(started&&started.catch)started.catch(()=>{});
   });
   button(actions,'Move earlier',()=>{
    if(i===0)return;[edit.clips[i-1],edit.clips[i]]=[edit.clips[i],edit.clips[i-1]];redraw();
   });
   button(actions,'Move later',()=>{
    if(i===edit.clips.length-1)return;
    [edit.clips[i],edit.clips[i+1]]=[edit.clips[i+1],edit.clips[i]];redraw();
   });
   button(actions,'Remove',()=>{
    if(edit.clips.length<=1)return;edit.clips.splice(i,1);redraw();
   });
   timeline.append(box);
  });summarise();
 }
 button(toolbar,'Undo',()=>restore(history,future));
 button(toolbar,'Redo',()=>restore(future,history));
 root.addEventListener('keydown',event=>{
  if(!(event.ctrlKey||event.metaKey)||String(event.key).toLowerCase()!=='z')return;
  const tag=String(event.target?.tagName||'').toLowerCase();
  if(tag==='input'||tag==='textarea')return;
  event.preventDefault();if(event.shiftKey)restore(future,history);else restore(history,future);
 });
 button(toolbar,'Add clip',()=>{
  if(edit.clips.length>=12)return;
  const last=edit.clips[edit.clips.length-1];
  const start=Math.max(0,Number(last?.endMs??0));
  edit.clips.push({startMs:start,endMs:start+3000,caption:'',transition:'cut',speed:1});redraw();
 });
 form.addEventListener('submit',event=>{
  const seconds=edit.clips.reduce((n,c)=>n+(Number(c.endMs)-Number(c.startMs))/Number(c.speed),0)/1000;
  const invalid=edit.clips.length<1||edit.clips.length>12||!Number.isFinite(seconds)||seconds>300
   ||edit.clips.some(c=>!Number.isSafeInteger(c.startMs)||!Number.isSafeInteger(c.endMs)
    ||c.startMs<0||c.endMs<=c.startMs||c.endMs>36000000||c.caption.length>240
    ||!Number.isFinite((c.endMs-c.startMs)/c.speed)||(c.endMs-c.startMs)/c.speed<500
    ||(c.endMs-c.startMs)/c.speed>120000||![0,0.25,0.5,1].includes(c.volume??1)
    ||![0.5,1,2].includes(c.speed)||!['cut','fade'].includes(c.transition));
  if(invalid){
   event.preventDefault();
   status.textContent='Check timing and speed; the output must be no longer than five minutes.';
   status.focus();
  }else sync();
 });
 form.insertBefore(root,textarea.closest('label'));textarea.hidden=true;
 format.value=String(edit.canvas);disclose.value=String(edit.disclosure);redraw();
}
})();`;
