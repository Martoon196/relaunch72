/** Filename/title hints only. The owner keeps the final kind choice. No file bytes are read. */
export const KNOWLEDGE_CATEGORY_SCRIPT = `(() => {
  const form=document.querySelector('[data-knowledge-upload]'); if(!form)return;
  const title=form.querySelector('[name="title"]'), file=form.querySelector('[name="file"]'), kind=form.querySelector('[name="category"]'), hint=form.querySelector('[data-kind-hint]');
  let chosen=false; kind.addEventListener('change',()=>{chosen=true;});
  const update=()=>{
    const name=(title.value+' '+(file.files?.[0]?.name||'')).replace(/[_-]/g,' ');
    let value=null;
    if(/\\b(voice|tone|copy samples?)\\b/i.test(name))value='voice_samples';
    else if(/\\b(products?|pricing|plans?|packages?|offers?|facts?)\\b/i.test(name))value='product_facts';
    else if(/\\b(faqs?|questions? and answers?)\\b/i.test(name))value='faqs';
    else if(/\\b(audience|personas?)\\b/i.test(name))value='audience_notes';
    else if(/\\b(visual|logos?|photography|imagery)\\b/i.test(name))value='visual_guidance';
    else if(/\\bapproved claims?\\b/i.test(name))value='approved_claims';
    else if(/\\b(brand|style|guidelines?)\\b/i.test(name))value='brand_guidelines';
    if(value&&!chosen){kind.value=value;hint.textContent='Suggested kind from the name: '+kind.options[kind.selectedIndex].text+'. Change it if needed.';}
    else if(!chosen){kind.value='';hint.textContent='Choose the kind that best describes this guidance. You can correct it later.';}
  };
  title.addEventListener('input',update);file.addEventListener('change',update);
})();`;
