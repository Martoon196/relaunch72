import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import type { PortalSessionIdentity } from '../../portal/auth-service.js';
import type { ApolloStore,CorporateCompany,Prospect,Usage } from './index.js';
export class PgApolloStore implements ApolloStore {
  constructor(private readonly pool:Pick<Pool,'connect'>,private readonly identity:PortalSessionIdentity,
    private readonly brandId:string,private readonly requestId:string){}
  private command<T>(action:string,p:unknown):Promise<T>{
    const i=this.identity,hash=createHash('sha256').update(i.sessionToken).digest();
    return withTransaction(this.pool,{actorKind:'user',userId:i.userId,workspaceId:this.brandId,requestId:this.requestId},async t=>{
      const session=await t.query<{ok:boolean}>('SELECT app_private.lock_active_portal_session($1,$2,$3) AS ok',[hash,i.userId,i.workspaceId]);
      if(session.rows[0]?.ok!==true)throw new Error('Apollo owner session inactive');
      return (await t.query<{value:T}>('SELECT app_private.apollo_command($1,$2,$3,$4) AS value',[this.brandId,hash,action,JSON.stringify(p)])).rows[0]!.value;
    });
  }
  usage():Promise<Usage>{return this.command('usage',{});}
  async seed(c:CorporateCompany):Promise<void>{await this.command('seed',c);}
  reserve(p:Parameters<ApolloStore['reserve']>[0]):Promise<{reserved:number}>{return this.command('reserve',p);}
  async settle(id:string,actual:number|null,blocked=false):Promise<void>{await this.command('settle',{id,actual,blocked});}
  async save(callId:string,record:Prospect):Promise<void>{await this.command('save',{callId,record});}
}
