import type {BookingReceipt} from './service.js';
const escape=(value:string)=>value.replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
const stamp=(value:string)=>new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
/** Fold by UTF-8 octets, preserving code points and preventing property injection. */
function fold(line:string):string {
 let output='',part='';
 for(const char of line){if(Buffer.byteLength(part+char)>73){output+=part+'\r\n ';part='';}part+=char;}
 return output+part;
}
export function bookingIcs(receipt:BookingReceipt,now=new Date()):string {
 return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Growth HQ//Meetings//EN','CALSCALE:GREGORIAN','BEGIN:VEVENT',
 `UID:${receipt.id}@growth-hq`,`DTSTAMP:${stamp(now.toISOString())}`,`DTSTART:${stamp(receipt.start)}`,`DTEND:${stamp(receipt.end)}`,
 `SUMMARY:${escape(receipt.type.title)}`,`DESCRIPTION:${escape(receipt.type.description)}`,`LOCATION:${escape(receipt.type.location)}`,
 `STATUS:${receipt.state==='cancelled'?'CANCELLED':'CONFIRMED'}`,'END:VEVENT','END:VCALENDAR'].map(fold).join('\r\n')+'\r\n';
}
