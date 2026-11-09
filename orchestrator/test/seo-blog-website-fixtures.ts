import { randomUUID } from 'node:crypto';
import { harness,OWNER,seedBrandSite } from './seo-blog-fixtures.js';
import { websiteIdentity,websiteSha,type WebsiteCapabilities } from '../src/seo-blog/website-target.js';
export function websiteCaps(origin='https://bay.example',roots=['blog','investment-info']):WebsiteCapabilities {
  const base={contractVersion:2 as const,siteId:websiteIdentity('test-site',origin),publicOrigin:origin,roots:roots.map((root)=>({id:root,path:root,indexUrl:`${origin}/${root}`,articleUrlPattern:`${origin}/${root}/{slug}`,categoryUrlPattern:`${origin}/${root}/category/{slug}`})),taxonomy:{mode:'categories' as const,maxCategoriesPerArticle:5},sitemaps:[`${origin}/sitemap.xml`],updates:{preservePublishedUrl:true as const},repair:{sitemap:false}};
  return {...base,capabilitiesSha:websiteSha(base)};
}
export async function websiteFixture(type:'content_api'|'github_static'='content_api',initialRoot?:string,beforeWrite?:(h:ReturnType<typeof harness>,brandId:string,destinationId:string)=>Promise<void>) {
  const h=harness();const origin=type==='content_api'?'https://bay.example':'https://harbour.example';seedBrandSite(h.web,origin,'deposits');h.site.capabilities=websiteCaps();
  const {brand}=await h.engine.createBrand(OWNER,{commandId:randomUUID(),name:'Harbour',website:origin});
  await h.engine.updateSettings(OWNER,brand.id,brand.rowVersion,{budgets:{modelTokensPerMonth:2_000_000,searchCallsPerMonth:100,imagesPerMonth:0}});
  await h.engine.uploadKnowledge(OWNER,brand.id,{category:'product_facts',title:'Facts',pastedText:'Harbour Compliance Plan costs £49 per month.'});
  const profile=await h.engine.extractBrandProfile(OWNER,brand.id);await h.engine.confirmProfile(OWNER,brand.id,profile.version);
  const destination=await h.engine.connectDestination(OWNER,brand.id,type==='content_api'?{type,label:'Website',credential:'x'.repeat(40),config:{endpoint:`${origin}/api/blog/publish`,publicBaseUrl:origin,blogPath:'blog'}}:{type,label:'Website',credential:'gh-token-fixture',config:{repository:'acme/site',branch:'main',publicBaseUrl:origin,blogPath:'blog',sitemapPath:'sitemap.xml'}});
  const inventory=await h.engine.refreshInventory(brand.id);
  const initialStructure=initialRoot?await h.engine.approveEditorialStructure(OWNER,brand.id,{rowVersion:(await h.engine.getBrand(OWNER,brand.id)).rowVersion,scanId:inventory.editorial!.scanId,scanSha:inventory.editorial!.scanSha,destinationId:destination.id,root:initialRoot,categories:[{id:inventory.editorial!.categories[0]!.id,label:'Guides',slug:'guides'}]}):null;
  await h.engine.requestPlan(OWNER,brand.id,{commandId:randomUUID()});await h.engine.tick('fixture-plan');const [plan]=await h.engine.listPlans(OWNER,brand.id);await h.engine.acceptPlan(OWNER,brand.id,plan!.plan.id);await h.engine.requestArticles(OWNER,brand.id,[plan!.briefs[0]!.id]);if(beforeWrite)await beforeWrite(h,brand.id,destination.id);await h.engine.tick('fixture-write');
  const [detail]=await h.engine.listArticles(OWNER,brand.id);const articleId=detail!.article.id;
  const approveStructure=async(root='/blog',label='Guides',slug='guides',newCategoryAddresses=false)=>{
    const current=await h.engine.getBrand(OWNER,brand.id);const scan=(await h.engine.getInventory(OWNER,brand.id))!;
    return h.engine.approveEditorialStructure(OWNER,brand.id,{rowVersion:current.rowVersion,scanId:scan.editorial!.scanId,scanSha:scan.editorial!.scanSha,destinationId:destination.id,root,categories:[{id:scan.editorial!.categories[0]!.id,label,slug}],newCategoryAddresses});
  };
  return {h,brand,destination,inventory,articleId,approveStructure,initialStructure};
}
