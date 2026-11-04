import test from 'node:test';
import assert from 'node:assert/strict';
import {availableSlots,bookingRange,overlaps} from '../src/booking/availability.js';
import {validatePerson,validateSchedule,validateMeetingType,type MeetingType,type CalendarSchedule} from '../src/booking/contracts.js';
import {periodBounds,dateOnly,dateInTimeZone} from '../src/portal/calendar-dates.js';
const type:MeetingType={id:'71000000-0000-4000-8000-000000000001',slug:'71000000-0000-4000-8000-000000000002',title:'Income Path Call',description:'A focused conversation',durationMinutes:20,intervalMinutes:20,bufferBeforeMinutes:0,bufferAfterMinutes:0,noticeMinutes:0,horizonDays:365,timeZone:'Europe/London',location:'',questions:[],published:false,version:0};
const schedule:CalendarSchedule={timeZone:'Europe/London',windows:[{day:1,start:540,end:600}],overrides:[]};
const now=Date.parse('2026-01-01T00:00:00.000Z');
test('week/month grid is the same shared implementation used by the social planner',()=>{
 const week=periodBounds({date:'2026-11-04',mode:'week'});assert.equal(dateOnly(week.gridStart),'2026-11-02');assert.equal(dateOnly(week.gridEnd),'2026-11-08');
 const month=periodBounds({date:'2026-11-04',mode:'month'});assert.equal(dateOnly(month.gridStart),'2026-10-26');assert.equal(dateOnly(month.gridEnd),'2026-12-06');
});
test('working hours produce exact real UTC instants in winter and summer',()=>{
 const winter=availableSlots({type,schedule,date:'2026-02-02',busy:[],now});assert.equal(winter.length,3);assert.equal(winter[0]?.start,'2026-02-02T09:00:00.000Z');
 const summer=availableSlots({type,schedule,date:'2026-06-01',busy:[],now});assert.equal(summer[0]?.start,'2026-06-01T08:00:00.000Z');assert.equal(dateInTimeZone(summer[0]!.start,'Europe/London'),'2026-06-01');
});
test('buffers and half-open conflicts remove only occupied slots',()=>{
 const buffered={...type,durationMinutes:20,bufferAfterMinutes:10};
 const slots=availableSlots({type:buffered,schedule,date:'2026-02-02',busy:[{start:'2026-02-02T09:25:00.000Z',end:'2026-02-02T09:30:00.000Z'}],now});
 assert.equal(slots.length,0);
 assert.equal(overlaps({start:'2026-02-02T09:00:00Z',end:'2026-02-02T09:20:00Z'},{start:'2026-02-02T09:20:00Z',end:'2026-02-02T09:40:00Z'}),false);
 assert.deepEqual(bookingRange(buffered,'2026-02-02T09:00:00Z'),{start:'2026-02-02T09:00:00.000Z',end:'2026-02-02T09:30:00.000Z'});
});
test('date exceptions override regular hours, including a whole closed day',()=>{
 const closed={...schedule,overrides:[{date:'2026-02-02',windows:[]}]};assert.deepEqual(availableSlots({type,schedule:closed,date:'2026-02-02',busy:[],now}),[]);
 const special={...schedule,overrides:[{date:'2026-02-03',windows:[{start:600,end:620}]}]};assert.equal(availableSlots({type,schedule:special,date:'2026-02-03',busy:[],now}).length,1);
});
test('notice and booking horizon are applied before returning public slots',()=>{
 assert.deepEqual(availableSlots({type:{...type,noticeMinutes:61},schedule,date:'2026-02-02',busy:[],now:Date.parse('2026-02-02T09:00:00Z')}),[]);
 assert.deepEqual(availableSlots({type:{...type,horizonDays:1},schedule,date:'2026-02-02',busy:[],now}),[]);
});
test('DST gap never invents a local time; repeated hour has distinct UTC keys',()=>{
 const sunday={...schedule,windows:[{day:0,start:60,end:120}]},short={...type,durationMinutes:20};
 assert.equal(availableSlots({type:short,schedule:sunday,date:'2026-03-29',busy:[],now}).length,0);
 const fall=availableSlots({type:short,schedule:sunday,date:'2026-10-25',busy:[],now});assert.equal(fall.length,6);assert.equal(new Set(fall.map(x=>x.start)).size,6);
});
test('invalid schedules, unknown answers, duplicate questions and spoofed locations are rejected',()=>{
 assert.throws(()=>validateSchedule({...schedule,windows:[{day:1,start:500,end:600},{day:1,start:590,end:650}]}));
 assert.throws(()=>validateMeetingType({...type,timeZone:'Invalid/Zone'}));assert.throws(()=>validateMeetingType({...type,location:'javascript:alert(1)'}));
 assert.throws(()=>validatePerson({name:'Martin',email:'m@example.invalid',answers:{unexpected:'value'}},type));
 const question={id:'goal',label:'Your goal',kind:'text' as const,required:true};assert.throws(()=>validateMeetingType({...type,questions:[question,question]}));
 assert.throws(()=>validatePerson({name:'Martin',email:'m@example.invalid',answers:{}},{...type,questions:[question]}));
});
