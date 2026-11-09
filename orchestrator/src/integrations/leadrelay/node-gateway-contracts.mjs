/* Server-only contracts for reviewed training and verified voice settings. */
const BASE='/api/agent-builder/';
const TRAINING=BASE+'training/';
const TOOL_IDS=['calendar_availability','calendar_book','offer_signup_link','offer_booking_link','offer_payment_link'];
const SOURCE_CATEGORIES=['general','brand_guidelines','brand_voice'];
const PROFILE_FIELDS=['objective','reply_length','one_question','sales_guidance','signup_url','payment_url','instructions','business_capabilities','knowledge_ids','executable_tools'];
const VERSION_STATUSES=['approved','queued','processing','published','failed','uncertain','reconciling'];
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function reviewedPublicLink(value,signup=false){
  if(!value)return '';
  if(/[\x00-\x1f\x7f\\#]/.test(value))throw Error('Invalid reviewed link');
  const url=new URL(value),hostname=url.hostname.replace(/\.$/,'').toLowerCase();
  const labels=hostname.split('.');
  if(url.protocol!=='https:'||url.username||url.password||url.port
    ||labels.length<2||/\.(?:local|internal|localhost)$/.test(hostname)||/^\d+\.\d+\.\d+\.\d+$/.test(hostname)
    ||labels.some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))throw Error('Invalid reviewed link');
  if(value.includes('?')){
    const raw=value.match(/^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?$/i);
    const query=value.slice(value.indexOf('?')+1);
    if(!signup||hostname!=='propertypredator.com'||raw?.[2]!=='/app'
      ||!/^propertypredator\.com(?::443)?$/i.test(raw?.[1]||'')
      ||!/^plan=pro_(?:buyer|investor|business)(?:&promo=[A-Z0-9][A-Z0-9-]{2,63})?$/.test(query))throw Error('Invalid reviewed link');
  }
  url.hostname=hostname;
  return url.href;
}
function contracts(fail) {
  const text=(value,max,min=0)=>{if(typeof value!=='string'||Array.from(value).length<min||Array.from(value).length>max)fail();return value;};
  const integer=(value,max=Number.MAX_SAFE_INTEGER)=>{if(!Number.isSafeInteger(value)||value<0||value>max)fail();return value;};
  const bool=value=>{if(typeof value!=='boolean')fail();return value;};
  const identity=value=>text(value,36,1);
  const digest=value=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/i.test(value))fail();return value;};
  const exact=(value,fields)=>{if(!record(value)||Object.keys(value).some(key=>!fields.includes(key)))fail();};
  const base64=value=>{
    if(typeof value!=='string'||!value.length||value.length>699052||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))fail();
    const decoded=Buffer.from(value,'base64');
    if(!decoded.length||decoded.length>524288||decoded.toString('base64')!==value)fail();
    return value;
  };
  const profile=(value,partial=false)=>{
    exact(value,PROFILE_FIELDS);const out={};
    for(const field of PROFILE_FIELDS) {
      if(partial&&!Object.hasOwn(value,field))continue;
      const v=value[field];
      if(field==='objective'){if(![null,'signup','book','pay'].includes(v))fail();out[field]=v;}
      else if(field==='reply_length'){if(!['existing','short','balanced','detailed'].includes(v))fail();out[field]=v;}
      else if(field==='one_question'){if(v!==null&&typeof v!=='boolean')fail();out[field]=v;}
      else if(field==='sales_guidance')out[field]=bool(v);
      else if(field==='knowledge_ids'){
        if(!Array.isArray(v)||v.length>20||new Set(v).size!==v.length)fail();out[field]=v.map(identity);
      } else if(field==='executable_tools'){
        if(v!==null&&(!Array.isArray(v)||v.length>5||new Set(v).size!==v.length||v.some(id=>!TOOL_IDS.includes(id))))fail();out[field]=v;
      } else if(field==='signup_url'||field==='payment_url'){
        out[field]=text(v,500);
        if(v){try{out[field]=reviewedPublicLink(v,field==='signup_url');}catch{fail();}}
      } else out[field]=text(v,field==='instructions'?8000:4000);
    }
    return out;
  };
  const version=value=>{
    if(value===null)return null;
    if(!record(value))fail();const out={id:identity(value.id)};
    for(const field of ['draft_id','status','step','content_digest','business_name','agent_name','detail','approved_at','created_at','updated_at'])if(Object.hasOwn(value,field)){
      const v=value[field];
      out[field]=field==='content_digest'?digest(v):field.endsWith('_at')?integer(v):text(v,field==='detail'?2000:field==='business_name'?120:field==='agent_name'?80:120);
    }
    return out;
  };
  return {text,integer,bool,identity,digest,exact,base64,profile,version};
}
function noCredential(value,key,fail){
  const exposed=v=>typeof v==='string'?typeof key==='string'&&key.length>=10&&v.includes(key):v&&typeof v==='object'?Object.values(v).some(exposed):false;
  if(exposed(value))fail();return value;
}

export function validateTrainingBody(path,body,fail){
  const c=contracts(fail),name=path.slice(TRAINING.length);
  if(['sources','profile'].includes(name)&&body===undefined)return;
  if(name==='source'||name==='source-review'){
    c.exact(body,name==='source'?['title','content','category']:['source_id','title','content','approved']);
    c.text(body.title,200,1);c.text(body.content,50000,1);
    if(name==='source-review'){c.identity(body.source_id);if(body.approved!==true)fail();}
  }else if(name==='upload'){
    c.exact(body,['filename','content_base64','category']);c.text(body.filename,200,1);
    if(/[\x00-\x1f\\/]/.test(body.filename)||!/^.+\.(txt|md|pdf|docx)$/i.test(body.filename))fail();
    c.base64(body.content_base64);
  }else if(name==='profile')c.profile(body,true);
  else if(name==='approve'){
    c.exact(body,['source_version_id','review_digest','confirmation']);c.identity(body.source_version_id);c.digest(body.review_digest);
    if(body.confirmation!=='APPROVE THIS TRAINING VERSION')fail();
  }else fail();
  if((name==='source'||name==='upload')&&Object.hasOwn(body,'category')&&!SOURCE_CATEGORIES.includes(body.category))fail();
}
export function projectTraining(path,data,key,fail){
  const c=contracts(fail),name=path.slice(TRAINING.length);
  if(!record(data))fail();
  const source=raw=>{
    if(!record(raw))fail();
    const out={source_id:c.identity(raw.source_id),title:c.text(raw.title,200,1),media_type:c.text(raw.media_type,120,1),status:c.text(raw.status,20,1),approved:c.bool(raw.approved),sha256:c.digest(raw.sha256),created_at:c.integer(raw.created_at)};
    if(!['queued','extracting','ready','reviewed','failed'].includes(out.status))fail();
    out.category=Object.hasOwn(raw,'category')?raw.category:'general';
    if(!SOURCE_CATEGORIES.includes(out.category))fail();
    if(Object.hasOwn(raw,'filename'))out.filename=c.text(raw.filename,200,1);
    if(Object.hasOwn(raw,'knowledge_id'))out.knowledge_id=c.identity(raw.knowledge_id);
    if(Object.hasOwn(raw,'content'))out.content=c.text(raw.content,50000);
    if(Object.hasOwn(raw,'reviewed_at'))out.reviewed_at=c.integer(raw.reviewed_at);
    return out;
  };
  let result;
  if(name==='profile'){
    if(data.approval_required!==true||data.provider_publication_required!==true)fail();
    if(!Array.isArray(data.executable_tool_catalog)||data.executable_tool_catalog.length>5)fail();
    result={profile:c.profile(data.profile),saved:c.bool(data.saved),saved_at:data.saved_at===null?null:c.integer(data.saved_at),profile_digest:c.digest(data.profile_digest),review_digest:data.review_digest===null?null:c.digest(data.review_digest),latest_version:c.version(data.latest_version),published_version:c.version(data.published_version),applied_version_id:data.applied_version_id===null?null:c.identity(data.applied_version_id),approval_required:true,provider_publication_required:true,
      executable_tool_catalog:data.executable_tool_catalog.map(tool=>{
        if(!record(tool)||!TOOL_IDS.includes(tool.id)||!['calendar_function','approved_link'].includes(tool.execution))fail();
        return {id:tool.id,title:c.text(tool.title,200,1),description:c.text(tool.description,2000),execution:tool.execution,requires:tool.requires===null?null:c.text(tool.requires,200)};
      })};
    if(Object.hasOwn(data,'legacy_sales_brief'))result.legacy_sales_brief=c.text(data.legacy_sales_brief,20000);
    if(Object.hasOwn(data,'approval_blocker'))result.approval_blocker=c.text(data.approval_blocker,1000);
    const progressFields=['approval_current','approved_version_id','approved_version_status','training_published'];
    if(progressFields.some(field=>Object.hasOwn(data,field))){
      if(!progressFields.every(field=>Object.hasOwn(data,field)))fail();
      const current=c.bool(data.approval_current),published=c.bool(data.training_published);
      const id=data.approved_version_id===null?null:c.identity(data.approved_version_id);
      const status=data.approved_version_status;
      if(status!==null&&!VERSION_STATUSES.includes(status))fail();
      if(current?(!id||status===null):(id!==null||status!==null||published))fail();
      if(published&&status!=='published')fail();
      Object.assign(result,{approval_current:current,approved_version_id:id,approved_version_status:status,training_published:published});
    }
    if(Object.hasOwn(data,'outreach_started')){if(data.outreach_started!==false)fail();result.outreach_started=false;}
  }else{
    if(data.outreach_started!==false)fail();
    if(name==='sources'){
      if(!Array.isArray(data.sources)||data.sources.length>20)fail();
      const rows=data.sources.map(source);
      if(rows.reduce((sum,row)=>sum+Array.from(row.content||'').length,0)>150000)fail();
      result={sources:rows,outreach_started:false};
    }else if(name==='approve'){
      if(data.published_version_unchanged!==true||data.provider_publication_required!==true)fail();
      result={version:c.version(data.version),draft_id:c.identity(data.draft_id),outreach_started:false,published_version_unchanged:true,provider_publication_required:true};
      if(!result.version)fail();
    }else result={source:source(data.source),outreach_started:false};
  }
  return noCredential(result,key,fail);
}

export function validateVoiceBody(path,body,fail){
  const c=contracts(fail);
  if(path===BASE+'voice-settings'){if(body!==undefined)fail();return;}
  if(path===BASE+'voice-catalog'){
    c.exact(body,['provider','gender','accent','query','offset']);
    for(const field of ['provider','gender','accent','query'])if(Object.hasOwn(body,field))c.text(body[field],field==='query'?120:field==='accent'?80:40);
    if(Object.hasOwn(body,'offset'))c.integer(body.offset,2000);
  }else if(path===BASE+'voice-preview'||path===BASE+'voice-choice'){
    c.exact(body,['voice_id']);c.text(body.voice_id,120,1);
  }else if(path===BASE+'voice-apply'){
    c.exact(body,['version_id','request_id','confirmation']);c.identity(body.version_id);
    if(typeof body.request_id!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(body.request_id)||body.confirmation!=='APPLY VERIFIED VOICE TO MY AGENT')fail();
  }else fail();
}
export function projectVoice(path,data,body,key,fail){
  const c=contracts(fail);
  if(!record(data)||data.outreach_started!==false)fail();
  const voice=raw=>{
    if(!record(raw))fail();const out={};
    for(const field of ['voice_id','voice_name'])if(Object.hasOwn(raw,field))out[field]=c.text(raw[field],120);
    return out;
  };
  let result;
  if(path===BASE+'voice-settings'){
    if(data.provider!=='retell')fail();
    let published=null;
    if(data.published!==null){if(!record(data.published))fail();published={...voice(data.published),version_id:c.identity(data.published.version_id),status:c.text(data.published.status,40)};}
    result={provider:'retell',verified:c.bool(data.verified),saved_voice:voice(data.saved_voice),published,can_apply:c.bool(data.can_apply),blocker:data.blocker===null?null:c.text(data.blocker,1000),outreach_started:false};
    if(Object.hasOwn(data,'voice_operation')){
      const operation=data.voice_operation;
      if(operation===null)result.voice_operation=null;
      else{
        if(!record(operation)||typeof operation.operation_id!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(operation.operation_id)
          ||!VERSION_STATUSES.includes(operation.status)||!['voice','publish_voice','complete'].includes(operation.step))fail();
        const row={operation_id:operation.operation_id,parent_version_id:c.identity(operation.parent_version_id),version_id:c.identity(operation.version_id),status:operation.status,step:operation.step,unchanged:c.bool(operation.unchanged)};
        if(row.unchanged||row.parent_version_id===row.version_id)fail();
        if(row.status==='published'&&published?.version_id!==row.version_id)fail();
        result.voice_operation=row;
      }
    }
  }else if(path===BASE+'voice-apply'){
    if(data.operation_id!==body.request_id||!['approved','queued','processing','published','failed','uncertain','reconciling'].includes(data.status))fail();
    if(data.queued!==['queued','processing'].includes(data.status))fail();
    result={operation_id:data.operation_id,version_id:c.identity(data.version_id),status:data.status,queued:data.queued,unchanged:c.bool(data.unchanged),outreach_started:false};
  }else if(path===BASE+'voice-choice'){
    if(data.provider!=='retell'||data.saved!==true||data.voice_id!==body.voice_id)fail();
    result={provider:'retell',saved:true,voice_id:c.text(data.voice_id,120,1),outreach_started:false};
    if(Object.hasOwn(data,'voice_name'))result.voice_name=c.text(data.voice_name,120);
  }else if(path===BASE+'voice-preview'){
    if(data.provider!=='retell'||data.voice_id!==body.voice_id||!['audio/mpeg','audio/wav','audio/x-wav','audio/ogg','audio/webm','audio/mp4'].includes(data.mime))fail();
    const audio=c.base64(data.audio_base64);
    if(typeof key==='string'&&key.length>=10&&Buffer.from(audio,'base64').includes(Buffer.from(key)))fail();
    result={provider:'retell',voice_id:data.voice_id,mime:data.mime,audio_base64:audio,outreach_started:false};
  }else if(path===BASE+'voice-catalog'){
    if(data.provider!=='retell'||!Array.isArray(data.voices)||data.voices.length>200||!record(data.facets))fail();
    const facets={};for(const field of ['providers','genders','accents']){if(!Array.isArray(data.facets[field])||data.facets[field].length>2000)fail();facets[field]=data.facets[field].map(v=>c.text(v,120));}
    result={provider:'retell',voices:data.voices.map(row=>{const out=voice(row);if(!out.voice_id||!out.voice_name)fail();for(const field of ['provider','gender','accent','age','language'])if(Object.hasOwn(row,field))out[field]=c.text(row[field],120);out.supported=c.bool(row.supported);return out;}),facets,total:c.integer(data.total,2000),offset:c.integer(data.offset,2000),next_offset:data.next_offset===null?null:c.integer(data.next_offset,2000),truncated:c.bool(data.truncated),outreach_started:false};
  }else fail();
  return noCredential(result,key,fail);
}

/** Public widget installation details remain scoped to the existing builder read. */
export function projectWebsiteChat(data,key,fail){
  const c=contracts(fail);
  if(!record(data))fail();
  let script;
  try{script=new URL(data.script_url);if(script.protocol!=='https:'||script.username||script.password||script.search||script.hash||script.pathname!=='/widget.js')fail();}catch{fail();}
  const result={workspace_id:c.identity(data.workspace_id),script_url:c.text(script.href,2000,1)};
  for(const name of ['runtime_enabled','worker_enabled','business_enabled','chat_enabled','paused','available'])result[name]=c.bool(data[name]);
  if(!/^[A-Za-z0-9_-]+$/.test(result.workspace_id)||!Array.isArray(data.origins)||data.origins.length>20)fail();
  result.origins=data.origins.map(value=>{
    c.text(value,2000,1);let origin;
    try{origin=new URL(value);if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||!['','/'].includes(origin.pathname))fail();}catch{fail();}
    return origin.origin;
  });
  result.deployed_version_id=data.deployed_version_id===null?null:c.identity(data.deployed_version_id);
  if(result.available&&(!result.runtime_enabled||!result.worker_enabled||!result.business_enabled||!result.chat_enabled||result.paused||!result.deployed_version_id||!result.origins.length))fail();
  return noCredential(result,key,fail);
}
