/** Questions observed in a saved SERP, not invented forum threads or people. */
import {createHash} from 'node:crypto';
import {validatePublicUrl} from './safe-fetch.js';
export interface ResearchQuestion {
  readonly id:string; readonly text:string; readonly origin:'search';
  readonly sourceUrl:string|null; readonly supplierTaskId:string;
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function parseResearchQuestions(items:unknown,taskId:string):ResearchQuestion[] {
  if(!Array.isArray(items)||!/^[a-zA-Z0-9-]{8,100}$/u.test(taskId))return [];
  const found=new Map<string,ResearchQuestion>();
  for(const group of items.slice(0,100)){
    if(!object(group)||group.type!=='people_also_ask'||!Array.isArray(group.items))continue;
    for(const item of group.items.slice(0,30)){
      if(!object(item)||typeof item.title!=='string')continue;
      const text=item.title.normalize('NFKC').replace(/\u0000/gu,' ').replace(/\s+/gu,' ').trim();
      if(text.length<5||text.length>500)continue;
      let sourceUrl:string|null=null;
      if(Array.isArray(item.expanded_element))for(const expanded of item.expanded_element.slice(0,10)){
        if(!object(expanded)||typeof expanded.url!=='string'||expanded.url.length>2000)continue;
        try{sourceUrl=validatePublicUrl(expanded.url).toString();break;}catch{/* Keep the real question without an unsafe link. */}
      }
      const key=text.toLowerCase();
      if(!found.has(key))found.set(key,{id:createHash('sha256').update(taskId+'\n'+key).digest('hex'),text,origin:'search',sourceUrl,supplierTaskId:taskId});
    }
  }
  return [...found.values()].slice(0,20);
}
