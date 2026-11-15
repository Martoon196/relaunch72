/**
 * Native, server-rendered affiliate product catalogue in the existing
 * Creative Studio. All proposed links are private and unapproved by merchants.
 * Every form preserves the same SEO Blog CSRF and owner-session boundary.
 */
import type { AffiliateMediaProductRecord } from '../creative-studio/media-product-pg-store.js';
import { csrfField, layout, type Shell } from './seo-blog-view.js';
import { base, STYLE } from './creative-studio-view.js';

const e=(value:unknown):string=>String(value??'').replace(/[&<>"']/gu,
  (c)=>({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));
const selected=(actual:string,value:string):string=>actual===value?' selected':'';
const checked=(value:boolean):string=>value?' checked':'';
const linkLabel=(url:string):string=>{
  try{return new URL(url).hostname;}catch{return 'Unverified link';}
};

function productForm(shell:Shell, commandId:string, p?:AffiliateMediaProductRecord):string {
  const isEdit=Boolean(p), original=base(shell)+'/products';
  const rights=p?.source_rights??'none',network=p?.network??'amazon_associates';
  return '<form method="post" action="'+original+'" class="cs-form">'+csrfField(shell.csrf)
    +'<input type="hidden" name="commandId" value="'+e(commandId)+'">'
    +'<input type="hidden" name="productId" value="'+e(p?.product_id??'')+'">'
    +'<input type="hidden" name="expectedRevision" value="'+String(p?.revision??0)+'">'
    +'<fieldset><legend>'+ (isEdit?'Save a new revision':'Add a product')+'</legend>'
    +'<div class="row"><div><label for="media-name-'+e(p?.product_id??'new')+'">Product name</label>'
    +'<input id="media-name-'+e(p?.product_id??'new')+'" name="productName" required maxlength="200" value="'+e(p?.product_name??'')+'"></div>'
    +'<div><label>Merchant</label><input name="merchantName" maxlength="140" required value="'+e(p?.merchant_name??'')+'"></div></div>'
    +'<label>Affiliate programme</label><select name="network">'
    +'<option value="amazon_associates"'+selected(network,'amazon_associates')+'>Amazon Associates</option>'
    +'<option value="other"'+selected(network,'other')+'>Other programme</option></select>'
    +'<label>Public product URL (independent verification needed)</label>'
    +'<input type="url" required name="productUrl" maxlength="2048" placeholder="https://..." value="'+e(p?.product_url??'')+'">'
    +'<label>Proposed affiliate URL (private until programme approval)</label>'
    +'<input type="url" name="affiliateUrl" maxlength="2048" placeholder="https://..." value="'+e(p?.proposed_affiliate_url??'')+'">'
    +'<label>Source material rights</label><select name="sourceRights">'
    +['none','original','owned','licensed'].map((r)=>'<option value="'+r+'"'+selected(rights,r)+'>'+({none:'No source footage yet',original:'Original media being created',owned:'I own this footage',licensed:'Licensed third-party footage'} as Record<string,string>)[r]+'</option>').join('')
    +'</select>'
    +'<label>Licence evidence SHA-256 (required for licensed source, not a licence itself)</label>'
    +'<input name="evidenceSha256" maxlength="64" pattern="[a-f0-9]{64}" value="'+e(p?.evidence_sha256??'')+'">'
    +'<label>Creative-kit disclosure version</label>'
    +'<input name="disclosureVersion" maxlength="60" required value="'+e(p?.disclosure_version??'draft')+'">'
    +'<div class="stack"><label><input type="checkbox" name="productReviewed" value="1"'+checked(p?.owner_product_reviewed??false)+'> I checked the merchant and product facts myself</label>'
    +'<label><input type="checkbox" name="channelEligible" value="1"'+checked(p?.owner_channel_eligible??false)+'> I checked that the intended site/channel is eligible for this programme</label>'
    +'<label><input type="checkbox" name="mediaRightsConfirmed" value="1"'+checked(p?.owner_media_rights_confirmed??false)+'> I have permission for all media actually used</label></div>'
    +'<button type="submit">'+(isEdit?'Save new immutable revision':'Save private product draft')+'</button>'
    +'</fieldset></form>';
}

export function creativeMediaProductsPage(shell:Shell, products:readonly AffiliateMediaProductRecord[],
  newCommandId:string,editCommandId:()=>string):string {
  const items=products.map((p)=>'<details class="card"><summary><strong>'+e(p.product_name)+'</strong>'
    +' · '+e(p.merchant_name)+' <span class="pill warn">Owner proposal · v'+String(p.revision)+'</span></summary>'
    +'<p class="small muted">Network: '+e(p.network)+' · Rights: '+e(p.source_rights)
    +' · Eligibility confirmed by owner: '+(p.owner_channel_eligible?'yes':'no')+'</p>'
    +'<p class="small muted">Product link: '+e(linkLabel(p.product_url))
    +' · Affiliate proposal: '+(p.proposed_affiliate_url?e(linkLabel(p.proposed_affiliate_url)):'none')+'</p>'
    +productForm(shell,editCommandId(),p)+'</details>').join('');
  const notice='<section class="card"><h2>Private affiliate catalogue</h2>'
    +'<p class="muted">Save candidate products and the evidence you have reviewed. Every change creates a new revision. '
    +'These are your statements, not an Amazon approval, a verified Special Link or a sales report.</p>'
    +'<p class="muted">The links are saved privately and are never automatically sent to a social account, '
    +'used in an advert or converted into affiliate commission claims.</p>'
    +'<p><a href="'+base(shell)+'">Back to Creative Studio</a></p></section>';
  return layout(shell,'Affiliate products',STYLE+notice+'<section class="card"><h2>New product</h2>'
    +productForm(shell,newCommandId)+'</section>'
    +'<section><h2>Saved products ('+String(products.length)+')</h2>'
    +(items||'<p class="muted">No products saved. Add a product to begin.</p>')+'</section>');
}
