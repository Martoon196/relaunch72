/** Served only on the exact native MHP owner route. No network or provider operations. */
export const MHP_SEQUENCE_EDITOR_SCRIPT = String.raw`'use strict';
for (const form of document.querySelectorAll('[data-sequence-editor]')) {
  const initial = JSON.parse(form.dataset.initial), emails = JSON.parse(form.dataset.emails);
  const steps = initial.steps.map(step => ({...step}));
  const container = form.querySelector('[data-steps]'), status = form.querySelector('[data-editor-status]');
  let dragged = null;
  const savedControls = [...document.querySelectorAll('[data-saved-required]')].map(button => ({button, disabled:button.disabled}));
  const node = (tag, text) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
  function current() {
    const result = {...initial, title: form.querySelector('[data-field=title]').value.trim(),
      expiryHours: Number(form.querySelector('[data-field=expiryHours]').value), steps,
      stopOn: Object.fromEntries(['reply','booked','purchased'].map(key => [key, form.querySelector('[data-stop='+key+']').checked]))};
    const mode = form.querySelector('[data-entry-mode]')?.value || 'manual';
    if (initial.schema === 'growthhq.followup-sequence/v2' || mode !== 'manual') {
      result.schema = 'growthhq.followup-sequence/v2'; result.entry = {mode, source:mode === 'manual'?'manual_owner':'mhp.capture/v2'};
    }
    return result;
  }
  function sync() {
    const content = JSON.stringify(current()), dirty = content !== JSON.stringify(initial);
    form.elements.namedItem('definition').value = content;
    for (const control of savedControls) control.button.disabled = dirty || control.disabled;
    status.textContent = steps.length+' of 24 steps. '+(dirty?'Save these changes before publishing or starting.':'Start is a separate action after publication.');
  }
  function move(from, to) {
    if (to < 0 || to >= steps.length) return;
    const [step] = steps.splice(from, 1); steps.splice(to, 0, step); render();
    container.querySelector('[data-step-key="'+step.key+'"] button')?.focus();
  }
  function render() {
    container.replaceChildren();
    steps.forEach((step, index) => {
      const card = node('article'); card.className = 'sequence-step'; card.dataset.stepKey = step.key; card.draggable = true;
      const heading = node('h3', (index+1)+'. '+({email:'Email',wait:'Wait',sms:'Text message',whatsapp:'WhatsApp'})[step.kind]);
      heading.className='drag-handle'; card.append(heading);
      if (step.kind === 'wait') {
        const label=node('label','Wait for'); const amount=node('input'); amount.type='number'; amount.min='0'; amount.step='1'; amount.required=true;
        const unit=node('select'); unit.setAttribute('aria-label','Wait unit');
        for (const [value,text] of [['1','Minutes'],['60','Hours'],['1440','Days']]) { const option=node('option',text); option.value=value; unit.append(option); }
        const selected=step.minutes>0 && step.minutes%1440===0?1440:step.minutes>0&&step.minutes%60===0?60:1;
        unit.value=String(selected); amount.value=String(step.minutes/selected); amount.max=String(525600/selected);
        function update() { const multiplier=Number(unit.value); amount.max=String(Math.floor(525600/multiplier)); step.minutes=Number(amount.value)*multiplier; sync(); }
        amount.addEventListener('input',update); unit.addEventListener('change',update); label.append(amount,unit); card.append(label);
      } else {
        const label=node('label','Saved message version'), select=node('select'); select.required=true;
        for (const email of emails) { const option=node('option',email.label); option.value=[email.itemId,email.versionId,email.sha256].join('|'); select.append(option); }
        const selected=[step.contentItemId,step.contentVersionId,step.contentSha256].join('|');
        if (![...select.options].some(option=>option.value===selected)) { const option=node('option','Previously selected saved version — review before starting'); option.value=selected; select.prepend(option); }
        select.value=selected;
        select.addEventListener('change',()=>{ [step.contentItemId,step.contentVersionId,step.contentSha256]=select.value.split('|'); sync(); });
        label.append(select); card.append(label);
        if (step.kind !== 'email') { const note=node('p','This channel can be planned here. Its MHP sender and permission connection must be completed before this sequence can start.'); note.className='notice';card.append(note); }
      }
      const controls=node('div');controls.className='actions';
      for (const [label,action,disabled] of [['Move up',()=>move(index,index-1),index===0],['Move down',()=>move(index,index+1),index===steps.length-1],['Remove step',()=>{steps.splice(index,1);render();},false]]) {
        const button=node('button',label);button.type='button';button.className='secondary';button.disabled=disabled;button.addEventListener('click',action);controls.append(button);
      }
      card.append(controls);
      card.addEventListener('dragstart',event=>{ if(event.target.closest('input,select,button,a')){event.preventDefault();return;}dragged=step.key;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',step.key); });
      card.addEventListener('dragover',event=>{if(dragged){event.preventDefault();card.classList.add('drag-over');}});
      card.addEventListener('dragleave',()=>card.classList.remove('drag-over'));
      card.addEventListener('drop',event=>{event.preventDefault();card.classList.remove('drag-over');const from=steps.findIndex(item=>item.key===dragged);dragged=null;if(from>=0&&from!==index)move(from,index);});
      card.addEventListener('dragend',()=>{dragged=null;for(const target of container.children)target.classList.remove('drag-over');});
      container.append(card);
    });sync();
  }
  for (const button of form.querySelectorAll('[data-add]')) button.addEventListener('click',()=>{
    if(steps.length>=24){status.textContent='This sequence has its maximum 24 steps.';return;}
    const kind=button.dataset.add,key='step-'+crypto.randomUUID();
    if(kind==='wait')steps.push({key,kind,minutes:60});
    else {const email=emails[0];if(!email){status.textContent='Create a saved email in the email library first, then return here.';return;}
      steps.push({key,kind,contentItemId:email.itemId,contentVersionId:email.versionId,contentSha256:email.sha256});}
    render();
  });
  form.addEventListener('input',sync);form.addEventListener('change',sync);form.addEventListener('submit',sync);render();
}
`;
