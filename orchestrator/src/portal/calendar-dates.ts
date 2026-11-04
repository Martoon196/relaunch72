/** Shared by the social planner and appointment calendar. Date-only arithmetic is UTC;
 * the date shown for an instant is always resolved in the explicitly chosen zone. */
export const DAY_MS = 86_400_000;
export function validDateOnly(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}
export function safeTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) return 'UTC';
  try { new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(new Date(0)); return value; }
  catch { return 'UTC'; }
}
export function dateInTimeZone(value: string | Date, timeZone: string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {year:'numeric',month:'2-digit',day:'2-digit',timeZone}).formatToParts(date);
  const year=parts.find(p=>p.type==='year')?.value,month=parts.find(p=>p.type==='month')?.value,day=parts.find(p=>p.type==='day')?.value;
  return year && month && day ? validDateOnly(`${year}-${month}-${day}`) : null;
}
export const utcDate = (date:string):Date => new Date(`${date}T00:00:00.000Z`);
export const dateOnly = (date:Date):string => date.toISOString().slice(0,10);
export const addDays = (date:Date,days:number):Date => new Date(date.getTime()+days*DAY_MS);
export function mondayOnOrBefore(date:Date):Date {
  const weekday=date.getUTCDay(); return addDays(date,-(weekday===0?6:weekday-1));
}
export function periodBounds(filters:{date:string;mode:'week'|'month'}):Readonly<{
  gridStart:Date;gridEnd:Date;primaryStart:Date;primaryEnd:Date;previousDate:string;nextDate:string;
}> {
  const selected=utcDate(filters.date);
  if(filters.mode==='week') {
    const start=mondayOnOrBefore(selected),end=addDays(start,6);
    return Object.freeze({gridStart:start,gridEnd:end,primaryStart:start,primaryEnd:end,
      previousDate:dateOnly(addDays(selected,-7)),nextDate:dateOnly(addDays(selected,7))});
  }
  const first=new Date(Date.UTC(selected.getUTCFullYear(),selected.getUTCMonth(),1));
  const last=new Date(Date.UTC(selected.getUTCFullYear(),selected.getUTCMonth()+1,0));
  return Object.freeze({gridStart:mondayOnOrBefore(first),gridEnd:addDays(last,last.getUTCDay()===0?0:7-last.getUTCDay()),
    primaryStart:first,primaryEnd:last,previousDate:dateOnly(new Date(Date.UTC(selected.getUTCFullYear(),selected.getUTCMonth()-1,1))),
    nextDate:dateOnly(new Date(Date.UTC(selected.getUTCFullYear(),selected.getUTCMonth()+1,1)))});
}
