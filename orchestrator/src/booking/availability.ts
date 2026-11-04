import { DAY_MS,dateInTimeZone,utcDate,validDateOnly } from '../portal/calendar-dates.js';
import { BookingError,instant,validateMeetingType,validateSchedule,type CalendarSchedule,type MeetingType,type TimeRange } from './contracts.js';
const MINUTE=60_000;
export const overlaps=(a:TimeRange,b:TimeRange):boolean=>instant(a.start)<instant(b.end)&&instant(b.start)<instant(a.end);
/** Scan real instants, not guessed local offsets. This naturally skips a DST gap
 * and gives the two distinct instants in a repeated hour their own UTC keys. */
export function availableSlots(input:{type:MeetingType;schedule:CalendarSchedule;date:string;days?:number;busy:readonly TimeRange[];now?:number}):TimeRange[] {
  const type=validateMeetingType(input.type),schedule=validateSchedule(input.schedule),days=input.days??1,now=input.now??Date.now();
  if(!validDateOnly(input.date)||!Number.isInteger(days)||days<1||days>7||!Number.isFinite(now)||input.busy.length>10_000)throw new BookingError('invalid','Choose a date within one week.');
  if(type.timeZone!==schedule.timeZone)throw new BookingError('invalid','The meeting time zone must match its working hours.');
  const busy=input.busy.map(r=>{const start=instant(r.start),end=instant(r.end);if(end<=start)throw new BookingError('unavailable','Calendar availability could not be checked.');return {start,end};});
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timeZone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const start=utcDate(input.date).getTime(),limitDate=new Date(start+days*DAY_MS).toISOString().slice(0,10),result:TimeRange[]=[];
  const earliest=now+type.noticeMinutes*MINUTE,latest=now+type.horizonDays*DAY_MS;
  for(let stamp=start-DAY_MS;stamp<start+(days+1)*DAY_MS;stamp+=MINUTE) {
    if(stamp<earliest||stamp>latest)continue;
    const parts=Object.fromEntries(formatter.formatToParts(stamp).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
    const localDate=`${parts.year}-${parts.month}-${parts.day}`;
    if(localDate<input.date||localDate>=limitDate)continue;
    const minute=Number(parts.hour)*60+Number(parts.minute),weekday=utcDate(localDate).getUTCDay();
    const override=schedule.overrides.find(o=>o.date===localDate),windows=override?override.windows:schedule.windows.filter(w=>w.day===weekday);
    const duration=type.durationMinutes*MINUTE,end=stamp+duration;
    // Buffers must fit inside the host's stated working window, including across DST.
    const opening=windows.find(w=>minute-type.bufferBeforeMinutes>=w.start&&minute+type.durationMinutes+type.bufferAfterMinutes<=w.end&&(minute-w.start)%type.intervalMinutes===0);
    if(!opening)continue;
    const tail=new Date(end-1);
    if(dateInTimeZone(tail,schedule.timeZone)!==localDate)continue;
    const tailParts=Object.fromEntries(formatter.formatToParts(tail).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
    if(Number(tailParts.hour)*60+Number(tailParts.minute)!==minute+type.durationMinutes-1)continue;
    const blockStart=stamp-type.bufferBeforeMinutes*MINUTE,blockEnd=end+type.bufferAfterMinutes*MINUTE;
    if(busy.some(b=>blockStart<b.end&&b.start<blockEnd))continue;
    result.push({start:new Date(stamp).toISOString(),end:new Date(end).toISOString()});
  }
  return result;
}
export function bookingRange(type:MeetingType,start:string):TimeRange {
  const stamp=instant(start);return {start:new Date(stamp-type.bufferBeforeMinutes*MINUTE).toISOString(),end:new Date(stamp+(type.durationMinutes+type.bufferAfterMinutes)*MINUTE).toISOString()};
}
