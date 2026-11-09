/** Source-bound private drafts. These formats never imply a connected publisher. */
import {createHash} from 'node:crypto';
import type {ArticleBody,GenerationRecord} from './types.js';
import {SeoBlogError} from './types.js';
import {validatePublicUrl} from './safe-fetch.js';

export const POSTING_PLATFORMS = [
  {id:'substack',label:'Substack',format:'newsletter',url:'https://substack.com/'},
  {id:'reddit',label:'Reddit',format:'answer',url:'https://www.reddit.com/'},
  {id:'quora',label:'Quora',format:'answer',url:'https://www.quora.com/'},
  {id:'medium',label:'Medium',format:'newsletter',url:'https://medium.com/'},
  {id:'facebook',label:'Facebook',format:'short',url:'https://www.facebook.com/'},
  {id:'twitter',label:'X',format:'short',url:'https://x.com/'},
  {id:'threads',label:'Threads',format:'short',url:'https://www.threads.com/'},
  {id:'bluesky',label:'Bluesky',format:'short',url:'https://bsky.app/'},
  {id:'custom',label:'Another location',format:'newsletter',url:''},
] as const;
export type PostingPlatform = typeof POSTING_PLATFORMS[number]['id'];
export interface PostDraftSource {
  readonly articleId:string; readonly brandId:string; readonly versionId:string;
  readonly contentSha:string; readonly profileVersion:number; readonly factsSha:string;
  readonly body:ArticleBody; readonly publicUrl:string|null;
}
export interface PostDraftRevision {
  readonly id:string; readonly number:number; readonly parentRevisionId:string|null;
  readonly title:string; readonly body:string; readonly question:string; readonly targetUrl:string|null;
  readonly sourceVersionId:string; readonly sourceContentSha:string; readonly profileVersion:number; readonly factsSha:string;
  readonly mode:'article'|'edited'|'restored'|'model'; readonly generation:GenerationRecord|null;
  readonly createdAt:string; readonly createdBy:string; readonly sha256:string;
}
export interface PlatformDraft {
  readonly id:string; readonly platform:PostingPlatform; readonly currentRevisionId:string;
  readonly revisions:readonly PostDraftRevision[];
}
/** Stable previews can be edited without writing nine records on a page view. */
export function defaultPostDraftId(articleId:string,versionId:string,platform:PostingPlatform,questionIndex=0):string {
  const h=createHash('sha256').update(JSON.stringify([articleId,versionId,platform,questionIndex])).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export function postingPlatform(raw:string):PostingPlatform {
  if(!POSTING_PLATFORMS.some(p=>p.id===raw))throw new SeoBlogError(400,'Choose a posting location.');
  return raw as PostingPlatform;
}
export function draftTarget(platform:PostingPlatform,raw:string|null|undefined):string|null {
  const text=raw?.trim()||POSTING_PLATFORMS.find(p=>p.id===platform)!.url;
  if(!text)return null;
  if(text.length>2000)throw new SeoBlogError(400,'That destination address is too long.');
  let u:URL;try{u=validatePublicUrl(text);}catch{throw new SeoBlogError(400,'Use a public web address for the posting location.');}
  if(u.protocol!=='https:')throw new SeoBlogError(400,'Use an https address for the posting location.');
  const domains:Partial<Record<PostingPlatform,string[]>>={reddit:['reddit.com','redd.it'],quora:['quora.com'],medium:['medium.com'],facebook:['facebook.com','fb.com'],twitter:['x.com','twitter.com'],threads:['threads.com','threads.net'],bluesky:['bsky.app']};
  if(domains[platform]&&!domains[platform]!.some(d=>u.hostname===d||u.hostname.endsWith('.'+d)))throw new SeoBlogError(400,'Use an address from the selected platform. Choose Another location for a different website.');
  // Substack publications can use their own custom domain.
  return u.toString();
}
const clean=(s:string)=>s.replace(/\u0000/gu,' ').replace(/\[src:[^\]]+\]/gu,'').trim();
const plain=(s:string)=>clean(s).replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gu,'$1').replace(/https?:\/\/\S+/gu,'').trim();
const short=(s:string,n:number)=>{const chars=[...s];return chars.length<=n?s:chars.slice(0,n-1).join('').replace(/\s+\S*$/u,'').trimEnd()+'…';};
function fields(value:Pick<PostDraftRevision,'title'|'body'|'question'>):typeof value {
  const result={title:clean(value.title),body:clean(value.body),question:clean(value.question)};
  if(!result.title||result.title.length>300||!result.body||result.body.length>60_000||result.question.length>2000)throw new SeoBlogError(400,'Add a title and post text within the editor limits.');
  return result;
}
function revisionHash(platform:PostingPlatform,r:Omit<PostDraftRevision,'sha256'>):string {
  return createHash('sha256').update(JSON.stringify([platform,r.title,r.body,r.question,r.targetUrl,r.sourceVersionId,r.sourceContentSha,r.profileVersion,r.factsSha])).digest('hex');
}
function revision(platform:PostingPlatform,input:Omit<PostDraftRevision,'sha256'>):PostDraftRevision {
  if(!UUID.test(input.id))throw new SeoBlogError(400,'Refresh the form and try again.');
  const r={...input,...fields(input),targetUrl:draftTarget(platform,input.targetUrl)};
  return {...r,sha256:revisionHash(platform,r)};
}
export function currentPostDraft(d:PlatformDraft):PostDraftRevision {
  const r=d.revisions.find(r=>r.id===d.currentRevisionId);if(!r)throw new SeoBlogError(409,'This post version is unavailable.');return r;
}
export function postDraftIsStale(d:PlatformDraft,source:PostDraftSource):boolean {
  const r=currentPostDraft(d);return r.sourceVersionId!==source.versionId||r.sourceContentSha!==source.contentSha||r.factsSha!==source.factsSha;
}
export function derivePostDraft(source:PostDraftSource,platform:PostingPlatform,brandName:string,input:{id:string;actor:string;at:string;targetUrl?:string|null;questionIndex?:number}):PlatformDraft {
  const format=POSTING_PLATFORMS.find(p=>p.id===platform)!.format;
  const b=source.body,faq=b.faqs[input.questionIndex??0]??b.faqs[0];
  let title=b.title,question='',body='';
  if(format==='newsletter') {
    const citations=b.citations.filter(c=>c.public).map(c=>`- [${c.title}](${c.url})`);
    body=[clean(b.intro),...b.sections.map(s=>`## ${clean(s.heading)}\n\n${clean(s.body)}`),clean(b.conclusion),
      ...(b.faqs.length?['## Questions answered',...b.faqs.map(f=>`### ${clean(f.q)}\n\n${clean(f.a)}`)]:[]),
      ...(b.cta?[`[${clean(b.cta.label)}](${b.cta.url})`]:[]),...(citations.length?['## Sources',citations.join('\n')]:[]),
      ...(source.publicUrl?[`Originally published: ${source.publicUrl}`]:[])].filter(Boolean).join('\n\n');
  }else if(format==='answer') {
    question=faq?.q??b.title;title=question;
    const answer=(faq?.a??b.intro).replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gu,(_match,label:string,url:string)=>b.citations.some(c=>c.public&&c.url===url)?label:'');
    body=[plain(answer),`Disclosure: shared by ${brandName.replace(/\s+/gu,' ')}.`].filter(Boolean).join('\n\n');
  }else body=[short(plain(b.intro),platform==='facebook'?800:platform==='threads'?400:240),source.publicUrl??''].filter(Boolean).join('\n\n');
  const r=revision(platform,{id:input.id,number:1,parentRevisionId:null,title,body,question,targetUrl:input.targetUrl??null,sourceVersionId:source.versionId,sourceContentSha:source.contentSha,profileVersion:source.profileVersion,factsSha:source.factsSha,mode:'article',generation:null,createdAt:input.at,createdBy:input.actor});
  return {id:input.id,platform,currentRevisionId:r.id,revisions:[r]};
}
export function editPostDraft(d:PlatformDraft,expected:string,input:{id:string;actor:string;at:string;title:string;body:string;question:string;targetUrl:string|null}):PlatformDraft {
  const edited=fields(input),targetUrl=draftTarget(d.platform,input.targetUrl);
  const existing=d.revisions.find(r=>r.id===input.id);
  if(existing){if(existing.title!==edited.title||existing.body!==edited.body||existing.question!==edited.question||existing.targetUrl!==targetUrl||existing.parentRevisionId!==expected)throw new SeoBlogError(409,'That save request already contains different changes. Reload the post.');return d;}
  const prior=currentPostDraft(d);if(prior.id!==expected)throw new SeoBlogError(409,'Another post version was saved. Reload before editing.');
  const r=revision(d.platform,{...prior,...edited,id:input.id,targetUrl,number:prior.number+1,parentRevisionId:prior.id,mode:'edited',generation:null,createdAt:input.at,createdBy:input.actor});
  return {...d,currentRevisionId:r.id,revisions:[...d.revisions,r]};
}
export function restorePostDraft(d:PlatformDraft,expected:string,restoreId:string,input:{id:string;actor:string;at:string}):PlatformDraft {
  if(d.revisions.some(r=>r.id===input.id))return d;
  const current=currentPostDraft(d),old=d.revisions.find(r=>r.id===restoreId);
  if(current.id!==expected)throw new SeoBlogError(409,'Another post version was saved. Reload before restoring.');
  if(!old)throw new SeoBlogError(404,'That earlier post version was not found.');
  const r=revision(d.platform,{...old,id:input.id,number:current.number+1,parentRevisionId:current.id,mode:'restored',createdAt:input.at,createdBy:input.actor});
  return {...d,currentRevisionId:r.id,revisions:[...d.revisions,r]};
}
export function exportPostDraft(d:PlatformDraft):string {
  const r=currentPostDraft(d);return `# ${r.title}\n\n${r.body}\n`;
}
