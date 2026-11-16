/**
 * Owner-edited native timeline structure for the ONE canonical Creative Studio.
 * Plans are private drafts, NOT paid provider intents or approved/publishable
 * artifacts. The compilation function requires a separate, server-verified
 * private media URL and exact reviewed version before any paid render.
 */
import {createHash} from 'node:crypto';
import {SeoBlogError} from '../seo-blog/types.js';
export type VideoCanvas='portrait'|'square'|'landscape';
export interface VideoEditClip {
 readonly startMs:number;
 readonly endMs:number;
 readonly caption:string;
 readonly transition:'cut'|'fade';
 readonly speed:0.5|1|2;
 /** Optional for compatibility with immutable v1 edits; absent means full volume. */
 readonly volume?:0|0.25|0.5|1;
}
export interface VideoEditPlan {
 readonly canvas:VideoCanvas;
 readonly clips:readonly VideoEditClip[];
 readonly disclosure:string;
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export const EDIT_PLAN_MAX_CLIPS=12;
const bad=(message:string):never=>{throw new SeoBlogError(400,message);};
export function checkVideoEditPlan(value:unknown):VideoEditPlan {
 if(!value||typeof value!=='object'||Array.isArray(value))return bad('Timeline draft must be an object');
 const v=value as Record<string,unknown>;
 if(!['portrait','square','landscape'].includes(String(v.canvas)))return bad('Choose a supported video format');
 if(!Array.isArray(v.clips)||v.clips.length<1||v.clips.length>EDIT_PLAN_MAX_CLIPS)
  return bad('Add between one and twelve timeline clips');
 if(typeof v.disclosure!=='string'||!/(^|\s)#ad(\s|$)/iu.test(v.disclosure)||v.disclosure.length>280||
    /[<>\u0000-\u001f\u007f]/u.test(v.disclosure))
  return bad('An on-screen #ad disclosure is required for affiliate videos');
 let total=0;
 const clips=v.clips.map((item,i):VideoEditClip=>{
  if(!item||typeof item!=='object'||Array.isArray(item))return bad('Invalid clip '+(i+1));
  const x=item as Record<string,unknown>;
  if(!Number.isSafeInteger(x.startMs)||!Number.isSafeInteger(x.endMs)||
    Number(x.startMs)<0||Number(x.endMs)<=Number(x.startMs)||
    Number(x.endMs)>36_000_000)
    return bad('Clip timing is invalid');
  if(typeof x.caption!=='string'||x.caption.length>240||/[<>\u0000-\u001f\u007f]/u.test(x.caption))
    return bad('Caption must be plain, bounded text');
  if(x.transition!=='cut'&&x.transition!=='fade')return bad('Unsupported video transition');
  if(x.speed!==0.5&&x.speed!==1&&x.speed!==2)return bad('Unsupported clip speed');
  if(x.volume!==undefined&&![0,0.25,0.5,1].includes(x.volume as number))return bad('Unsupported audio volume');
  const duration=(Number(x.endMs)-Number(x.startMs))/Number(x.speed);
  if(duration<500||duration>120000)return bad('Trim each video clip to 0.5–120 seconds');
  total+=duration;
  return {startMs:Number(x.startMs),endMs:Number(x.endMs),caption:x.caption,
    transition:x.transition,speed:x.speed,
    ...(x.volume===undefined?{}:{volume:x.volume as 0|0.25|0.5|1})};
 });
 if(total>300000)return bad('A draft must fit a maximum five-minute output');
 return Object.freeze({canvas:v.canvas as VideoCanvas,clips:Object.freeze(clips),disclosure:v.disclosure});
}
export function videoEditDigest(value:VideoEditPlan):string {
 return createHash('sha256').update(JSON.stringify(checkVideoEditPlan(value))).digest('hex');
}
/**
 * Builds actual Shotstack edit JSON, but returns private draft JSON only.
 * The caller must resolve authorised source media through an approved,
 * short-lived provider-fetchable URL; browser URLs cannot be passed in.
 */
export function videoPlanToShotstack(plan:VideoEditPlan,source:{url:string;durationMs:number;
 verified:boolean;rightsApproved:boolean}):Readonly<Record<string,unknown>>{
 const p=checkVideoEditPlan(plan);
 let url:URL;
 try{url=new URL(source.url);}catch{return bad('Video source URL unavailable');}
 if(!source.verified||!source.rightsApproved||url.protocol!=='https:'||url.port||
   url.username||url.password||!Number.isSafeInteger(source.durationMs))
  return bad('Verified, authorised video source and secure provider URL required');
 if(p.clips.some(c=>c.endMs>source.durationMs))return bad('Clip trim exceeds measured input duration');
 const clips:Record<string,unknown>[]=[];
 const captions:Record<string,unknown>[]=[];
 let cursor=0;
 for(const clip of p.clips){
  const duration=Number(((clip.endMs-clip.startMs)/clip.speed/1000).toFixed(3));
  clips.push({asset:{type:'video',src:url.href,trim:clip.startMs/1000,volume:clip.volume??1},
    start:cursor,length:duration, ...(clip.transition==='fade'?{transition:{in:'fade',out:'fade'}}:{}),
    ...(clip.speed!==1?{effect:'none',speed:clip.speed}:{})});
  if(clip.caption.trim())captions.push({asset:{type:'title',text:clip.caption,style:'minimal',position:'bottom'},
    start:cursor,length:duration});
  cursor=Number((cursor+duration).toFixed(3));
 }
 if(p.disclosure.trim())captions.push({asset:{type:'title',text:p.disclosure,style:'minimal',position:'bottom'},
  start:0,length:Math.min(5,cursor)});
 const resolution=p.canvas==='portrait'?'1080':p.canvas==='square'?'1080':'hd';
 const aspectRatio=p.canvas==='portrait'?'9:16':p.canvas==='square'?'1:1':'16:9';
 return {timeline:{background:'#000000',tracks:[{clips:captions},{clips}]},
   output:{format:'mp4',resolution,aspectRatio}};
}
export function checkedEditId(id:string):string {
 if(!UUID.test(id))throw new SeoBlogError(400,'Invalid timeline or source id');
 return id.toLowerCase();
}
