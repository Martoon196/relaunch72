/** Native private clip editing; never submits a provider or posts online. */
export const MEDIA_CUT_EDITOR_SCRIPT=String.raw`(()=>{
'use strict';
for(const form of document.querySelectorAll('[data-rl72-cut-editor]')){
 const textarea=form.querySelector('textarea[name="planJson"]');
 let edit;try{edit=JSON.parse(textarea.value);}catch{continue;}
 if(!Array.isArray(edit.clips))continue;
 const root=document.createElement('section');root.setAttribute('aria-label','Edit private video timeline');
 const heading=document.createElement('h3');heading.textContent='Video clip timeline';root.append(heading);
 const timeline=document.createElement('div');root.append(timeline);
 const toolbar=document.createElement('div');root.append(toolbar);
 const button=(host,label,callback)=>{
  const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',callback);host.append(b);
 };
 const sync=()=>{textarea.value=JSON.stringify(edit);};
 function render(){
  timeline.replaceChildren();
  edit.clips.forEach((clip,i)=>{
   const group=document.createElement('fieldset');const label=document.createElement('legend');
   label.textContent='Clip '+(i+1);group.append(label);
   for(const [name,description] of [['startMs','Start (milliseconds)'],['endMs','End (milliseconds)'],['caption','Caption']]){
    const l=document.createElement('label');l.textContent=description;
    const control=document.createElement('input');control.type=name==='caption'?'text':'number';
    control.value=String(clip[name]??'');control.setAttribute('aria-label',description+' clip '+(i+1));
    control.addEventListener('input',()=>{clip[name]=name==='caption'?control.value:Number(control.value);sync();});
    l.append(control);group.append(l);
   }
   button(group,'Move earlier',()=>{if(i<1)return;[edit.clips[i-1],edit.clips[i]]=[edit.clips[i],edit.clips[i-1]];render();});
   button(group,'Move later',()=>{if(i>=edit.clips.length-1)return;[edit.clips[i+1],edit.clips[i]]=[edit.clips[i],edit.clips[i+1]];render();});
   button(group,'Remove',()=>{if(edit.clips.length<=1)return;edit.clips.splice(i,1);render();});
   timeline.append(group);
  });
  sync();
 }
 button(toolbar,'Add clip',()=>{if(edit.clips.length>=12)return;
  const last=edit.clips[edit.clips.length-1];const start=last?.endMs??0;
  edit.clips.push({startMs:start,endMs:start+3000,caption:'',transition:'cut',speed:1});render();});
 for(const canvas of ['portrait','square','landscape'])button(toolbar,canvas,()=>{edit.canvas=canvas;sync();});
 form.insertBefore(root,textarea.closest('label'));textarea.hidden=true;render();
}
})();`;
