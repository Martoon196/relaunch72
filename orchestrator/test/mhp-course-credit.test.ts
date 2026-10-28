import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import type { Pool } from 'pg';
import { MHP_BRAND, MHP_ORIGIN } from '../src/mhp/catalog.js';
import type { MhpCommerceConfig } from '../src/mhp/commerce-config.js';
import { PgMhpCommerceService } from '../src/mhp/commerce-service.js';

const config: MhpCommerceConfig = {secretKey:'rk_test_fixture',accountId:'acct_mhp',webhookSecret:'whsec_test',live:false,
  portalConfigurationId:'bpc_mhp',prices:{mhp_course:'price_course',mhp_deal_desk:'price_desk'}};
const command='12000000-0000-4000-8000-000000000001';
const actor='12000000-0000-4000-8000-000000000002';
const sdk=new Stripe('rk_test_fixture');
function fixture() {
 const now=Math.floor(Date.now()/1000)*1000;
 const calls:{sql:string;args:unknown[]}[]=[]; const operations:string[]=[];
 const plan={id:command,creditId:'12000000-0000-4000-8000-000000000003',actorId:actor,sourcePurchaseId:'12000000-0000-4000-8000-000000000004',
  accountId:'acct_mhp',live:false,customerId:'cus_buyer',email:'buyer@example.invalid',cataloguePriceId:'price_course',productId:'mhp_course_v3',amountPence:145000,
  expiresAt:new Date(now+1860000).toISOString(),sessionId:null as string|null,url:null as string|null,status:'creating'};
 let created:Stripe.Checkout.Session|undefined;
 let params:Stripe.Checkout.SessionCreateParams|undefined;
 let availablePlan=true;
 const metadata={brand:MHP_BRAND,sku:'mhp_course',mhp_credit_attempt:command,mhp_account:actor};
 const price={id:'price_course',active:true,livemode:false,currency:'gbp',unit_amount:149700,type:'one_time',product:{id:'mhp_course_v3',deleted:false,metadata:{brand:MHP_BRAND,sku:'mhp_course'}}};
 const intent={id:'pi_credit',status:'succeeded',livemode:false,currency:'gbp',amount_received:145000,latest_charge:'ch_credit',customer:'cus_buyer',metadata:{...metadata}};
 const stripe={
  webhooks:sdk.webhooks,accounts:{retrieve:async()=>({id:'acct_mhp'})},prices:{retrieve:async()=>price},
  checkout:{sessions:{
   list:async()=>({data:created?[created]:[],has_more:false}),
   create:async(p:Stripe.Checkout.SessionCreateParams,opts:{idempotencyKey:string})=>{
    operations.push('create'); params=p; assert.equal(opts.idempotencyKey,`mhp-course-credit:${command}`);
    created={id:'cs_test_credit',livemode:false,status:'open',payment_status:'unpaid',customer:'cus_buyer',customer_details:{email:'buyer@example.invalid'},
     mode:'payment',currency:'gbp',amount_total:145000,metadata:{...metadata},client_reference_id:command,expires_at:now/1000+1860,
     url:'https://checkout.stripe.com/c/pay/test',subscription:null,payment_intent:'pi_credit',total_details:{amount_discount:0,amount_tax:0,amount_shipping:0}} as unknown as Stripe.Checkout.Session;
    return created;
   },
   retrieve:async()=>{assert.ok(created);return created;},
   expire:async()=>{operations.push('expire');assert.ok(created);created={...created,status:'expired',url:null};return created;},
   listLineItems:async()=>({data:[{price:{id:'price_dynamic',product:'mhp_course_v3',unit_amount:145000,currency:'gbp'},quantity:1,amount_total:145000}],has_more:false}),
  }},
  invoices:{retrieve:async()=>({id:'in_credit',parent:null})},
  invoicePayments:{list:async()=>({data:[{payment:{type:'payment_intent',payment_intent:'pi_credit'}}],has_more:false})},
  paymentIntents:{retrieve:async()=>intent},
  charges:{retrieve:async()=>({id:'ch_credit',paid:true,livemode:false,currency:'gbp',amount:145000,amount_refunded:0,created:now/1000+60})},
  refunds:{create:async()=>{operations.push('refund');return{id:'re_desk'};}},
 };
 const pool={query:async(sql:string,args:unknown[]=[])=>{
  calls.push({sql,args});
  if(sql.includes('mhp_begin_course_checkout')) return {rows:[{plan:{...plan}}]};
  if(sql.includes('mhp_credit_evidence')) return {rows:[{plan:availablePlan?{...plan}:null}]};
  if(sql.includes('mhp_record_credit_checkout')) {plan.sessionId=String(args[2]);plan.url=args[3] as string|null;plan.status=String(args[4]);}
  if(sql.includes('mhp_credit_refund_checkouts')) return {rows:[{plans:[{...plan}]}]};
  if(sql.includes('mhp_begin_refund')) return {rows:[{plan:{purchaseId:plan.sourcePurchaseId,accountId:'acct_mhp',live:false,sessionId:'cs_test_desk',customerId:'cus_buyer',sku:'mhp_deal_desk',subscriptionId:null,scheduleId:null,refunded:false,payments:[{chargeId:'ch_desk',amount:4700,refunded:0}]}}]};
  return {rows:[]};
 }} as unknown as Pick<Pool,'query'>;
 const service=new PgMhpCommerceService(pool,pool,pool,stripe as unknown as Stripe,config,()=>now);
 const signed=(type='checkout.session.completed')=>{const body=Buffer.from(JSON.stringify({id:'evt_credit',livemode:false,type,data:{object:{id:type==='invoice.paid'?'in_credit':'cs_test_credit'}}}));
  return {body,signature:sdk.webhooks.generateTestHeaderString({payload:body.toString(),secret:config.webhookSecret})};};
 return {service,stripe,plan,price,intent,calls,operations,signed,getParams:()=>params,getSession:()=>created!,setSession:(s:Stripe.Checkout.Session)=>{created=s;},denyPlan:()=>{availablePlan=false;}};
}

test('course checkout redeems only the bound £47 credit and preserves the full-price catalogue',async()=>{
 const f=fixture(); assert.equal(await f.service.courseCheckout('verified-session',command),'https://checkout.stripe.com/c/pay/test');
 const p=f.getParams()!;
 assert.deepEqual(p.line_items,[{price_data:{product:'mhp_course_v3',currency:'gbp',unit_amount:145000},quantity:1}]);
 assert.equal(p.customer,'cus_buyer');assert.equal(p.allow_promotion_codes,false);assert.deepEqual(p.payment_method_types,['card']);
 assert.equal(p.success_url,`${MHP_ORIGIN}/app/account?course=received`);assert.equal(p.metadata?.mhp_account,actor);
 assert.equal(p.payment_intent_data?.metadata?.mhp_credit_attempt,command);
 assert.equal(f.price.unit_amount,149700);assert.equal(f.calls[0]!.args[0] instanceof Buffer,true);
 await f.service.courseCheckout('verified-session',command);
 assert.deepEqual(f.operations,['create']);
});
test('foreign account or altered catalogue price is refused before reserving credit',async()=>{
 const f=fixture();f.stripe.accounts.retrieve=async()=>({id:'acct_wrong'});
 await assert.rejects(f.service.courseCheckout('verified',command));assert.equal(f.calls.length,0);
 const g=fixture();g.price.unit_amount=99700;
 await assert.rejects(g.service.courseCheckout('verified',command));assert.equal(g.calls.length,0);
});
test('completed checkout is bound to customer, payment-intent metadata and database reservation',async()=>{
 const f=fixture();await f.service.courseCheckout('verified',command);f.setSession({...f.getSession(),status:'complete',payment_status:'paid'});
 const event=f.signed();await f.service.webhook(event.body,event.signature);
 const write=f.calls.find(c=>c.sql.includes('record_mhp_commerce_event'))!;
 const evidence=JSON.parse(String(write.args[4]));assert.equal(evidence.sku,'mhp_course');assert.equal(evidence.creditAttemptId,command);assert.equal(evidence.payments[0].amount,145000);
 const before=f.calls.filter(c=>c.sql.includes('record_mhp_commerce_event')).length;
 f.intent.metadata.mhp_account='another-person';
 await assert.rejects(f.service.webhook(event.body,event.signature));
 assert.equal(f.calls.filter(c=>c.sql.includes('record_mhp_commerce_event')).length,before);
});
test('arbitrary discounted checkout cannot fabricate a credit or a paid entitlement',async()=>{
 const f=fixture();await f.service.courseCheckout('verified',command);f.setSession({...f.getSession(),status:'complete',payment_status:'paid'});f.denyPlan();
 const e=f.signed();await assert.rejects(f.service.webhook(e.body,e.signature));assert.ok(!f.calls.some(c=>c.sql.includes('record_mhp_commerce_event')));
});
test('credit receipt refuses changed product, customer and payment after checkout deadline',async()=>{
 for(const change of ['product','customer','deadline']){
  const f=fixture();await f.service.courseCheckout('verified',command);f.setSession({...f.getSession(),status:'complete',payment_status:'paid'});
  if(change==='product')f.stripe.checkout.sessions.listLineItems=async()=>({data:[{price:{id:'price_dynamic',product:'another_product',unit_amount:145000,currency:'gbp'},quantity:1,amount_total:145000}],has_more:false});
  if(change==='customer')f.setSession({...f.getSession(),customer:'cus_intruder'});
  if(change==='deadline'){const prior=f.stripe.charges.retrieve;f.stripe.charges.retrieve=async()=>({...await prior(),created:Math.floor(Date.parse(f.plan.expiresAt)/1000)+1});}
  const e=f.signed();await assert.rejects(f.service.webhook(e.body,e.signature));assert.ok(!f.calls.some(c=>c.sql.includes('record_mhp_commerce_event')));
 }
});
test('a network-orphaned checkout is recovered by its immutable attempt metadata',async()=>{
 const f=fixture();await f.service.courseCheckout('verified',command);f.plan.sessionId=null;f.plan.status='creating';
 await f.service.courseCheckout('verified',command);assert.deepEqual(f.operations,['create']);
});
test('Desk refund closes a reserved course checkout before refunding the Desk',async()=>{
 const f=fixture();await f.service.courseCheckout('verified',command);
 f.stripe.charges.retrieve=async()=>({id:'ch_desk',paid:true,livemode:false,currency:'gbp',amount:4700,amount_refunded:0,created:Math.floor(Date.now()/1000)});
 await f.service.refund('verified',f.plan.sourcePurchaseId);
 assert.deepEqual(f.operations,['create','expire','refund']);assert.equal(f.plan.status,'expired');
});
test('Desk refund leaves an already paid course intact without a replacement charge',async()=>{
 const f=fixture();await f.service.courseCheckout('verified',command);f.setSession({...f.getSession(),status:'complete',payment_status:'paid',url:null});
 f.stripe.charges.retrieve=async()=>({id:'ch_desk',paid:true,livemode:false,currency:'gbp',amount:4700,amount_refunded:0,created:Math.floor(Date.now()/1000)});
 await f.service.refund('verified',f.plan.sourcePurchaseId);
 assert.deepEqual(f.operations,['create','refund']);assert.equal(f.plan.status,'complete');
});
test('expired session releases its exact reservation and never returns a stale pay URL',async()=>{
 const f=fixture();await f.service.courseCheckout('verified',command);f.setSession({...f.getSession(),status:'expired',url:null});
 await assert.rejects(f.service.courseCheckout('verified',command));assert.equal(f.plan.status,'expired');assert.equal(f.operations.length,1);
});

test('one-off course invoice.paid resolves its Checkout through the paid payment intent',async()=>{
 const f=fixture();await f.service.courseCheckout('verified',command);f.setSession({...f.getSession(),status:'complete',payment_status:'paid'});
 const e=f.signed('invoice.paid');await f.service.webhook(e.body,e.signature);
 const receipt=f.calls.find(c=>c.sql.includes('record_mhp_commerce_event'))!;
 assert.equal(receipt.args[2],'invoice.paid');assert.equal(JSON.parse(String(receipt.args[4])).creditAttemptId,command);
});
