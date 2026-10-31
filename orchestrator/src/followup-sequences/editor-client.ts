import { TWILIO_SMS_GSM_BASIC_TEXT } from '../sms-live/foundation.js';
/** Shared native editor. Its only optional fetch reads an exact message on this same authenticated host. */
export const FOLLOWUP_EDITOR_SCRIPT = String.raw`'use strict';
for (const form of document.querySelectorAll('[data-sequence-editor]')) {
  const initial = JSON.parse(form.dataset.initial), emails = JSON.parse(form.dataset.emails);
  const choices = form.dataset.messages ? JSON.parse(form.dataset.messages) : emails.map(item=>({...item,channel:'email'}));
  const inlineField = form.elements.namedItem('inlineMessages'), inline = inlineField ? JSON.parse(inlineField.value || '{}') : {};
  const initialInline = JSON.stringify(inline), smsRegex = new RegExp(${JSON.stringify(TWILIO_SMS_GSM_BASIC_TEXT.source)},'u');
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
    const content = JSON.stringify(current()), dirty = content !== JSON.stringify(initial) || JSON.stringify(inline) !== initialInline;
    form.elements.namedItem('definition').value = content;
    if(inlineField)inlineField.value=JSON.stringify(inline);
    for (const control of savedControls) control.button.disabled = dirty || control.disabled;
    status.textContent = steps.length+' of 24 steps. '+(dirty?'Save these changes before publishing or starting.':'Start is a separate action after publication.');
  }
  function newInline(step) {
    inline[step.key]={channel:step.kind,title:({email:'Email',sms:'Text message',whatsapp:'WhatsApp template'})[step.kind],contentItemId:'',previousVersionId:'',
      payload:step.kind==='email'?{schema:'propertypredator.email-draft/v1',subject:'',bodyText:''}:step.kind==='sms'?{schema:'growthhq.sms-draft/v1',bodyText:''}:{schema:'growthhq.whatsapp-template-draft/v1',templateName:'followup_message',language:'en_GB',bodyText:''}};
  }
  function inlineEditor(step,card) {
    const message=inline[step.key]; if(!message)return;
    const group=node('fieldset'),legend=node('legend','Write this '+({email:'email',sms:'text message',whatsapp:'template draft'})[step.kind]);group.className='flow-inline';group.append(legend);
    function field(label,key,area=false) {const wrap=node('label',label),input=node(area?'textarea':'input');input.required=true;input.value=key==='title'?message.title:message.payload[key]||'';
      if(area){input.rows=7;input.maxLength=step.kind==='email'?50000:step.kind==='sms'?6000:16000;}else input.maxLength=key==='title'?180:key==='subject'?500:100;
      input.addEventListener('input',()=>{if(key==='title')message.title=input.value;else message.payload[key]=input.value;feedback();sync();});wrap.append(input);group.append(wrap);}
    field('Message name','title');if(step.kind==='email')field('Subject','subject');
    if(step.kind==='whatsapp'){field('Template draft name','templateName');field('Language','language');}
    field('Message text','bodyText',true);const note=node('p');note.className='notice';group.append(note);
    function feedback(){const body=message.payload.bodyText||'';
      if(step.kind==='sms'){const supported=smsRegex.test(body)&&body.length<=1530;note.textContent=[...body].length+' characters. '+(supported?(body.length<=160?1:Math.ceil(body.length/153))+' estimated segments for this exact draft. Recipient permission and merged size still need checking.':'Draft retained. Current live encoding or variables are unsupported; no live segment count is available.');}
      else if(step.kind==='whatsapp')note.textContent='Template draft only. No provider approval or sender binding is created. Variables also need a later parameter connection.';
      else note.textContent='Preview fields: {{FIRSTNAME}}, {{LABEL}}, {{LINK}}, {{UNSUBSCRIBE}}. Publishing this flow sends nothing.';}
    feedback();card.append(group);
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
        for (const email of inlineField?choices.filter(choice=>choice.channel===step.kind):emails) { const option=node('option',email.label); option.value=[email.itemId,email.versionId,email.sha256].join('|'); select.append(option); }
        const selected=[step.contentItemId,step.contentVersionId,step.contentSha256].join('|');
        if (![...select.options].some(option=>option.value===selected)) { const option=node('option',inline[step.key]?'Message being written below — save this flow to keep it':'Previously selected saved version — review before starting'); option.value=selected; select.prepend(option); }
        select.value=selected;
        select.required=!inline[step.key];select.disabled=Boolean(inline[step.key]);
        select.addEventListener('change',()=>{ [step.contentItemId,step.contentVersionId,step.contentSha256]=select.value.split('|'); delete inline[step.key];sync(); });
        label.append(select); card.append(label);
        if(inlineField){const actions=node('div');actions.className='actions';const write=node('button',inline[step.key]?'Use a saved version instead':'Write a new message');write.type='button';write.className='secondary';
          write.disabled=Boolean(inline[step.key]&&!inline[step.key].contentItemId&&!choices.some(choice=>choice.channel===step.kind));
          write.addEventListener('click',()=>{if(inline[step.key])delete inline[step.key];else newInline(step);render();});actions.append(write);
          if(!inline[step.key]&&step.contentItemId&&form.dataset.messageEndpoint){const edit=node('button','Edit selected message');edit.type='button';edit.className='secondary';edit.addEventListener('click',async()=>{
            edit.disabled=true;try{const target=new URL(form.dataset.messageEndpoint,location.origin);target.searchParams.set('item',step.contentItemId);target.searchParams.set('version',step.contentVersionId);target.searchParams.set('channel',step.kind);
              if(target.origin!==location.origin)throw Error('same origin required');const response=await fetch(target,{credentials:'same-origin',cache:'no-store',redirect:'error'});if(!response.ok)throw Error('unavailable');const exact=await response.json();
              if(exact.contentItemId!==step.contentItemId||exact.contentVersionId!==step.contentVersionId||exact.contentSha256!==step.contentSha256||exact.channel!==step.kind)throw Error('message changed');
              inline[step.key]={channel:step.kind,title:exact.title,contentItemId:step.contentItemId,previousVersionId:step.contentVersionId,payload:exact.payload};render();
            }catch{status.textContent='The exact message could not be opened. Refresh its saved version before editing.';edit.disabled=false;}});actions.append(edit);}card.append(actions);inlineEditor(step,card);}
        if (step.kind !== 'email') { const note=node('p',step.kind==='sms'?'Before starting, connect this brand’s SMS sender, check recipient permission and complete the joint test.':'Before starting, connect this brand’s WhatsApp sender and a matching approved template, check recipient permission and complete the joint test.'); note.className='notice';card.append(note); }
      }
      const controls=node('div');controls.className='actions';
      for (const [label,action,disabled] of [['Move up',()=>move(index,index-1),index===0],['Move down',()=>move(index,index+1),index===steps.length-1],['Remove step',()=>{delete inline[step.key];steps.splice(index,1);render();},false]]) {
        const button=node('button',label);button.type='button';button.className='secondary';button.disabled=disabled;button.addEventListener('click',action);controls.append(button);
      }
      card.append(controls);
      card.addEventListener('dragstart',event=>{ if(event.target.closest('input,select,textarea,button,a')){event.preventDefault();return;}dragged=step.key;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',step.key); });
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
    else {const email=(inlineField?choices.filter(choice=>choice.channel===kind):emails)[0];if(!email&&!inlineField){status.textContent='Create a saved email in the email library first, then return here.';return;}
      const step={key,kind,contentItemId:email?.itemId||'',contentVersionId:email?.versionId||'',contentSha256:email?.sha256||''};steps.push(step);if(inlineField&&!email)newInline(step);}
    render();
  });
  form.addEventListener('input',sync);form.addEventListener('change',sync);form.addEventListener('submit',sync);render();
}
`;
