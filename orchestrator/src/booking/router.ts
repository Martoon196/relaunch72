import type {IncomingMessage,ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import type {PortalCrmRequestIdentity} from '../portal/crm-service.js';
import {InvestorError} from '../portal/investor-service.js';
import {siteFormToken,validSiteFormToken} from '../portal/investor-site.js';
import {addDays,dateInTimeZone,periodBounds,validDateOnly} from '../portal/calendar-dates.js';
import {BookingError,checkedTimeZone,uuid,type CalendarSchedule,type BookingPerson} from './contracts.js';
import {BOOKING_ROUTE,BookingService} from './service.js';
import {ownerCalendar,publicReceipt,publicShell,publicSlots} from './view.js';
import {bookingIcs} from './ics.js';
export function localInstant(value:string,zone:string):string {
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)||!validDateOnly(value.slice(0,10)))throw new BookingError('invalid','Choose a valid date and time.');
 checkedTimeZone(zone);const wall=Date.parse(value+':00Z');if(!Number.isFinite(wall))throw new BookingError('invalid','Choose a real time.');
 const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const matches:string[]=[];
 // Time-zone offsets are minute-granular for the supported future booking horizon.
 for(let minute=-14*60;minute<=14*60;minute++) {
  const stamp=wall+minute*60000,parts=formatter.formatToParts(new Date(stamp)),p=(key:string)=>parts.find(p=>p.type===key)?.value;
  if(`${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}`===value)matches.push(new Date(stamp).toISOString());
 }
 if(matches.length!==1)throw new BookingError('invalid',matches.length?'That time occurs twice when the clocks change. Choose a different time.':'That local time does not exist. Choose a different time.');return matches[0]!;
}
const minutes=(value:string):number=>{if(!/^\d{2}:\d{2}$/.test(value))throw new BookingError('invalid','Check working hours.');const [h,m]=value.split(':').map(Number);if(h!>23||m!>59)throw new BookingError('invalid','Check working hours.');return h!*60+m!;};
export function scheduleForm(f:Record<string,string>):CalendarSchedule {
 const windows:CalendarSchedule['windows']=[];
 for(let day=0;day<7;day++)for(let i=0;i<4;i++){const start=f[`start_${day}_${i}`]??'',end=f[`end_${day}_${i}`]??'';if(start||end)windows.push({day,start:minutes(start),end:minutes(end)});}
 const overrides=(f.overrides??'').split(/\r?\n/).filter(s=>s.trim()).map(line=>{
  const match=/^(\d{4}-\d{2}-\d{2})\s+(closed|\d{2}:\d{2}-\d{2}:\d{2}(?:,\d{2}:\d{2}-\d{2}:\d{2}){0,3})$/.exec(line.trim());
  if(!match)throw new BookingError('invalid','Check date exceptions. Use YYYY-MM-DD closed or HH:MM-HH:MM.');
  return {date:match[1]!,windows:match[2]==='closed'?[]:match[2]!.split(',').map(w=>{const [s,e]=w.split('-');return {start:minutes(s!),end:minutes(e!)};})};
 });return {timeZone:f.timeZone??'',windows,overrides};
}
export const bookingFailure=(error:unknown):{status:number;message:string}=>{
 if(error instanceof InvestorError)return {status:error.status,message:error.message};
 if(error instanceof BookingError)return {status:error.code==='forbidden'?403:error.code==='invalid'?400:error.code==='conflict'?409:503,message:error.message};
 const code=(error as {code?:string})?.code;
 if(['23505','40001','23P01'].includes(code??''))return {status:409,message:'The calendar changed or this time was just booked. Refresh and choose again.'};
 if(code==='42501')return {status:403,message:'Connect your calendar or reopen your workspace before continuing.'};
 if(code==='22023')return {status:400,message:'Check the meeting details and choose an available time.'};
 return {status:503,message:'Calendar is temporarily unavailable. Please try again later.'};
};
export async function handleOwnerBooking(input:{service:BookingService;identity:PortalCrmRequestIdentity;url:URL;method:string;csrf:string;origin:string;readForm:()=>Promise<Record<string,string>>;verify:(form:Record<string,string>)=>boolean;render:(body:string)=>void;redirect:(path:string)=>void;download?:(ics:string)=>void}):Promise<void> {
 const {service,identity,url}=input,action=url.pathname.slice(BOOKING_ROUTE.length+1);
 const requested=url.searchParams.get('date'),date=requested===null?dateInTimeZone(new Date(),'Europe/London')!:validDateOnly(requested);
 if(!date)throw new BookingError('invalid','Choose a valid calendar date.');
 const bounds=periodBounds({date,mode:url.searchParams.get('mode')==='month'?'month':'week'});
 const snapshot=()=>service.snapshot(identity,addDays(bounds.gridStart,-1).toISOString(),addDays(bounds.gridEnd,2).toISOString());
 if(input.method==='GET'&&!action){
  if(url.searchParams.has('download')&&input.download){input.download(bookingIcs(await service.ownerReceipt(identity,url.searchParams.get('slug')??'',url.searchParams.get('download')??'')));return;}
  input.render(ownerCalendar(await snapshot(),input.csrf,input.origin,url.searchParams));return;
 }
 if(input.method!=='POST')throw new BookingError('invalid','Use the calendar controls.');
 const f=await input.readForm();if(!input.verify(f))throw new BookingError('forbidden','Refresh this page before saving.');
 if(action==='setup')await service.setup(identity);
 else if(action==='connect'){await service.setup(identity);input.redirect(await service.connect(identity,f.provider??''));return;}
 else if(action==='hours')await service.saveSchedule(identity,f.version??'',scheduleForm(f));
 else {
  const s=await snapshot();if(!s.calendar)throw new BookingError('invalid','Create your calendar first.');
  const selected=s.types.find(t=>t.id===f.id);
  if(action==='type') {
   const questions=Array.from({length:8},(_,i)=>({id:f['qid_'+i]??'',label:f['qlabel_'+i]??'',kind:f['qkind_'+i] as 'text'|'textarea',required:f['qrequired_'+i]==='yes'})).filter(q=>q.label.trim());
   await service.saveType(identity,{id:uuid(f.id??''),slug:uuid(f.slug??''),version:Number(f.version),published:f.published==='yes',title:f.title??'',description:f.description??'',location:f.location??'',timeZone:s.calendar.schedule.timeZone,questions,
    durationMinutes:Number(f.durationMinutes),intervalMinutes:Number(f.intervalMinutes),bufferBeforeMinutes:Number(f.bufferBeforeMinutes),bufferAfterMinutes:Number(f.bufferAfterMinutes),noticeMinutes:Number(f.noticeMinutes),horizonDays:Number(f.horizonDays)},false);
  }else if(action==='duplicate'||action==='archive') {
   if(!selected)throw new BookingError('invalid','Choose a meeting type.');
   if(action==='duplicate'){const {archived,...copy}=selected;await service.saveType(identity,{...copy,id:randomUUID(),slug:randomUUID(),version:0,published:false,title:(copy.title+' copy').slice(0,100)},false);}
   else {const {archived,...copy}=selected;if(String(copy.version)!==f.version)throw new BookingError('conflict','Meeting type changed. Refresh first.');await service.saveType(identity,{...copy,published:false},true);}
  }else if(action==='meeting') {
   if(!selected||selected.archived)throw new BookingError('invalid','Choose an available meeting type.');
   await service.local(identity,selected,localInstant(f.localStart??'',s.calendar.schedule.timeZone),{name:f.name??'',email:f.email??'',answers:Object.fromEntries(selected.questions.map(q=>[q.id,f['answer_'+q.id]??'']))},f.command??'',Number(f.calendarVersion),f.invite==='yes');
  }else if(action==='change') {
   if(f.action!=='cancel'&&f.action!=='move')throw new BookingError('invalid','Choose cancel or reschedule.');
   await service.change({identity,slug:f.slug??'',id:f.id??'',version:f.version??'',action:f.action,...(f.action==='move'?{start:localInstant(f.localStart??'',s.calendar.schedule.timeZone)}:{})});
  }else throw new BookingError('invalid','Calendar action unavailable.');
 }
 input.redirect(BOOKING_ROUTE+'?saved=1'+(['type','duplicate','archive'].includes(action)?'&view=types':action==='hours'?'&view=hours':''));
}
export async function handlePublicBooking(req:IncomingMessage,res:ServerResponse,service:BookingService,secret:string):Promise<void> {
 const url=new URL(req.url??'/','http://localhost'),match=/^\/book\/([0-9a-f-]{36})(?:\/(receipt|change))?$/.exec(url.pathname);
 const send=(status:number,body:string)=>{res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"});res.end(body);};
 const redirect=(path:string)=>{res.writeHead(303,{location:path,'cache-control':'no-store','referrer-policy':'no-referrer'});res.end();};
 if(!match){send(404,publicShell('Meeting unavailable','<h1>Meeting unavailable</h1>'));return;}
 try {
  const slug=uuid(match[1]!),action=match[2],binding='booking:'+slug;
  if(req.method==='GET') {
   if(action==='receipt') {
    const manage=url.searchParams.get('manage')??'',id=url.searchParams.get('id')??'',r=await service.receipt(slug,id,manage);
    if(url.searchParams.get('download')==='ics'&&['confirmed','cancelled'].includes(r.state)){
     res.writeHead(200,{'content-type':'text/calendar; charset=utf-8','content-disposition':'attachment; filename="meeting.ics"','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});res.end(bookingIcs(r));return;
    }
    send(200,publicReceipt(r,slug,manage,siteFormToken(secret,binding+':'+id+':'+manage)));return;
   }
   if(action)throw new BookingError('invalid','Open your booking receipt to make changes.');
   const date=url.searchParams.get('date')??dateInTimeZone(new Date(),'Europe/London')!,{page,slots}=await service.publicPage(slug,date);
   send(200,publicSlots(page,date,slots,siteFormToken(secret,binding),url.searchParams.get('start')));return;
  }
  if(req.method!=='POST'){send(405,publicShell('Method unavailable','<h1>Use the booking form.</h1>'));return;}
  if(!String(req.headers['content-type']??'').startsWith('application/x-www-form-urlencoded'))throw new BookingError('invalid','Use the booking form.');
  let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>22000)throw new BookingError('invalid','Booking form is too long.');chunks.push(Buffer.from(chunk));}
  const fields=new URLSearchParams(Buffer.concat(chunks).toString('utf8')),f:Record<string,string>={};
  for(const [k,v] of fields){if(Object.hasOwn(f,k))throw new BookingError('invalid','Duplicate booking fields. Refresh the form.');f[k]=v;}
  if(action==='change') {
   if(!validSiteFormToken(secret,binding+':'+f.id+':'+f.manage,f.token??''))throw new BookingError('forbidden','Reopen your private booking page.');
   if(f.action!=='cancel'&&f.action!=='move')throw new BookingError('invalid','Choose cancel or reschedule.');
   const r=await service.receipt(slug,f.id??'',f.manage??'');
   await service.change({slug,id:f.id??'',manageToken:f.manage??'',version:f.version??'',action:f.action,...(f.action==='move'?{start:localInstant(f.localStart??'',r.type.timeZone)}:{})});
   redirect(`/book/${slug}/receipt?id=${r.id}&manage=${encodeURIComponent(f.manage!)}`);return;
  }
  if(action||f.website||f.contactRequest!=='yes'||!validSiteFormToken(secret,binding,f.token??''))throw new BookingError('invalid','Refresh and complete the booking form.');
  const person:BookingPerson={name:f.name??'',email:f.email??'',answers:Object.fromEntries(Object.entries(f).filter(([k])=>k.startsWith('answer_')).map(([k,v])=>[k.slice(7),v]))};
  const held=await service.reserve(slug,f.start??'',person,f.command??'',f.manage??'');
  redirect(`/book/${slug}/receipt?id=${held.id}&manage=${encodeURIComponent(f.manage!)}`);
 } catch(error){const failure=bookingFailure(error);send(failure.status,publicShell('Booking needs attention',`<h1>Booking needs attention</h1><p>${failure.message}</p><p>Please use your browser’s Back button to return.</p>`));}
}
