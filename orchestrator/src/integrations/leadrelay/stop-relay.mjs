/** Server-only stop delivery. No scheduler, public route, enrolment or provider send.
 * Source schema: integrations/external-events/contracts.ts, PP catalogue v1.
 * The injected loader MUST read verified canonical HQ evidence, never request JSON.
 */
import {createHash,createHmac} from 'node:crypto';
import {isIP} from 'node:net';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY=/^[a-z0-9][a-z0-9._-]{0,63}$/;
const REF=/^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_RESPONSE=4096;
const record=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,required,optional=[])=>record(x)&&required.every(k=>Object.hasOwn(x,k))&&Object.keys(x).every(k=>required.includes(k)||optional.includes(k));
const uuid=x=>typeof x==='string'&&UUID.test(x);
const ref=(x,max)=>typeof x==='string'&&x.length<=max&&REF.test(x);
const instant=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const hold=(eventId,reason)=>Object.freeze({disposition:'held',eventId:uuid(eventId)?eventId:null,reason});

function configuration(input){
  if(!record(input)||!uuid(input.hqWorkspaceId)||!uuid(input.leadRelayWorkspaceId)
    ||typeof input.installationId!=='string'||!/^[a-z0-9][a-z0-9-]{0,47}$/.test(input.installationId)
    ||typeof input.hookSecret!=='string'||input.hookSecret.length<32||input.hookSecret.length>4096||/[\r\n\x00]/.test(input.hookSecret)
    ||!Array.isArray(input.purchaseProductKeys)||!input.purchaseProductKeys.length||input.purchaseProductKeys.length>64
    ||new Set(input.purchaseProductKeys).size!==input.purchaseProductKeys.length||input.purchaseProductKeys.some(k=>typeof k!=='string'||!KEY.test(k)))throw Error('Invalid stop relay configuration');
  let url;
  try{url=new URL(input.origin);}catch{throw Error('Invalid stop relay configuration');}
  const host=url.hostname.toLowerCase(),labels=host.split('.');
  if(typeof input.origin!=='string'||/[\x00-\x20\x7f\\]/.test(input.origin)||url.protocol!=='https:'||url.username||url.password||url.port
    ||!['','/'].includes(url.pathname)||url.search||url.hash||isIP(host)||labels.length<2
    ||/\.(?:local|internal|localhost)$/.test(host)||labels.some(v=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v)))throw Error('Invalid stop relay configuration');
  const timeoutMs=input.timeoutMs??5000;
  if(!Number.isInteger(timeoutMs)||timeoutMs<250||timeoutMs>10000)throw Error('Invalid stop relay configuration');
  return Object.freeze({...input,origin:url.origin,purchaseProductKeys:Object.freeze([...input.purchaseProductKeys]),timeoutMs});
}

function canonicalEvent(value){
  // Revalidate the supported exact v1 shapes; adding a source event requires a
  // reviewed translation, not a permissive event-name alias.
  if(!exact(value,['id','type','version','occurredAt','correlationId','subject','data'])||!uuid(value.id)||value.version!==1
    ||!uuid(value.correlationId)||!instant(value.occurredAt)||!exact(value.subject,['kind','id'])||value.subject.kind!=='account'||!uuid(value.subject.id))return false;
  const d=value.data;
  if(value.type==='commerce.purchase.completed')return exact(d,['provider','providerEventId','checkoutSessionId','productKey','billingKind','amountMinor','currency'],['subscriptionId'])
    &&d.provider==='stripe'&&ref(d.providerEventId,255)&&ref(d.checkoutSessionId,128)&&typeof d.productKey==='string'&&KEY.test(d.productKey)
    &&['one_off','subscription'].includes(d.billingKind)&&(d.billingKind==='subscription'?ref(d.subscriptionId,255):!Object.hasOwn(d,'subscriptionId'))
    &&Number.isSafeInteger(d.amountMinor)&&d.amountMinor>0&&typeof d.currency==='string'&&/^[a-z]{3}$/.test(d.currency);
  if(value.type==='sales.appointment.booked')return exact(d,['appointmentId','startsAt','bookingSource','meetingKind'])&&ref(d.appointmentId,128)
    &&instant(d.startsAt)&&Date.parse(d.startsAt)>=1000&&['self_serve_calendar','team','partner_referral'].includes(d.bookingSource)
    &&['discovery','strategy','partner'].includes(d.meetingKind);
  return false;
}

async function receipt(response){
  if(response.status!==200||response.redirected||!(response.headers.get('content-type')??'').toLowerCase().startsWith('application/json'))return null;
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_RESPONSE))return null;
  if(!response.body)return null;
  const reader=response.body.getReader(),parts=[];let length=0;
  try{
    for(;;){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;if(length>MAX_RESPONSE){await reader.cancel();return null;}parts.push(Buffer.from(item.value));}
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
    return exact(value,['ok','duplicate'])&&value.ok===true&&typeof value.duplicate==='boolean'?value:null;
  }catch{return null;}
  finally{reader.releaseLock();}
}

/**
 * installation: server-owned HQ workspace -> installation -> LR workspace/key.
 * loadCanonicalEvent({hqWorkspaceId,eventId}) -> {hqWorkspaceId,source,event}
 *   must load app_private.external_event_shadow_receipts after verified ingress.
 * resolveLeadBinding({...}) -> explicit same-account/product/installation mapping;
 *   its stopScope MUST be all_sales_followup_for_lead. No email matching.
 * A held result MUST hold the owning campaign and MUST NOT acknowledge its stop
 * delivery. The caller owns durable claims/reconciliation; this module never retries.
 */
export function createPropertyPredatorStopRelay({installation,loadCanonicalEvent,resolveLeadBinding,fetchImpl=fetch,nowSeconds=()=>Math.floor(Date.now()/1000)}={}){
  const cfg=configuration(installation);
  if(typeof loadCanonicalEvent!=='function'||typeof resolveLeadBinding!=='function'||typeof fetchImpl!=='function'||typeof nowSeconds!=='function')throw Error('Invalid stop relay configuration');
  return async function relay({hqWorkspaceId,eventId}={}){
    if(hqWorkspaceId!==cfg.hqWorkspaceId||!uuid(eventId))return hold(eventId??null,'source_binding_required');
    let loaded;
    try{loaded=await loadCanonicalEvent(Object.freeze({hqWorkspaceId,eventId}));}catch{return hold(eventId,'source_unavailable');}
    if(!exact(loaded,['hqWorkspaceId','source','event'])||loaded.hqWorkspaceId!==hqWorkspaceId||loaded.source!=='property_predator'
      ||!record(loaded.event)||loaded.event.id!==eventId)return hold(eventId,'verified_source_required');
    if(!['commerce.purchase.completed','sales.appointment.booked'].includes(loaded.event.type))return hold(eventId,'unsupported_event');
    if(!canonicalEvent(loaded.event))return hold(eventId,'verified_source_required');
    // Freeze validated source intent before the asynchronous identity lookup;
    // a loader cache or mapping callback cannot mutate its eventual stop body.
    const event=structuredClone(loaded.event);
    const productKey=event.type==='commerce.purchase.completed'?event.data.productKey:null;
    if(productKey!==null&&!cfg.purchaseProductKeys.includes(productKey))return hold(eventId,'product_not_mapped');
    const query=Object.freeze({hqWorkspaceId,installationId:cfg.installationId,leadRelayWorkspaceId:cfg.leadRelayWorkspaceId,
      source:'property_predator',sourceSubjectId:event.subject.id,eventType:event.type,productKey});
    let binding;
    try{binding=await resolveLeadBinding(query);}catch{return hold(eventId,'lead_mapping_unavailable');}
    if(!exact(binding,[...Object.keys(query),'leadId','stopScope'])||Object.keys(query).some(k=>binding[k]!==query[k])
      ||!uuid(binding.leadId)||binding.stopScope!=='all_sales_followup_for_lead')return hold(eventId,'lead_mapping_required');
    const hookId='hq-stop-v1-'+createHash('sha256').update(JSON.stringify([hqWorkspaceId,cfg.installationId,event.id])).digest('hex');
    const payload={event_id:hookId,type:event.type==='commerce.purchase.completed'?'purchase.confirmed':'meeting.booked',lead_id:binding.leadId};
    if(event.type==='commerce.purchase.completed')payload.conversion_ref=`stripe:${event.data.checkoutSessionId}:${event.data.productKey}`;
    else{payload.starts_at=Math.floor(Date.parse(event.data.startsAt)/1000);payload.booking_ref=event.data.appointmentId;}
    const raw=JSON.stringify(payload),timestamp=nowSeconds();
    if(!Number.isSafeInteger(timestamp)||timestamp<0)return hold(eventId,'clock_unavailable');
    const signature=createHmac('sha256',cfg.hookSecret).update(String(timestamp)+'.'+raw).digest('hex');
    const controller=new AbortController();let timer;
    const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(hold(eventId,'stop_outcome_unknown'));},cfg.timeoutMs);});
    const deliver=async()=>{try{
      const response=await fetchImpl(`${cfg.origin}/hooks/${cfg.leadRelayWorkspaceId}/events`,{method:'POST',redirect:'error',signal:controller.signal,
        headers:{'Content-Type':'application/json','X-LeadRelay-Timestamp':String(timestamp),'X-LeadRelay-Signature':signature},body:raw});
      if(response.status===409){await response.body?.cancel();return hold(eventId,'event_conflict');}
      const accepted=await receipt(response);
      if(!accepted)return hold(eventId,'stop_receipt_unconfirmed');
      return Object.freeze({disposition:'delivered',eventId,hookEventId:hookId,duplicate:accepted.duplicate});
    }catch{return hold(eventId,'stop_outcome_unknown');}};
    try{return await Promise.race([deliver(),deadline]);}
    finally{clearTimeout(timer);}
  };
}
