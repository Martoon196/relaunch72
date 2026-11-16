/** Unmounted native media checkout/webhook adapter. No provisioning at import. */
import {createHash} from 'node:crypto';
import type Stripe from 'stripe';
import type {Pool} from 'pg';
import {withTransaction} from '../db/transaction.js';
import type {PgSeoBlogPrincipal} from '../seo-blog/pg-store.js';
import {SeoBlogError} from '../seo-blog/types.js';
import {checkedEditId} from './media-edit-plan.js';
import type {MediaTier} from './media-access-pg-store.js';
const id=(v:unknown):string|null=>typeof v==='string'?v:v&&typeof v==='object'&&'id' in v&&typeof v.id==='string'?v.id:null;
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export interface MediaBillingIntent {intentId:string;workspaceId:string;tier:MediaTier;priceId:string;livemode:boolean}
export interface VerifiedMediaBillingReceipt {eventId:string;eventSha256:string;eventCreated:number;subscriptionId:string;customerId:string;priceId:string;livemode:boolean;activePaid:boolean;periodEnd:string;intentId:string|null;checkoutSessionId:string|null;checkoutVerified:boolean}
export function billingOrigin(raw:string):string{
 let u:URL;try{u=new URL(raw);}catch{throw new SeoBlogError(503,'Media billing origin unconfigured');}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||u.pathname!=='/'||!/^([a-z0-9-]+\.)+[a-z]{2,}$/u.test(u.hostname))throw new SeoBlogError(503,'Media billing requires its reviewed HTTPS origin');
 return u.origin;
}
export async function createMediaSubscriptionCheckout(input:{workspaceId:string;commandId:string;tier:MediaTier;origin:string},ports:{intent:(ws:string,command:string,tier:MediaTier)=>Promise<MediaBillingIntent>;create:Stripe['checkout']['sessions']['create'];bind:(ws:string,command:string,session:string)=>Promise<void>}){
 const request=Object.freeze({...input});checkedEditId(request.workspaceId);checkedEditId(request.commandId);const origin=billingOrigin(request.origin);
 const intent=await ports.intent(request.workspaceId,request.commandId,request.tier);
 if(intent.intentId!==request.commandId||intent.workspaceId!==request.workspaceId||intent.tier!==request.tier||!/^price_[A-Za-z0-9]+$/u.test(intent.priceId))throw new SeoBlogError(409,'Operator-priced owner checkout intent mismatch');
 const session=await ports.create({mode:'subscription',client_reference_id:intent.intentId,line_items:[{price:intent.priceId,quantity:1}],
  success_url:origin+'/portal/media/billing?checkout=returned',cancel_url:origin+'/portal/media/billing',
  metadata:{schema:'rl72-media-v1',intent_id:intent.intentId}}, {idempotencyKey:'rl72-media:'+intent.workspaceId+':'+intent.intentId});
 if(session.livemode!==intent.livemode||!session.url||new URL(session.url).origin!=='https://checkout.stripe.com')throw new SeoBlogError(409,'Stripe checkout receipt mismatch');
 await ports.bind(intent.workspaceId,intent.intentId,session.id);
 return {url:session.url,sessionId:session.id};
}
export class PgMediaBillingOwner {
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal,private readonly env:NodeJS.ProcessEnv=process.env){}
 private async command<T>(ws:string,run:(t:import('../db/transaction.js').DbTransaction,hash:Buffer)=>Promise<T>):Promise<T>{
  if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_BILLING_ENABLED!=='true')throw new SeoBlogError(503,'Media billing disabled');
  const p=this.principal;if(p.kind!=='user')throw new SeoBlogError(403,'Signed-in media owner required');
  const hash=createHash('sha256').update(p.sessionToken).digest();
  return withTransaction(this.pool,{actorKind:'user',workspaceId:checkedEditId(ws),userId:p.userId,requestId:p.requestId,portalSessionTokenHash:hash},t=>run(t,hash));
 }
 intent(ws:string,command:string,tier:MediaTier):Promise<MediaBillingIntent>{checkedEditId(command);return this.command(ws,async(t,hash)=>(await t.query<{v:MediaBillingIntent}>('SELECT app_private.creative_media_checkout_intent($1,$2,$3,$4) AS v',[ws,hash,command,tier])).rows[0]!.v);}
 bind(ws:string,command:string,session:string):Promise<void>{checkedEditId(command);return this.command(ws,async(t,hash)=>{await t.query('SELECT app_private.creative_media_checkout_bind($1,$2,$3,$4)',[ws,hash,command,session]);});}
}
/** Verify raw bytes using Stripe's SDK, then retrieve current subscription and invoice.
 * Caller wires this behind the canonical dedicated webhook identity, never owner SQL.
 */
export async function handleMediaBillingWebhook(raw:Buffer,signature:string,stripe:Pick<Stripe,'webhooks'|'checkout'|'subscriptions'>,ports:{record:(receipt:VerifiedMediaBillingReceipt)=>Promise<unknown>},env:NodeJS.ProcessEnv=process.env){
 if(env.CREATIVE_MEDIA!=='enabled'||env.RL72_MEDIA_BILLING_ENABLED!=='true'||!env.RL72_MEDIA_STRIPE_WEBHOOK_SECRET)throw new SeoBlogError(503,'Media billing webhook disabled');
 if(!Buffer.isBuffer(raw)||raw.length<2||raw.length>1000000||typeof signature!=='string'||signature.length>2048)throw new SeoBlogError(400,'Bounded raw Stripe webhook required');
 raw=Buffer.from(raw);
 let event:Stripe.Event;
 try{event=stripe.webhooks.constructEvent(raw,signature,env.RL72_MEDIA_STRIPE_WEBHOOK_SECRET,300);}catch{throw new SeoBlogError(400,'Invalid Stripe webhook signature');}
 const live=env.RL72_MEDIA_STRIPE_LIVEMODE==='true';
 if(event.livemode!==live||event.account)throw new SeoBlogError(400,'Unexpected Stripe account or mode');
 const allowed=['checkout.session.completed','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed'];
 if(!allowed.includes(event.type))return {state:'ignored'};
 const original=object(event.data.object);let subscriptionId:string|null=null,intentId:string|null=null,checkoutSessionId:string|null=null,checkoutVerified=false;
 if(event.type==='checkout.session.completed'){
  const session=await stripe.checkout.sessions.retrieve(String(original.id),{expand:['line_items']});
  if(session.mode!=='subscription'||session.status!=='complete'||session.payment_status!=='paid'||session.livemode!==live||session.metadata?.schema!=='rl72-media-v1'||session.client_reference_id!==session.metadata?.intent_id)throw new SeoBlogError(400,'Unverified media checkout');
  intentId=session.client_reference_id;checkedEditId(intentId??'');subscriptionId=id(session.subscription);checkoutSessionId=session.id;checkoutVerified=true;
 }else if(event.type.startsWith('customer.subscription.'))subscriptionId=id(original);
 else subscriptionId=id(object(object(original.parent).subscription_details).subscription)??id(original.subscription);
 if(!subscriptionId||!/^sub_[A-Za-z0-9]+$/u.test(subscriptionId))throw new SeoBlogError(400,'Subscription identity unavailable');
 const sub=await stripe.subscriptions.retrieve(subscriptionId,{expand:['latest_invoice']});
 const items=sub.items.data,invoice=typeof sub.latest_invoice==='object'?sub.latest_invoice:null;
 if(sub.id!==subscriptionId||sub.livemode!==live||items.length!==1||items[0]!.quantity!==1||!id(sub.customer))throw new SeoBlogError(400,'Unexpected media subscription shape');
 const item=items[0]!,end=item.current_period_end;
 if(!Number.isSafeInteger(end)||end<1)throw new SeoBlogError(400,'Verified subscription period required');
 const activePaid=sub.status==='active'&&invoice?.status==='paid'&&id(invoice.customer)===id(sub.customer)&&invoice.livemode===live;
 const receipt:VerifiedMediaBillingReceipt={eventId:event.id,eventSha256:createHash('sha256').update(raw).digest('hex'),eventCreated:event.created,subscriptionId,customerId:id(sub.customer)!,priceId:item.price.id,livemode:live,activePaid,periodEnd:new Date(end*1000).toISOString(),intentId,checkoutSessionId,checkoutVerified};
 return ports.record(receipt);
}
export class PgMediaBillingWebhook {
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly requestId:string){}
 async record(receipt:VerifiedMediaBillingReceipt){
  const reader='00000000-0000-4000-8000-000000000000';
  const ws=await withTransaction(this.pool,{actorKind:'webhook',workspaceId:reader,requestId:this.requestId},async t=>(await t.query<{ws:string|null}>('SELECT app_private.creative_media_billing_workspace($1,$2,$3) AS ws',[receipt.subscriptionId,receipt.intentId,receipt.livemode])).rows[0]?.ws);
  if(!ws)return {state:'unbound'};
  return withTransaction(this.pool,{actorKind:'webhook',workspaceId:ws,requestId:this.requestId},async t=>(await t.query<{v:unknown}>('SELECT app_private.creative_media_billing_receipt($1,$2) AS v',[ws,JSON.stringify(receipt)])).rows[0]!.v);
 }
}
