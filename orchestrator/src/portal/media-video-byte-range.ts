/** Strict single HTTP byte range; refuse multi-ranges, overflow and invalid suffixes. */
export type VideoByteRange={kind:'full'}|{kind:'invalid'}|{kind:'partial';start:number;end:number};
export function videoByteRange(header:string|undefined,size:number):VideoByteRange {
  if(!header)return {kind:'full'};
  if(!Number.isSafeInteger(size)||size<1||header.length>100)return {kind:'invalid'};
  const match=/^bytes=(\d*)-(\d*)$/u.exec(header);
  if(!match || (!match[1]&&!match[2]))return {kind:'invalid'};
  const a=match[1]!,b=match[2]!;
  if(a && !/^\d{1,15}$/u.test(a) || b && !/^\d{1,15}$/u.test(b))return {kind:'invalid'};
  if(!a){
    const suffix=Number(b);if(!Number.isSafeInteger(suffix)||suffix<=0)return {kind:'invalid'};
    return{kind:'partial',start:Math.max(0,size-suffix),end:size-1};
  }
  const start=Number(a),end=b?Number(b):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)return{kind:'invalid'};
  return{kind:'partial',start,end:Math.min(end,size-1)};
}
