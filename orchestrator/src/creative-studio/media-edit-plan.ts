/**
 * Owner-edited native timeline structure for the ONE canonical Creative Studio.
 * Plans are private drafts, NOT paid provider intents or approved/publishable
 * artifacts. The compilation function requires a separate, server-verified
 * private media URL and exact reviewed version before any paid render.
 */
import {captionWidth,supportedCaption} from './media-caption-font.js';
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
  if(typeof x.caption!=='string'||Array.from(x.caption).length>240||/[<>\u0000-\u001f\u007f]/u.test(x.caption))
    return bad('Caption must be plain, bounded text');
  if(!supportedCaption(x.caption))return bad('Captions support Latin letters, numbers and punctuation. Emoji and other scripts are not supported yet.');
  if(x.caption.split(/\s+/u).some(w=>captionWidth(w)>720*.78))return bad('A caption word is too long. Add a space or shorten it.');
  if(x.transition!=='cut'&&x.transition!=='fade')return bad('Unsupported video transition');
  if(x.speed!==0.5&&x.speed!==1&&x.speed!==2)return bad('Unsupported clip speed');
  if(x.volume!==undefined&&![0,0.25,0.5,1].includes(x.volume as number))return bad('Unsupported audio volume');
  const duration=(Number(x.endMs)-Number(x.startMs))/Number(x.speed);
  if(duration<1000||duration>120000)return bad('Trim each video clip to 1–120 seconds');
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
export function checkedEditId(id:string):string {
 if(!UUID.test(id))throw new SeoBlogError(400,'Invalid timeline or source id');
 return id.toLowerCase();
}
