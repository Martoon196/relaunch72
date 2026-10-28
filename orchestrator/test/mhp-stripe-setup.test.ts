import test from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import { MHP_BRAND, MHP_PAID_CATALOG, MHP_ORIGIN, MHP_STRIPE_EVENTS } from '../src/mhp/catalog.js';
import { setupMhpStripe } from '../src/mhp/stripe-setup.js';

test('v3 setup keeps every gated link inactive and excludes manual Partnership', async () => {
  const products = MHP_PAID_CATALOG;
  const updates: {id:string;active:boolean}[] = [];
  const links = products.map(p => ({ id:`plink_${p.sku}`, livemode:false, active:p.availability==='gated', url:`https://buy.stripe.com/test_${p.sku}`,
    metadata:{brand:MHP_BRAND,sku:p.sku,terms_version:'3'}, allow_promotion_codes:false,billing_address_collection:'required',
    after_completion:{type:'redirect',redirect:{url:'https://martinhowardproperty.co.uk/thanks/'}} }));
  const price = (sku:string) => { const p=products.find(p=>p.sku===sku)!; return { id:`price_${sku}`,product:`${sku}_v3`,currency:'gbp',unit_amount:p.pricePence,livemode:false,recurring:p.interval?{interval:p.interval,interval_count:1}:null }; };
  const stripe = {
    accounts:{retrieve:async()=>({id:'acct_mhp'})},
    products:{retrieve:async(id:string)=>{const p=products.find(p=>id===`${p.sku}_v3`)!; assert.ok(p); return{id,livemode:false,metadata:{brand:MHP_BRAND,sku:p.sku}};}},
    prices:{list:async(args:{lookup_keys:string[]})=>({data:[price(args.lookup_keys[0]!.split(':').at(-1)!)],has_more:false})},
    paymentLinks:{list:()=>({autoPagingToArray:async()=>links}),update:async(id:string,args:{active:boolean})=>{updates.push({id,...args}); const link=links.find(l=>l.id===id)!; link.active=args.active; return link;},
      listLineItems:async(id:string)=>{const link=links.find(l=>l.id===id)!; return{data:[{price:price(link.metadata.sku),quantity:1}],has_more:false};}},
    webhookEndpoints:{list:async()=>({has_more:false,data:[{id:'we_mhp',url:`${MHP_ORIGIN}/api/stripe/webhook`,livemode:false,api_version:'2026-06-24.dahlia',enabled_events:MHP_STRIPE_EVENTS,status:'enabled'}]})},
    billingPortal:{configurations:{list:async()=>({has_more:false,data:[{id:'bpc_mhp',metadata:{brand:MHP_BRAND},features:{invoice_history:{enabled:true},subscription_cancel:{enabled:true}}}]})}},
  };
  const result=await setupMhpStripe(stripe as unknown as Stripe,'acct_mhp',false,true);
  assert.equal(result.links.length,12);
  assert.equal(result.links.filter(l=>l.active).length,6);
  assert.equal(result.links.filter(l=>l.availability==='gated').every(l=>!l.active),true);
  assert.equal(updates.filter(u=>u.active).length,6);
  assert.equal(updates.filter(u=>!u.active).length,6);
  assert.equal('MHP_STRIPE_PRICE_PARTNERSHIP' in result.environment,false);
});
