/** Independent, bounded PUBLIC observations. Repository/API acceptance is never served proof. */
import { decodeEntities, escapeXml } from './html.js';
import type { FetchTransport } from './safe-fetch.js';
export type ObservationState='verified'|'pending'|'different'|'unknown'|'incomplete';
export interface WebsiteObservation {
  readonly at:string;
  readonly url:string;
  readonly state:ObservationState;
  readonly detail:string;
  readonly finalUrl?:string;
  readonly canonical?:string|null;
  readonly pagesRead?:number;
  readonly linkedCategoryUrls?:readonly string[];
  /** Opt-in (WordPress) count of SEO head tags actually served; observations, not guarantees. */
  readonly seoHead?:{readonly canonical:number;readonly robots:number;readonly description:number;readonly ogUrl:string|null;readonly jsonLd:number};
}
export type ArchivePagination='same-path'|'wordpress';
export interface SitemapObservation extends WebsiteObservation {
  readonly complete:boolean;
  readonly occurrences:number;
  readonly lastmod:string|null;
}
export interface WebsiteDeliveryEvidence {
  readonly article:WebsiteObservation;
  readonly index:WebsiteObservation;
  readonly categories:readonly WebsiteObservation[];
  readonly sitemap:SitemapObservation;
}
function attributes(tag:string):Record<string,string> {
  const out:Record<string,string>={};const re=/\s([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;let match:RegExpExecArray|null;
  while((match=re.exec(tag)))out[match[1]!.toLowerCase()]=decodeEntities(match[2]??match[3]??match[4]??'');
  return out;
}
function observedHtml(html:string):string {
  return html.replace(/<!--[\s\S]*?(?:-->|$)/g,'').replace(/<(script|style|template|noscript|textarea|title|xmp|iframe|noembed|noframes)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<plaintext\b[\s\S]*$/i,'');
}
function htmlHead(html:string):string{return /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(observedHtml(html))?.[1]??'';}
function observedLinks(html:string,base:string):{links:Set<string>;complete:boolean} {
  const links=new Set<string>();const re=/<a\b[^>]*>/gi;let count=0;let match:RegExpExecArray|null;
  while((match=re.exec(html))){if(++count>10000)return {links,complete:false};const href=attributes(match[0]).href;if(!href)continue;try{const url=new URL(href,base);if(['https:','http:'].includes(url.protocol)){url.hash='';links.add(url.toString());}}catch{/* Invalid anchors cannot establish membership. */}}
  return {links,complete:true};
}
function nextPage(html:string,base:string):string|null {
  for(const tag of htmlHead(html).match(/<link\b[^>]*>/gi)??[]){const a=attributes(tag);if(a.rel?.toLowerCase().split(/\s+/).includes('next')&&a.href){try{return new URL(a.href,base).toString();}catch{return null;}}}
  return null;
}
export async function observeArticle(transport:FetchTransport,url:string,marker:string,at:string,categoryUrls:readonly string[]=[],seoHead=false):Promise<WebsiteObservation> {
  const base={at,url};
  try {
    const page=await transport.fetch(url,{maxBytes:3*1024*1024,timeoutMs:10000});
    if(page.status===404)return {...base,state:'pending',detail:'The article is not serving yet.'};
    if(page.status!==200||page.truncated)return {...base,state:'unknown',detail:'The complete public article could not be read.'};
    const html=page.body.toString('utf8');const head=htmlHead(html);const meta=(head.match(/<meta\b[^>]*>/gi)??[]).map(attributes).filter((a)=>a.name?.toLowerCase()==='r72-blog-version');
    const canonical=(head.match(/<link\b[^>]*>/gi)??[]).map(attributes).filter((a)=>a.rel?.toLowerCase().split(/\s+/).includes('canonical'));
    const actual=canonical.length===1?canonical[0]!.href??null:null;
    const matched=page.finalUrl===url&&actual===url&&meta.length===1&&meta[0]!.content===marker;
    const {links}=observedLinks(observedHtml(html),page.finalUrl);
    let headCounts:WebsiteObservation['seoHead'];let note='';
    if(seoHead){
      const metas=(htmlHead(html).match(/<meta\b[^>]*>/gi)??[]).map(attributes);
      const rawHead=/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(html.replace(/<!--[\s\S]*?(?:-->|$)/g,''))?.[1]??'';
      headCounts={canonical:canonical.length,robots:metas.filter((a)=>a.name?.toLowerCase()==='robots').length,description:metas.filter((a)=>a.name?.toLowerCase()==='description').length,ogUrl:metas.find((a)=>a.property?.toLowerCase()==='og:url')?.content?.slice(0,2048)??null,jsonLd:(rawHead.match(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json/gi)??[]).length};
      if(headCounts.robots>1||headCounts.description>1||(headCounts.ogUrl!==null&&headCounts.ogUrl!==url))note=' SEO head check: duplicate robots/description tags or an og:url that differs from the canonical were served.';
    }
    return {...base,finalUrl:page.finalUrl.slice(0,2048),canonical:actual?.slice(0,2048)??null,linkedCategoryUrls:categoryUrls.filter((u)=>links.has(u)),...(headCounts?{seoHead:headCounts}:{}),state:matched?'verified':'different',detail:(matched?'Exact article version, final URL and canonical verified.':'The served version, final URL or canonical differs from the reviewed target.')+note};
  }catch{return {...base,state:'unknown',detail:'The public article could not be reached. Its absence has not been established.'};}
}
export async function observeMembership(transport:FetchTransport,url:string,articleUrl:string,at:string,maxPages=10,pagination:ArchivePagination='same-path'):Promise<WebsiteObservation> {
  let current:string|null=url;const seen=new Set<string>();const origin=new URL(url).origin;const path=new URL(url).pathname;
  const archivePath=path.endsWith('/')?path:`${path}/`;
  const wpPage={test:(candidate:string)=>candidate.startsWith(`${archivePath}page/`)&&/^[1-9][0-9]{0,4}\/?$/.test(candidate.slice(archivePath.length+5))};
  try {
    while(current&&seen.size<maxPages){
      if(seen.has(current))return {at,url,state:'incomplete',pagesRead:seen.size,detail:'The archive pagination repeated; membership is not fully checked.'};
      const u=new URL(current);if(u.origin!==origin||(u.pathname!==path&&!(pagination==='wordpress'&&seen.size>0&&!u.search&&wpPage.test(u.pathname))))return {at,url,state:'incomplete',pagesRead:seen.size,detail:'The archive advertised unsupported pagination.'};
      seen.add(current);const page=await transport.fetch(current,{maxBytes:2*1024*1024,timeoutMs:10000});
      if(page.status===404)return {at,url,state:seen.size===1?'pending':'unknown',pagesRead:seen.size,detail:seen.size===1?'The expected archive is not serving yet.':'An advertised archive page is unavailable; membership is not fully checked.'};
      if(page.status!==200||page.truncated||page.finalUrl!==current)return {at,url,state:'unknown',pagesRead:seen.size,detail:'The complete expected archive could not be read at its exact URL.'};
      const html=observedHtml(page.body.toString('utf8'));const {links,complete}=observedLinks(html,page.finalUrl);if(links.has(articleUrl))return {at,url,state:'verified',pagesRead:seen.size,detail:'The archive links to the exact article URL.'};
      if(!complete)return {at,url,state:'incomplete',pagesRead:seen.size,detail:'The archive link bound was reached; membership is not fully checked.'};
      current=nextPage(html,page.finalUrl);
    }
    return {at,url,state:current?'incomplete':'pending',pagesRead:seen.size,detail:current?'More archive pages remain; membership is not fully checked.':'The article link is not in the completely observed archive.'};
  }catch{return {at,url,state:'unknown',pagesRead:seen.size,detail:'Archive membership could not be checked; no absence is inferred.'};}
}
interface SitemapEntry {readonly loc:string;readonly lastmod:string|null}
interface SitemapXmlNode {
  qname:string;local:string;uri:string;start:number;openEnd:number;closeStart:number;end:number;selfClosing:boolean;
  namespaces:ReadonlyMap<string,string>;children:SitemapXmlNode[];text:string;
}
interface SitemapXmlEntry extends SitemapEntry {readonly node:SitemapXmlNode;readonly lastmodNode:SitemapXmlNode|null}
const SITEMAP_NS='http://www.sitemaps.org/schemas/sitemap/0.9';
const XML_NS='http://www.w3.org/XML/1998/namespace';
function xmlText(raw:string):string {
  if(/&(?!amp;|lt;|gt;|quot;|apos;|#(?:x[0-9a-fA-F]+|[0-9]+);)/.test(raw)||raw.includes(']]>'))throw new Error('Invalid XML text or entity.');
  const decoded=raw.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g,(_m,value:string)=>{
    if(value[0]!=='#')return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"} as Record<string,string>)[value]!;
    const code=value.startsWith('#x')?parseInt(value.slice(2),16):Number(value.slice(1));
    if(!Number.isSafeInteger(code)||code<0||code>0x10ffff)throw new Error('Invalid XML character reference.');
    return String.fromCodePoint(code);
  });
  validateXmlCharacters(decoded);return decoded;
}
function validateXmlCharacters(value:string):void {
  for(const char of value){const code=char.codePointAt(0)!;if(!(code===9||code===10||code===13||code>=0x20&&code<=0xd7ff||code>=0xe000&&code<=0xfffd||code>=0x10000&&code<=0x10ffff))throw new Error('Invalid XML character.');}
}
function xmlAttributes(raw:string):{name:string;value:string}[] {
  const out:{name:string;value:string}[]=[];const seen=new Set<string>();let i=0;
  while(i<raw.length){
    if(!/[ \t\r\n]/.test(raw[i]!))throw new Error('Malformed XML attribute separation.');
    while(/[ \t\r\n]/.test(raw[i]??'')&&i<raw.length)i++;
    if(i===raw.length)break;
    const name=/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/.exec(raw.slice(i))?.[0];if(!name||seen.has(name)||out.length>=128)throw new Error('Invalid or duplicate XML attribute.');i+=name.length;
    while(/[ \t\r\n]/.test(raw[i]??'')&&i<raw.length)i++;if(raw[i++]!=='=')throw new Error('Malformed XML attribute.');
    while(/[ \t\r\n]/.test(raw[i]??'')&&i<raw.length)i++;const quote=raw[i++];if(quote!=='"'&&quote!=="'")throw new Error('XML attributes require quotes.');
    const end=raw.indexOf(quote,i);if(end<0)throw new Error('Unclosed XML attribute.');const value=raw.slice(i,end);if(value.includes('<'))throw new Error('Invalid XML attribute text.');
    out.push({name,value:xmlText(value).replace(/[\t\r\n]/g,' ')});seen.add(name);i=end+1;
  }
  return out;
}
function parseSitemapXml(xml:string):{root:SitemapXmlNode;index:boolean;entries:readonly SitemapXmlEntry[]} {
  if(Buffer.byteLength(xml)>3*1024*1024)throw new Error('Sitemap byte bound exceeded.');
  const stack:SitemapXmlNode[]=[];let root:SitemapXmlNode|null=null;let nodes=0;let i=xml.charCodeAt(0)===0xfeff?1:0;let declaration=false;
  const append=(text:string,cdata=false)=>{if(stack.length){if(cdata)validateXmlCharacters(text);stack[stack.length-1]!.text+=cdata?text:xmlText(text);}else if(!/^[ \t\r\n]*$/.test(text))throw new Error('Text outside XML root.');};
  while(i<xml.length){
    if(xml[i]!=='<'){const end=xml.indexOf('<',i);const stop=end<0?xml.length:end;append(xml.slice(i,stop));i=stop;continue;}
    if(xml.startsWith('<!--',i)){const end=xml.indexOf('-->',i+4);if(end<0||xml.slice(i+4,end).includes('--')||xml.slice(i+4,end).endsWith('-'))throw new Error('Malformed XML comment.');i=end+3;continue;}
    if(xml.startsWith('<![CDATA[',i)){if(!stack.length)throw new Error('CDATA outside XML root.');const end=xml.indexOf(']]>',i+9);if(end<0)throw new Error('Unclosed CDATA.');append(xml.slice(i+9,end),true);i=end+3;continue;}
    if(xml.startsWith('<?',i)){const end=xml.indexOf('?>',i+2);if(end<0)throw new Error('Unclosed XML processing instruction.');const text=xml.slice(i+2,end);const target=/^[A-Za-z_][\w.-]*/.exec(text)?.[0];if(!target)throw new Error('Invalid XML processing instruction.');if(target.toLowerCase()==='xml'){if(target!=='xml'||declaration||root||i!==(xml.charCodeAt(0)===0xfeff?1:0))throw new Error('Invalid XML declaration.');const attrs=xmlAttributes(text.slice(target.length));if(!['version','version,encoding','version,standalone','version,encoding,standalone'].includes(attrs.map((a)=>a.name).join(','))||!['1.0','1.1'].includes(attrs[0]?.value??'')||attrs.some((a)=>a.name==='encoding'&&!/^utf-?8$/i.test(a.value)||a.name==='standalone'&&!['yes','no'].includes(a.value)))throw new Error('Unsupported XML declaration.');declaration=true;}i=end+2;continue;}
    if(xml.startsWith('<!',i))throw new Error('DTD and entity declarations are unsupported.');
    let end=i+1;let quote:string|null=null;
    for(;end<xml.length;end++){const char=xml[end]!;if(quote){if(char===quote)quote=null;}else if(char==='"'||char==="'")quote=char;else if(char==='>')break;}
    if(end>=xml.length||quote)throw new Error('Unclosed XML tag.');
    if(xml.startsWith('</',i)){
      const close=/^([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)[ \t\r\n]*$/.exec(xml.slice(i+2,end));const node=stack.pop();if(!close||!node||close[1]!==node.qname)throw new Error('Mismatched XML nesting.');node.closeStart=i;node.end=end+1;i=end+1;continue;
    }
    const raw=xml.slice(i+1,end);const name=/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/.exec(raw)?.[0];if(!name)throw new Error('Invalid XML element name.');
    const selfClosing=raw.endsWith('/');const attrs=xmlAttributes(raw.slice(name.length,selfClosing?-1:undefined));
    const parent=stack[stack.length-1];let namespaces:ReadonlyMap<string,string>=parent?.namespaces??new Map([['xml',XML_NS]]);
    const declarations=attrs.filter((a)=>a.name==='xmlns'||a.name.startsWith('xmlns:'));
    if(declarations.length){const updated=new Map(namespaces);for(const a of declarations){const prefix=a.name==='xmlns'?'':a.name.slice(6);if(prefix==='xmlns'||prefix==='xml'&&a.value!==XML_NS||prefix!=='xml'&&a.value===XML_NS||a.value==='http://www.w3.org/2000/xmlns/'||prefix&&a.value==='')throw new Error('Invalid XML namespace declaration.');updated.set(prefix,a.value);}namespaces=updated;}
    const expanded=new Set<string>();for(const a of attrs){if(a.name==='xmlns'||a.name.startsWith('xmlns:'))continue;const parts=a.name.split(':');const uri=parts.length===2?namespaces.get(parts[0]!):'';if(uri===undefined)throw new Error('Undeclared XML attribute prefix.');const key=`${uri}:${parts.at(-1)}`;if(expanded.has(key))throw new Error('Duplicate expanded XML attribute.');expanded.add(key);}
    const parts=name.split(':');const uri=parts.length===2?namespaces.get(parts[0]!):namespaces.get('')??'';if(uri===undefined)throw new Error('Undeclared XML element prefix.');
    if(++nodes>200000||stack.length>=64)throw new Error('Sitemap structural bound exceeded.');
    const node:SitemapXmlNode={qname:name,local:parts.at(-1)!,uri,start:i,openEnd:end+1,closeStart:selfClosing?end-1:-1,end:selfClosing?end+1:-1,selfClosing,namespaces,children:[],text:''};
    if(parent)parent.children.push(node);else{if(root)throw new Error('Multiple XML roots.');root=node;}
    if(!selfClosing)stack.push(node);i=end+1;
  }
  if(stack.length||!root||root.end<0)throw new Error('Incomplete XML document.');
  if(!['urlset','sitemapindex'].includes(root.local)||![SITEMAP_NS,''].includes(root.uri))throw new Error('Unsupported sitemap root or namespace.');
  if(!/^[ \t\r\n]*$/.test(root.text))throw new Error('Unexpected sitemap root text.');
  const index=root.local==='sitemapindex';const expected=index?'sitemap':'url';if(root.children.length>50000)throw new Error('Sitemap entry bound exceeded.');
  const entries=root.children.map((node):SitemapXmlEntry=>{
    if(node.local!==expected||node.uri!==root!.uri||!/^[ \t\r\n]*$/.test(node.text))throw new Error('Unexpected sitemap entry or namespace.');
    const standard=node.children.filter((n)=>n.uri===root!.uri);const allowed=index?['loc','lastmod']:['loc','lastmod','changefreq','priority'];if(standard.some((n)=>!allowed.includes(n.local)))throw new Error('Unexpected sitemap field.');
    const locs=standard.filter((n)=>n.local==='loc'),lastmods=standard.filter((n)=>n.local==='lastmod');if(locs.length!==1||lastmods.length>1||locs[0]!.children.length||lastmods.some((n)=>n.children.length))throw new Error('Invalid sitemap location or lastmod structure.');
    const loc=locs[0]!.text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g,'');if(!loc||loc.length>2048||/[<>]/.test(loc))throw new Error('Invalid sitemap location.');const url=new URL(loc);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid sitemap URL.');
    return {loc,lastmod:lastmods[0]?.text.trim()??null,node,lastmodNode:lastmods[0]??null};
  });
  return {root,index,entries};
}
export function readServedSitemap(xml:string):{index:boolean;entries:readonly SitemapEntry[]} {
  const result=parseSitemapXml(xml);return {index:result.index,entries:result.entries.map(({loc,lastmod})=>({loc,lastmod}))};
}
export async function observeSitemap(transport:FetchTransport,urls:readonly string[],articleUrl:string,at:string,maxDocuments=20):Promise<SitemapObservation> {
  const queue=[...urls];const seen=new Set<string>();let occurrences=0;let lastmod:string|null=null;let unknown=false;let incomplete=false;const origin=new URL(articleUrl).origin;
  while(queue.length&&seen.size<maxDocuments){
    const url=queue.shift()!;if(seen.has(url))continue;
    try{
      const parsedUrl=new URL(url);if(parsedUrl.origin!==origin){incomplete=true;continue;}
      seen.add(url);const resource=await transport.fetch(url,{maxBytes:3*1024*1024,timeoutMs:10000});
      if(resource.status!==200||resource.truncated||new URL(resource.finalUrl).origin!==origin){unknown=true;continue;}
      const sitemap=readServedSitemap(new TextDecoder('utf-8',{fatal:true}).decode(resource.body));
      for(const entry of sitemap.entries){if(sitemap.index)queue.push(entry.loc);else if(entry.loc===articleUrl){occurrences++;lastmod=entry.lastmod?.slice(0,100)??null;}}
    }catch{unknown=true;}
  }
  incomplete||=queue.some((u)=>!seen.has(u));const complete=!unknown&&!incomplete;const state:ObservationState=unknown?'unknown':!complete?'incomplete':occurrences===1?'verified':occurrences>1?'different':'pending';
  return {at,url:urls[0]??new URL('/sitemap.xml',articleUrl).toString(),state,complete,occurrences,lastmod,pagesRead:seen.size,detail:state==='verified'?'The served sitemap contains the exact article URL once.':state==='pending'?'The article is live but its URL is not in the completely observed sitemap.':state==='different'?'The served sitemap contains duplicate article URLs.':'The sitemap traversal could not be completed; missing URLs are not treated as absent.'};
}
export async function observeWebsiteDelivery(transport:FetchTransport,input:{url:string;marker:string;indexUrl:string;categoryUrls:readonly string[];sitemapUrls:readonly string[];at:string;pagination?:ArchivePagination;seoHead?:boolean}):Promise<WebsiteDeliveryEvidence> {
  const article=await observeArticle(transport,input.url,input.marker,input.at,input.categoryUrls,input.seoHead??false);
  const [index,categories,sitemap]=await Promise.all([observeMembership(transport,input.indexUrl,input.url,input.at,10,input.pagination),Promise.all(input.categoryUrls.map((u)=>observeMembership(transport,u,input.url,input.at,10,input.pagination))),observeSitemap(transport,input.sitemapUrls,input.url,input.at)]);
  return {article,index,categories:categories.map((c)=>c.state==='verified'&&!article.linkedCategoryUrls?.includes(c.url)?{...c,state:'pending',detail:'The category archive links to the article, but its reviewed category link has not been verified on the article.'}:c),sitemap};
}

/** Update only the named engine-owned URL blocks; retain every unrelated byte and timestamp. */
export function mergeOwnedSitemap(xml:string,owned:readonly {loc:string;lastmod:string}[],removeOwned:readonly string[]=[]):string {
  const parsed=parseSitemapXml(xml);if(parsed.index)throw new Error('Repair of a sitemap index is unsupported.');
  const pending=new Map(owned.map((entry)=>[entry.loc,entry]));const written=new Set<string>();const edits:{start:number;end:number;text:string}[]=[];
  for(const entry of parsed.entries){
    if(removeOwned.includes(entry.loc)){edits.push({start:entry.node.start,end:entry.node.end,text:''});continue;}
    const next=pending.get(entry.loc);if(!next)continue;if(written.has(entry.loc)){edits.push({start:entry.node.start,end:entry.node.end,text:''});continue;}written.add(entry.loc);
    const lastmod=entry.lastmodNode;
    if(lastmod){const open=xml.slice(lastmod.start,lastmod.openEnd).replace(/\/>$/,'>');const close=lastmod.selfClosing?`</${lastmod.qname}>`:xml.slice(lastmod.closeStart,lastmod.end);edits.push({start:lastmod.start,end:lastmod.end,text:open+escapeXml(next.lastmod)+close});}
    else{const prefix=entry.node.qname.includes(':')?entry.node.qname.split(':')[0]+':':'';edits.push({start:entry.node.closeStart,end:entry.node.closeStart,text:`<${prefix}lastmod>${escapeXml(next.lastmod)}</${prefix}lastmod>`});}
  }
  const prefix=parsed.root.qname.includes(':')?parsed.root.qname.split(':')[0]+':':'';
  const added=owned.filter((entry)=>!written.has(entry.loc)&&!removeOwned.includes(entry.loc)).map((entry)=>`<${prefix}url><${prefix}loc>${escapeXml(entry.loc)}</${prefix}loc><${prefix}lastmod>${escapeXml(entry.lastmod)}</${prefix}lastmod></${prefix}url>\n`).join('');
  if(added){if(parsed.root.selfClosing)edits.push({start:parsed.root.openEnd-2,end:parsed.root.openEnd,text:`>${added}</${parsed.root.qname}>`});else edits.push({start:parsed.root.closeStart,end:parsed.root.closeStart,text:added});}
  let result=xml;for(const edit of edits.sort((a,b)=>b.start-a.start||b.end-a.end))result=result.slice(0,edit.start)+edit.text+result.slice(edit.end);
  parseSitemapXml(result);return result;
}
