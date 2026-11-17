/**
 * RL72's browser-only storyboard timeline editor. An enhancement over the
 * canonical, owner-session-checked scene form. All edits are local until the
 * existing form is saved, rendered and separately approved. No upload, AI
 * generation, external SDK or third-party media call is made by this script.
 */
export const MEDIA_SCENE_TIMELINE_SCRIPT = String.raw`(() => {
  'use strict';
  const forms = document.querySelectorAll('form[data-rl72-scene-editor]');
  const field = (form, index, part) => form.elements.namedItem('scene.' + index + '.' + part);
  function controls(form) {
    const count = Number(form.elements.namedItem('scene_count')?.value || 0);
    return Array.from({length: count}, (_, i) => i);
  }
  function collect(form) {
    return controls(form).map(i => {
      const val = part => { const control=field(form,i,part); return control && 'value' in control ? control.value : ''; };
      const yes = part => Boolean(field(form,i,part)?.checked);
      return {headline:val('headline'), body:val('body'), duration:Math.max(1500,Number(val('duration'))||3000),
        motion:val('motion'), script:val('script'), cta:yes('cta'), remove:yes('remove')};
    });
  }
  function apply(form, data) {
    data.forEach((scene,i) => {
      for (const key of ['headline','body','duration','motion','script']) {
        const input=field(form,i,key); if (input && 'value' in input) input.value=String(scene[key]??'');
      }
      for (const key of ['cta','remove']) {
        const input=field(form,i,key); if (input && 'checked' in input) input.checked=Boolean(scene[key]);
      }
    });
  }
  function build(form) {
    const details = form.closest('details');
    if (!details) return;
    details.open = true;
    let selected=0, current=0, running=false, last=0;
    const history=[collect(form)]; let pointer=0;
    const root=document.createElement('section');root.className='rl72-scene-editor';
    root.setAttribute('aria-label','Interactive video storyboard timeline');
    const h=document.createElement('h4');h.textContent='Interactive scene timeline';root.append(h);
    const note=document.createElement('p');note.className='muted small';
    note.textContent='Preview scene timing and reorder text before saving. The actual export uses the approved server renderer.';
    root.append(note);
    const timeline=document.createElement('div');timeline.className='rl72-scenes';
    timeline.setAttribute('role','group');timeline.setAttribute('aria-label','Scene sequence');root.append(timeline);
    const preview=document.createElement('div');preview.className='rl72-scene-preview';
    preview.setAttribute('role','group');preview.setAttribute('aria-label','Scene preview');
    const headline=document.createElement('strong'), body=document.createElement('span');
    preview.append(headline,body);root.append(preview);
    const toolbar=document.createElement('div');toolbar.className='rl72-scene-tools';root.append(toolbar);
    const scrub=document.createElement('input');scrub.type='range';scrub.min='0';scrub.max='1000';scrub.step='1';
    scrub.value='0';scrub.setAttribute('aria-label','Scrub storyboard playback position');
    const clock=document.createElement('output');clock.textContent='0.0 s';
    root.append(scrub,clock);
    form.prepend(root);
    const button=(text,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=text;
      b.addEventListener('click',fn);toolbar.append(b);return b;};
    const push=()=>{history.splice(pointer+1);history.push(collect(form));pointer=history.length-1;
      if(history.length>60){history.shift();pointer=Math.max(0,pointer-1);}};
    const visual=()=>{const all=collect(form).filter(x=>x.headline.trim()&&!x.remove);
      const length=all.reduce((n,s)=>n+s.duration,0);
      const ms=Math.min(current,length||0);
      let elapsed=0,active=0;
      for(let i=0;i<all.length;i++){if(ms<elapsed+all[i].duration||i===all.length-1){active=i;break;}elapsed+=all[i].duration;}
      selected=Math.min(active,Math.max(0,all.length-1));
      const scene=all[selected];headline.textContent=scene?.headline||'Add a scene to preview';
      body.textContent=scene?.body||'';clock.textContent=(ms/1000).toFixed(1)+' s / '+(length/1000).toFixed(1)+' s';
      scrub.value=String(length?Math.round(ms/length*1000):0);
      timeline.replaceChildren();
      all.forEach((s,i)=>{const b=document.createElement('button');b.type='button';
        b.className='rl72-scene-block'+(i===selected?' selected':'');b.textContent=String(i+1)+' · '+s.headline;
        b.style.flexGrow=String(Math.max(1,s.duration));b.title=(s.duration/1000).toFixed(1)+' seconds';
        b.addEventListener('click',()=>{running=false;current=all.slice(0,i).reduce((n,x)=>n+x.duration,0);visual();});
        timeline.append(b);});
      return length;
    };
    const play=button('▶ Play storyboard',()=>{if(running){running=false;play.textContent='▶ Play storyboard';return;}
      if(current>=visual())current=0;running=true;last=0;play.textContent='❚❚ Pause';requestAnimationFrame(tick);});
    function tick(ts){if(!running)return; if(last)current+=Math.min(100,ts-last);last=ts;
      const end=visual();if(current>=end){running=false;last=0;play.textContent='▶ Play storyboard';return;}
      requestAnimationFrame(tick);}
    button('← Move scene',()=>move(-1));button('Move scene →',()=>move(1));
    function move(direction){const data=collect(form);const visible=data.map((s,i)=>({s,i})).filter(x=>x.s.headline&&!x.s.remove);
      const original=visible[selected]?.i;const peer=visible[selected+direction]?.i;
      if(original===undefined||peer===undefined)return;
      [data[original],data[peer]]=[data[peer],data[original]];apply(form,data);push();
      const next=visible.slice(0,Math.max(0,selected+direction)).reduce((n,x)=>n+x.s.duration,0);
      current=next;visual();}
    button('Undo',()=>{if(pointer<=0)return;pointer--;apply(form,history[pointer]);current=0;visual();});
    button('Redo',()=>{if(pointer>=history.length-1)return;pointer++;apply(form,history[pointer]);current=0;visual();});
    scrub.addEventListener('input',()=>{running=false;play.textContent='▶ Play storyboard';
      const length=collect(form).filter(s=>s.headline&&!s.remove).reduce((n,s)=>n+s.duration,0);
      current=length*Number(scrub.value)/1000;visual();});
    form.addEventListener('change',e=>{if(e.target!==scrub){running=false;push();visual();}});
    form.addEventListener('input',e=>{if(e.target!==scrub)visual();});
    form.addEventListener('submit',()=>{running=false;});
    visual();
  }
  forms.forEach(build);
})();`;