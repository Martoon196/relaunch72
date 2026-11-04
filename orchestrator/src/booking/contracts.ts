import { mailboxAddress } from '../investor-mail/contracts.js';
import { safeTimeZone,validDateOnly } from '../portal/calendar-dates.js';
export type CalendarProvider='google'|'microsoft';
export class BookingError extends Error {
  constructor(readonly code:'invalid'|'unavailable'|'conflict'|'not_connected'|'provider_unknown'|'forbidden',message:string) {super(message);}
}
export interface TimeRange {start:string;end:string}
export interface WorkingWindow {day:number;start:number;end:number}
export interface DateOverride {date:string;windows:{start:number;end:number}[]}
export interface BookingQuestion {id:string;label:string;kind:'text'|'textarea';required:boolean}
export interface MeetingType {
  id:string;slug:string;title:string;description:string;durationMinutes:number;intervalMinutes:number;
  bufferBeforeMinutes:number;bufferAfterMinutes:number;noticeMinutes:number;horizonDays:number;
  timeZone:string;location:string;questions:BookingQuestion[];published:boolean;version:number;
}
export interface CalendarSchedule {timeZone:string;windows:WorkingWindow[];overrides:DateOverride[]}
export interface BookingPerson {name:string;email:string;answers:Record<string,string>}
export interface CalendarEvent extends TimeRange {
  bookingId:string;title:string;description:string;location:string;attendee?:{name:string;email:string};
}
export interface CalendarTransport {
  busy(start:string,end:string):Promise<TimeRange[]>;
  create(event:CalendarEvent):Promise<{providerId:string}>;
  cancel(providerId:string):Promise<void>;
  move(providerId:string,event:CalendarEvent):Promise<void>;
}
export const uuid=(s:string):string=>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s))throw new BookingError('invalid','Refresh this page and try again.');return s.toLowerCase();
};
export function plain(value:unknown,label:string,max:number,optional=false):string {
  if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)||(!optional&&!value.trim()))throw new BookingError('invalid',`Check ${label}.`);
  return value.trim();
}
const number=(v:unknown,label:string,min:number,max:number):number=>{
  if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw new BookingError('invalid',`Check ${label}.`);return v;
};
export function checkedTimeZone(value:unknown):string {
  const zone=plain(value,'the time zone',100);if(safeTimeZone(zone)!==zone)throw new BookingError('invalid','Choose a valid time zone.');return zone;
}
export function validateMeetingType(input:MeetingType):MeetingType {
  uuid(input.id);uuid(input.slug);
  const title=plain(input.title,'the meeting title',100),description=plain(input.description,'the description',2000,true);
  if(/[\r\n]/.test(title))throw new BookingError('invalid','Use one line for the meeting title.');
  number(input.durationMinutes,'the duration',5,480);number(input.intervalMinutes,'the slot interval',5,120);
  number(input.bufferBeforeMinutes,'the buffer',0,240);number(input.bufferAfterMinutes,'the buffer',0,240);
  number(input.noticeMinutes,'the notice period',0,43_200);number(input.horizonDays,'the booking horizon',1,365);
  number(input.version,'the meeting version',0,Number.MAX_SAFE_INTEGER);
  if(!Array.isArray(input.questions)||input.questions.length>8||typeof input.published!=='boolean')throw new BookingError('invalid','Check the meeting settings.');
  const ids=new Set<string>();
  const questions=input.questions.map(q=>{
    if(!q||!/^[a-z][a-z0-9_]{0,39}$/.test(q.id)||ids.has(q.id)||!['text','textarea'].includes(q.kind)||typeof q.required!=='boolean')throw new BookingError('invalid','Check the booking questions.');
    ids.add(q.id);return {...q,label:plain(q.label,'the question label',200)};
  });
  const location=plain(input.location,'the meeting location',500,true);
  if(/^[a-z]+:/i.test(location)) {let url:URL;try{url=new URL(location);}catch{throw new BookingError('invalid','Use a valid meeting link.');}
    if(url.protocol!=='https:'||url.username||url.password)throw new BookingError('invalid','Meeting links must use HTTPS.');}
  return {...input,title,description,location,timeZone:checkedTimeZone(input.timeZone),questions};
}
function window(input:{start:number;end:number}):{start:number;end:number} {
  const start=number(input?.start,'the opening time',0,1439),end=number(input?.end,'the closing time',1,1440);
  if(end<=start)throw new BookingError('invalid','Closing time must be after opening time.');return {start,end};
}
function sorted(windows:{start:number;end:number}[]) {
  const result=windows.map(window).sort((a,b)=>a.start-b.start);
  if(result.some((w,i)=>i>0&&w.start<result[i-1]!.end))throw new BookingError('invalid','Working hours overlap.');return result;
}
export function validateSchedule(input:CalendarSchedule):CalendarSchedule {
  const timeZone=checkedTimeZone(input.timeZone);
  if(!Array.isArray(input.windows)||input.windows.length>28||!Array.isArray(input.overrides)||input.overrides.length>366)throw new BookingError('invalid','Check working hours and date overrides.');
  const windows:WorkingWindow[]=[];
  for(const w of input.windows)number(w.day,'the weekday',0,6);
  for(let day=0;day<7;day++)windows.push(...sorted(input.windows.filter(w=>w.day===day)).map(w=>({day,...w})));
  const dates=new Set<string>();
  const overrides=input.overrides.map(o=>{
    if(!o||!validDateOnly(o.date)||dates.has(o.date)||!Array.isArray(o.windows)||o.windows.length>4)throw new BookingError('invalid','Check the date overrides.');
    dates.add(o.date);return {date:o.date,windows:sorted(o.windows)};
  });
  return {timeZone,windows,overrides};
}
export function normalisePerson(input:BookingPerson):BookingPerson {
  const name=plain(input.name,'your name',200);let email:string;
  try{email=mailboxAddress(input.email);}catch{throw new BookingError('invalid','Check your email address.');}
  if(!input.answers||typeof input.answers!=='object'||Array.isArray(input.answers))throw new BookingError('invalid','Check the answers.');
  if(Object.keys(input.answers).length>8)throw new BookingError('invalid','Too many booking answers.');
  const answers:Record<string,string>=Object.fromEntries(Object.entries(input.answers).map(([k,v])=>[k,plain(v,'your answer',2000,true)]));
  if(Buffer.byteLength(JSON.stringify(answers))>12_000)throw new BookingError('invalid','Your answers are too long.');
  return {name,email,answers};
}
export function validatePerson(input:BookingPerson,type:MeetingType):BookingPerson {
  const normal=normalisePerson(input),answers:Record<string,string>={};
  if(Object.keys(normal.answers).some(k=>!type.questions.some(q=>q.id===k)))throw new BookingError('invalid','The booking questions changed. Refresh before booking.');
  for(const q of type.questions){const value=plain(normal.answers[q.id]??'',q.label,q.kind==='text'?500:2000,!q.required);if(Object.hasOwn(normal.answers,q.id)||q.required)answers[q.id]=value;}
  return {...normal,answers};
}
export function instant(value:string):number {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))throw new BookingError('invalid','Choose a valid time.');
  const stamp=Date.parse(value),normal=value.includes('.')?value:value.replace('Z','.000Z');
  if(new Date(stamp).toISOString()!==normal)throw new BookingError('invalid','Choose a real calendar date.');return stamp;
}
