import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {PortalCrmRequestIdentity} from '../portal/crm-service.js';
import type {InvestorMailService} from '../portal/investor-mail-service.js';
import type {OAuthMailbox} from '../investor-mail/contracts.js';
import {InvestorMailVault} from '../investor-mail/vault.js';
import {hasCalendarAccess,refreshMailTokens,type MailOAuthConfig} from '../investor-mail/oauth.js';
import {addDays,dateInTimeZone,utcDate,validDateOnly} from '../portal/calendar-dates.js';
import {availableSlots,overlaps,bookingRange} from './availability.js';
import {OAuthCalendarTransport} from './provider.js';
import {BookingError,instant,uuid,normalisePerson,validateMeetingType,validatePerson,validateSchedule,type MeetingType,type CalendarSchedule,type CalendarTransport,type CalendarEvent,type BookingPerson,type TimeRange} from './contracts.js';
const hash=(s:string)=>createHash('sha256').update(s).digest();
const canonical=(s:string)=>new Date(s).toISOString();
export const BOOKING_ROUTE='/portal/calendar';
export interface Appointment {id:string;meetingTypeId:string;start:string;end:string;state:string;person:BookingPerson;type:MeetingType;contactId:string|null;version:number}
export interface BookingSnapshot {workspaceId:string;calendar:{version:number;schedule:CalendarSchedule;connected:boolean;hostId:string}|null;types:(MeetingType&{archived:boolean})[];meetings:Appointment[]}
export interface PublicBookingPage {calendarVersion:number;schedule:CalendarSchedule;type:MeetingType;brandName:string;accentColor:string;connected:boolean;busy:TimeRange[]}
export interface BookingReceipt {id:string;start:string;end:string;state:string;person:BookingPerson;type:MeetingType;version:number;brandName:string}
type Queries=Pick<Pool,'query'>;
const version=(value:string):number=>{if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw new BookingError('invalid','Refresh this page before saving.');return Number(value);};
export function founderSchedule():CalendarSchedule {
 return {timeZone:'Europe/London',windows:[{day:1,start:600,end:960},{day:2,start:600,end:1260},{day:3,start:600,end:960},{day:4,start:600,end:1260},{day:5,start:600,end:960}],overrides:[]};
}
export function defaultMeetingType():MeetingType {
 return {id:randomUUID(),slug:randomUUID(),title:'Income Path Call',description:'A 20-minute conversation about your first property income pathway.',durationMinutes:20,intervalMinutes:20,
 bufferBeforeMinutes:0,bufferAfterMinutes:0,noticeMinutes:60,horizonDays:60,timeZone:'Europe/London',location:'',questions:[{id:'goal',label:'What would you like help with?',kind:'textarea',required:false}],published:false,version:0};
}
export class BookingService {
 constructor(private readonly read:Queries,private readonly command:Queries,private readonly vault:InvestorMailVault|undefined,private readonly oauth:MailOAuthConfig|undefined,private readonly mail:InvestorMailService,
  private readonly mhp:boolean,private readonly transport:(c:ConstructorParameters<typeof OAuthCalendarTransport>[0])=>CalendarTransport=c=>new OAuthCalendarTransport(c)){}
 async snapshot(identity:PortalCrmRequestIdentity,from:string,until:string):Promise<BookingSnapshot> {
  const r=await this.read.query<{value:BookingSnapshot}>('SELECT app_private.booking_snapshot($1,$2,$3) AS value',[hash(identity.sessionToken),from,until]);
  if(!r.rows[0]?.value)throw new BookingError('unavailable','Calendar could not load.');return r.rows[0].value;
 }
 async setup(identity:PortalCrmRequestIdentity):Promise<void> {
  const now=new Date(),snapshot=await this.snapshot(identity,now.toISOString(),new Date(now.getTime()+86400_000).toISOString());
  if(!snapshot.calendar)await this.saveSchedule(identity,'0',founderSchedule());
  if(!snapshot.types.length){const seed=hash('booking-default:'+snapshot.workspaceId).toString('hex'),id=`${seed.slice(0,8)}-${seed.slice(8,12)}-4${seed.slice(13,16)}-a${seed.slice(17,20)}-${seed.slice(20,32)}`;await this.saveType(identity,{...defaultMeetingType(),id},false);}
 }
 async saveSchedule(identity:PortalCrmRequestIdentity,expected:string,schedule:CalendarSchedule):Promise<void> {
  const valid=validateSchedule(schedule);await this.command.query('SELECT app_private.booking_save_calendar($1,$2,$3)',[hash(identity.sessionToken),version(expected),valid]);
 }
 async saveType(identity:PortalCrmRequestIdentity,type:MeetingType,archive:boolean):Promise<void> {
  const valid=validateMeetingType(type),{id,slug,version:expected,published,...settings}=valid;
  await this.command.query('SELECT app_private.booking_save_type($1,$2,$3,$4,$5,$6,$7)',[hash(identity.sessionToken),id,slug,expected,settings,published,archive]);
 }
 async connect(identity:PortalCrmRequestIdentity,provider:string):Promise<string> {
  const now=new Date(),s=await this.snapshot(identity,now.toISOString(),new Date(now.getTime()+86400000).toISOString());
  if(!s.calendar)throw new BookingError('invalid','Save your working hours first.');return this.mail.beginOAuth(identity,provider,'calendar',s.calendar.version);
 }
 async finishConnection(identity:PortalCrmRequestIdentity,credentials:OAuthMailbox,expected:number):Promise<void> {
  if(!this.vault||!hasCalendarAccess(credentials))throw new BookingError('not_connected','Calendar authorisation is incomplete.');
  const now=new Date(),s=await this.snapshot(identity,now.toISOString(),new Date(now.getTime()+86400000).toISOString());
  await this.command.query('SELECT app_private.booking_connect_calendar($1,$2,$3,$4,$5)',[hash(identity.sessionToken),expected,credentials.provider,credentials.address,this.vault.sealValue(s.workspaceId,credentials,'calendar')]);
 }
 private async connected(slug:string,expectedVersion?:number):Promise<CalendarTransport> {
  if(!this.vault||!this.oauth)throw new BookingError('not_connected','Calendar connection needs platform setup.');
  interface Secret {workspaceId:string;version:number;sealed:string;address:string}
  const load=async()=>{const r=await this.command.query<{value:Secret|null}>('SELECT app_private.booking_calendar_secret($1,$2) AS value',[uuid(slug),this.mhp]);return r.rows[0]?.value;};
  let saved=await load();if(!saved)throw new BookingError('not_connected','Calendar is not connected. Please contact the host.');
  if(expectedVersion!==undefined&&saved.version!==expectedVersion)throw new BookingError('conflict','Calendar settings changed. Refresh before continuing.');
  let credentials=this.vault.openValue(saved.workspaceId,saved.sealed,'calendar') as OAuthMailbox;
  if(!['google','microsoft'].includes(credentials.provider)||credentials.address!==saved.address||!hasCalendarAccess(credentials))throw new BookingError('not_connected','The host needs to reconnect their calendar.');
  if(credentials.expiresAt<Date.now()+90_000) {
   credentials=await refreshMailTokens(this.oauth,credentials);if(!hasCalendarAccess(credentials))throw new BookingError('not_connected','Calendar permission needs renewing.');
   const refreshed=await this.command.query<{changed:boolean}>('SELECT app_private.booking_refresh_calendar($1,$2,$3,$4,$5) AS changed',[uuid(slug),this.mhp,saved.version,hash(saved.sealed),this.vault.sealValue(saved.workspaceId,credentials,'calendar')]);
   if(!refreshed.rows[0]?.changed) {saved=await load();if(!saved)throw new BookingError('not_connected','Calendar connection changed.');credentials=this.vault.openValue(saved.workspaceId,saved.sealed,'calendar') as OAuthMailbox;
    if(!['google','microsoft'].includes(credentials.provider)||credentials.address!==saved.address||!hasCalendarAccess(credentials)||credentials.expiresAt<Date.now()+30_000)throw new BookingError('not_connected','Reconnect the calendar before continuing.');}
  }
  return this.transport(credentials);
 }
 async publicPage(slug:string,date:string):Promise<{page:PublicBookingPage;slots:TimeRange[]}> {
  if(!validDateOnly(date))throw new BookingError('invalid','Choose a valid date.');
  const from=addDays(utcDate(date),-1).toISOString(),until=addDays(utcDate(date),2).toISOString();
  const r=await this.read.query<{value:PublicBookingPage|null}>('SELECT app_private.booking_public_page($1,$2,$3,$4) AS value',[uuid(slug),this.mhp,from,until]);
  const page=r.rows[0]?.value;if(!page)throw new BookingError('unavailable','This meeting is not currently available to book.');
  const provider=await this.connected(slug,page.calendarVersion),external=await provider.busy(from,until);
  const busy=[...page.busy,...external].map(b=>({start:canonical(b.start),end:canonical(b.end)}));
  return {page,slots:availableSlots({type:page.type,schedule:page.schedule,date,busy})};
 }
 async reserve(slug:string,start:string,person:BookingPerson,commandKey:string,manageToken:string):Promise<{id:string;state:string}> {
  instant(start);person=normalisePerson(person);
  if(!/^[A-Za-z0-9_-]{43}$/.test(manageToken))throw new BookingError('invalid','Refresh the booking form.');
  const replay=await this.command.query<{value:{id:string;state:string}|null}>('SELECT app_private.booking_replay($1,$2,$3,$4,$5,$6) AS value',[uuid(slug),this.mhp,uuid(commandKey),start,person,hash(manageToken)]);
  if(replay.rows[0]?.value)return replay.rows[0].value;
  // Resolve the host's actual zone before validating the selected slot.
  const initial=await this.read.query<{value:PublicBookingPage|null}>('SELECT app_private.booking_public_page($1,$2,$3,$4) AS value',[uuid(slug),this.mhp,new Date(instant(start)-86400_000).toISOString(),new Date(instant(start)+86400_000).toISOString()]);
  const details=initial.rows[0]?.value;if(!details)throw new BookingError('unavailable','Meeting is unavailable.');
  const selected=await this.publicPage(slug,dateInTimeZone(start,details.schedule.timeZone)!);
  const slot=selected.slots.find(s=>instant(s.start)===instant(start));if(!slot)throw new BookingError('conflict','That time is no longer available. Choose another.');
  const valid=validatePerson(person,selected.page.type),dispatch=randomBytes(32).toString('base64url');
  const r=await this.command.query<{value:{id:string;state:string;created:boolean}}>('SELECT app_private.booking_hold($1,$2,$3,$4,$5,$6,$7,$8,$9) AS value',
   [uuid(slug),this.mhp,uuid(commandKey),slot.start,valid,hash(manageToken),hash(dispatch),selected.page.type.version,selected.page.calendarVersion]);
  const held=r.rows[0]?.value;if(!held)throw new BookingError('unavailable','Booking could not be confirmed.');if(!held.created)return held;
  return this.complete(slug,held.id,dispatch,selected.page.type,slot,valid,selected.page.calendarVersion);
 }
 private async complete(slug:string,id:string,dispatch:string,type:MeetingType,slot:TimeRange,person:BookingPerson,calendarVersion:number):Promise<{id:string;state:string}> {
  let accepted:{providerId:string};
  try{const adapter=await this.connected(slug,calendarVersion);accepted=await adapter.create(this.event(id,type,slot,person));}
  catch {await this.command.query('SELECT app_private.booking_settle($1,$2,$3,$4)',[id,hash(dispatch),null,false]).catch(()=>{});return {id,state:'unknown'};}
  try{await this.command.query('SELECT app_private.booking_settle($1,$2,$3,$4)',[id,hash(dispatch),accepted.providerId,true]);return {id,state:'confirmed'};}
  catch{return {id,state:'unknown'};}
 }
 private event(id:string,type:MeetingType,slot:TimeRange,person:BookingPerson):CalendarEvent {
  const answers=type.questions.map(q=>`${q.label}\n${person.answers[q.id]??''}`).join('\n\n');
  return {...slot,bookingId:id,title:type.title,location:type.location,description:[type.description,answers].filter(Boolean).join('\n\n'),attendee:{name:person.name,email:person.email}};
 }
 async receipt(slug:string,id:string,manageToken:string):Promise<BookingReceipt> {
  if(!/^[A-Za-z0-9_-]{43}$/.test(manageToken))throw new BookingError('forbidden','Open your private booking link.');
  const r=await this.command.query<{value:BookingReceipt|null}>('SELECT app_private.booking_receipt($1,$2,$3,$4) AS value',[uuid(slug),this.mhp,uuid(id),hash(manageToken)]);
  if(!r.rows[0]?.value)throw new BookingError('forbidden','This booking link is unavailable.');return r.rows[0].value;
 }
 async ownerReceipt(identity:PortalCrmRequestIdentity,slug:string,id:string):Promise<BookingReceipt> {
  const r=await this.command.query<{value:BookingReceipt|null}>('SELECT app_private.booking_appointment_context($1,$2,$3,$4,$5) AS value',[uuid(slug),this.mhp,uuid(id),null,hash(identity.sessionToken)]);
  if(!r.rows[0]?.value||!['local','confirmed','cancelled'].includes(r.rows[0].value.state))throw new BookingError('unavailable','This meeting is awaiting calendar confirmation.');return {...r.rows[0].value,brandName:'Your workspace'};
 }
 async local(identity:PortalCrmRequestIdentity,type:MeetingType,start:string,person:BookingPerson,commandKey:string,calendarVersion:number,invite=false):Promise<{id:string;state:string}> {
  const valid=validatePerson(person,type);instant(start);
  const replay=await this.command.query<{value:{id:string;state:string}|null}>('SELECT app_private.booking_replay($1,$2,$3,$4,$5,$6,$7,$8) AS value',[uuid(type.slug),this.mhp,uuid(commandKey),start,valid,null,hash(identity.sessionToken),invite]);
  if(replay.rows[0]?.value)return replay.rows[0].value;
  const slot={start:canonical(start),end:new Date(instant(start)+type.durationMinutes*60_000).toISOString()},dispatch=randomBytes(32).toString('base64url');
  if(invite) {
   const adapter=await this.connected(type.slug,calendarVersion),block=bookingRange(type,start),busy=await adapter.busy(block.start,block.end);
   if(busy.some(b=>overlaps(block,{start:canonical(b.start),end:canonical(b.end)})))throw new BookingError('conflict','That time is busy on your connected calendar.');
  }
  const r=await this.command.query<{value:{id:string;state:string;created:boolean}}>('SELECT app_private.booking_hold($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS value',[uuid(type.slug),this.mhp,uuid(commandKey),start,valid,null,hash(dispatch),type.version,calendarVersion,hash(identity.sessionToken),invite]);
  const held=r.rows[0]?.value;if(!held)throw new BookingError('unavailable','Meeting was not saved.');
  return invite&&held.created?this.complete(type.slug,held.id,dispatch,type,slot,valid,calendarVersion):held;
 }
 async change(input:{slug:string;id:string;manageToken?:string;identity?:PortalCrmRequestIdentity;action:'cancel'|'move';start?:string;version:string}):Promise<void> {
  if(!input.identity&&!/^[A-Za-z0-9_-]{43}$/.test(input.manageToken??''))throw new BookingError('forbidden','Open your private booking link.');
  if(input.action==='move') {if(!input.start)throw new BookingError('invalid','Choose a new time.');instant(input.start);}
  const preview=await this.command.query<{value:{state:string;start:string;type:MeetingType}|null}>('SELECT app_private.booking_appointment_context($1,$2,$3,$4,$5) AS value',
   [uuid(input.slug),this.mhp,uuid(input.id),input.manageToken?hash(input.manageToken):null,input.identity?hash(input.identity.sessionToken):null]);
  const current=preview.rows[0]?.value;if(!current)throw new BookingError('forbidden','This meeting is unavailable.');
  if(input.action==='cancel'&&current.state==='cancelled')return;
  if(input.action==='move'&&instant(canonical(current.start))===instant(input.start!))return;
  let adapter:CalendarTransport|undefined;
  if(current.state!=='local') {
   adapter=await this.connected(input.slug);
   if(input.action==='move') {const block=bookingRange(current.type,input.start!),busy=await adapter.busy(block.start,block.end);
    if(busy.some(b=>overlaps(block,{start:canonical(b.start),end:canonical(b.end)})))throw new BookingError('conflict','That time is busy. Choose another time.');}
  }
  const dispatch=randomBytes(32).toString('base64url');
  const result=await this.command.query<{value:{local:boolean;providerId:string;person:BookingPerson;type:MeetingType;start:string;end:string}}>(
   'SELECT app_private.booking_change_begin($1,$2,$3,$4,$5,$6,$7,$8,$9) AS value',
   [uuid(input.slug),this.mhp,uuid(input.id),input.manageToken?hash(input.manageToken):null,input.identity?hash(input.identity.sessionToken):null,input.action,input.action==='move'?input.start:null,version(input.version),hash(dispatch)]);
  const change=result.rows[0]?.value;if(!change)throw new BookingError('unavailable','Meeting change was not confirmed.');if(change.local)return;
  try {if(!adapter)throw new Error('Calendar changed');
   if(input.action==='cancel')await adapter.cancel(change.providerId);
   else {const range={start:canonical(change.start),end:canonical(change.end)};
    await adapter.move(change.providerId,this.event(input.id,change.type,range,change.person));}
   await this.command.query('SELECT app_private.booking_change_settle($1,$2,$3)',[input.id,hash(dispatch),true]);
  }catch{throw new BookingError('provider_unknown','This change is awaiting calendar confirmation. Please contact the host rather than trying again.');}
 }
}
