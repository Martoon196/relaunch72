/** Function-only method persistence, bound to the same principal as the blog engine. */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, type DbTransaction } from '../db/transaction.js';
import type { PgSeoBlogPrincipal } from './pg-store.js';
import type { MethodAssignment, MethodPin, MethodReceipt, MethodSnapshot, MethodStore } from './method-packs.js';
import { methodError } from './method-packs.js';

export class PgMethodStore implements MethodStore {
  private readonly sessionHash:Buffer|null;
  constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal){
    this.sessionHash=principal.kind==='user'?createHash('sha256').update(principal.sessionToken).digest():null;
  }
  private tx<T>(brandId:string,fn:(t:DbTransaction)=>Promise<T>):Promise<T>{
    const p=this.principal;
    return withTransaction(this.pool,p.kind==='user'?{actorKind:'user',workspaceId:brandId,userId:p.userId,requestId:p.requestId}
      :{actorKind:'worker',workspaceId:brandId,requestId:p.requestId},async t=>{
        if(p.kind==='user'){
          const guard=await t.query<{ok:boolean}>('SELECT app_private.lock_active_portal_session($1,$2,$3) AS ok',[this.sessionHash,p.userId,p.selectedWorkspaceId]);
          if(guard.rows[0]?.ok!==true)return methodError('The owner session is no longer active.','method_session_inactive');
        }
        return fn(t);
      });
  }
  snapshot(brandId:string):Promise<MethodSnapshot>{
    return this.tx(brandId,async t=>(await t.query<{value:MethodSnapshot}>('SELECT app_private.seo_method_snapshot($1,$2) AS value',[brandId,this.sessionHash])).rows[0]!.value);
  }
  receipt(brandId:string,id:string):Promise<MethodReceipt|null>{
    return this.tx(brandId,async t=>(await t.query<{value:MethodReceipt|null}>('SELECT app_private.seo_method_receipt($1,$2,$3) AS value',[brandId,this.sessionHash,id])).rows[0]!.value);
  }
  async saveReceipt(receipt:MethodReceipt):Promise<void>{
    await this.tx(receipt.brandId,t=>t.query('SELECT app_private.seo_method_save_receipt($1,$2,$3)',[receipt.brandId,this.sessionHash,JSON.stringify(receipt)]));
  }
  assign(brandId:string,expectedRevision:number,pins:readonly MethodPin[]):Promise<number>{
    return this.tx(brandId,async t=>Number((await t.query<{revision:number}>('SELECT app_private.seo_method_assign($1,$2,$3,$4) AS revision',[brandId,this.sessionHash,expectedRevision,JSON.stringify(pins)])).rows[0]!.revision));
  }
}
/** Test/local implementation; never composed by production. */
export class MemoryMethodStore implements MethodStore {
  readonly snapshots=new Map<string,MethodSnapshot>();readonly receipts=new Map<string,MethodReceipt>();
  async snapshot(brandId:string):Promise<MethodSnapshot>{
    const s=this.snapshots.get(brandId);return structuredClone(s??{brandId,assignment:null,releases:[],tokensUsed:0});
  }
  async receipt(brandId:string,id:string):Promise<MethodReceipt|null>{
    const r=this.receipts.get(id);return r?.brandId===brandId?structuredClone(r):null;
  }
  async saveReceipt(r:MethodReceipt):Promise<void>{
    if(this.receipts.has(r.id))return methodError('Method receipt is immutable.');
    this.receipts.set(r.id,structuredClone(r));
  }
  async assign(brandId:string,expectedRevision:number,pins:readonly MethodPin[]):Promise<number>{
    const s=await this.snapshot(brandId);
    if((s.assignment?.revision??0)!==expectedRevision)return methodError('Method assignment changed.');
    const a:MethodAssignment={revision:expectedRevision+1,scope:'private-owned-brands',pins:structuredClone(pins)};
    this.snapshots.set(brandId,{...s,assignment:a});return a.revision;
  }
}
