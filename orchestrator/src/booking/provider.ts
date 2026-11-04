import type { OAuthMailbox } from '../investor-mail/contracts.js';
import { hasCalendarAccess } from '../investor-mail/oauth.js';
import { BookingError,instant,plain,uuid,type CalendarEvent,type CalendarTransport,type TimeRange } from './contracts.js';
const GOOGLE='https://www.googleapis.com/calendar/v3';
const GRAPH='https://graph.microsoft.com/v1.0';
type Json=Record<string,unknown>;
const object=(v:unknown):Json=>{
  if(!v||typeof v!=='object'||Array.isArray(v))throw new BookingError('unavailable','Calendar returned an invalid response.');return v as Json;
};
async function json(response:Response):Promise<Json> {
  if(!response.ok)throw new BookingError('unavailable','Calendar could not be checked. Reconnect it from Calendar setup.');
  const reader=response.body?.getReader();if(!reader)throw new BookingError('unavailable','Calendar returned an empty response.');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2_000_000)throw new Error();chunks.push(part.value);}
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }catch{await reader.cancel().catch(()=>{});throw new BookingError('unavailable','Calendar response was incomplete.');}
}
function range(start:string,end:string):TimeRange {
  if(instant(end)<=instant(start))throw new BookingError('unavailable','Calendar returned an invalid time range.');return {start,end};
}
function graphInstant(input:unknown):string {
  const v=object(input);
  if(v.timeZone!=='UTC'||typeof v.dateTime!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?$/.test(v.dateTime))throw new BookingError('unavailable','Calendar returned an unsupported time zone.');
  const d=new Date(v.dateTime+'Z');if(!Number.isFinite(d.getTime()))throw new BookingError('unavailable','Calendar returned an invalid time.');return d.toISOString();
}
/** Existing OAuth credentials/vault are reused; this adapter never obtains or widens grants. */
export class OAuthCalendarTransport implements CalendarTransport {
  constructor(private readonly c:OAuthMailbox,private readonly request:typeof fetch=fetch) {
    if(!hasCalendarAccess(c)||!c.accessToken||c.expiresAt<=Date.now()+30_000)throw new BookingError('not_connected','Connect your Google or Microsoft calendar first.');
  }
  private async call(url:string,method='GET',body?:unknown):Promise<Response> {
    return this.request(url,{method,redirect:'error',signal:AbortSignal.timeout(20_000),headers:{Authorization:`Bearer ${this.c.accessToken}`,
      ...(this.c.provider==='microsoft'?{Prefer:'outlook.timezone="UTC", IdType="ImmutableId"'}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  }
  async busy(start:string,end:string):Promise<TimeRange[]> {
    range(start,end);if(instant(end)-instant(start)>10*86_400_000)throw new BookingError('invalid','Check at most one week at a time.');
    try {
      if(this.c.provider==='google') {
        const result=await json(await this.call(GOOGLE+'/freeBusy','POST',{timeMin:start,timeMax:end,items:[{id:'primary'}]}));
        const calendar=object(object(result.calendars).primary);
        if(calendar.errors!==undefined&&(!Array.isArray(calendar.errors)||calendar.errors.length))throw new Error();
        if(!Array.isArray(calendar.busy)||calendar.busy.length>10_000)throw new Error();
        return calendar.busy.map(v=>{const r=object(v);return range(String(r.start),String(r.end));});
      }
      const query=new URLSearchParams({startDateTime:start,endDateTime:end,'$select':'start,end,showAs,isCancelled','$top':'1000'});
      let next:string|undefined=GRAPH+'/me/calendarView?'+query;const result:TimeRange[]=[];let pages=0;
      while(next) {
        const u=new URL(next);if(u.origin!=='https://graph.microsoft.com'||u.pathname!=='/v1.0/me/calendarView'||u.username||u.password||++pages>20)throw new Error();
        const page=await json(await this.call(u.toString()));if(!Array.isArray(page.value))throw new Error();
        for(const raw of page.value) {
          const event=object(raw);if(event.isCancelled===true||event.showAs==='free')continue;
          if(!['busy','tentative','oof','workingElsewhere','unknown'].includes(String(event.showAs)))throw new Error();
          result.push(range(graphInstant(event.start),graphInstant(event.end)));if(result.length>10_000)throw new Error();
        }
        const link=page['@odata.nextLink'];if(link!==undefined&&typeof link!=='string')throw new Error();next=link as string|undefined;
      }
      return result;
    }catch {throw new BookingError('unavailable','Availability could not be checked. Please try again later.');}
  }
  private body(event:CalendarEvent):Json {
    uuid(event.bookingId);range(event.start,event.end);plain(event.title,'the meeting title',100);plain(event.description,'the description',16_000,true);
    if(this.c.provider==='google')return {summary:event.title,description:event.description,location:event.location,
      start:{dateTime:event.start,timeZone:'UTC'},end:{dateTime:event.end,timeZone:'UTC'},...(event.attendee?{attendees:[{email:event.attendee.email,displayName:event.attendee.name}]}:{})};
    return {subject:event.title,body:{contentType:'text',content:event.description},location:{displayName:event.location},
      start:{dateTime:event.start.replace(/Z$/,''),timeZone:'UTC'},end:{dateTime:event.end.replace(/Z$/,''),timeZone:'UTC'},
      ...(event.attendee?{attendees:[{emailAddress:{address:event.attendee.email,name:event.attendee.name},type:'required'}]}:{})};
  }
  async create(event:CalendarEvent):Promise<{providerId:string}> {
    const google=this.c.provider==='google',id='ghq'+uuid(event.bookingId).replaceAll('-',''),body=this.body(event);
    try {
      const response=await this.call(google?GOOGLE+'/calendars/primary/events?sendUpdates=all':GRAPH+'/me/events','POST',
        google?{...body,id}:{...body,transactionId:event.bookingId});
      const accepted=await json(response);
      if(typeof accepted.id!=='string'||!accepted.id||accepted.id.length>2000||(google&&accepted.id!==id))throw new Error();
      return {providerId:accepted.id};
    }catch{throw new BookingError('provider_unknown','Calendar confirmation is pending. Do not book again; the host can check its status.');}
  }
  private eventUrl(providerId:string):string {
    plain(providerId,'the calendar event',2000);return this.c.provider==='google'?GOOGLE+'/calendars/primary/events/'+encodeURIComponent(providerId)+'?sendUpdates=all':GRAPH+'/me/events/'+encodeURIComponent(providerId);
  }
  async cancel(providerId:string):Promise<void> {
    try{const response=await this.call(this.eventUrl(providerId),'DELETE');if(!response.ok&&response.status!==404&&response.status!==410)throw new Error();}
    catch{throw new BookingError('provider_unknown','Calendar cancellation is awaiting confirmation.');}
  }
  async move(providerId:string,event:CalendarEvent):Promise<void> {
    try{const response=await this.call(this.eventUrl(providerId),'PATCH',this.body(event));if(!response.ok)throw new Error();}
    catch{throw new BookingError('provider_unknown','Calendar rescheduling is awaiting confirmation.');}
  }
  toJSON(){return {provider:this.c.provider,credentials:'[REDACTED]'};}
}
