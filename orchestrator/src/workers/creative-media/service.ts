/** Supervised single-concurrency offline service. Mounting/enablement belongs to Claude. */
import {setTimeout as delay} from 'node:timers/promises';
import type {Pool} from 'pg';
import {withTransaction} from '../../db/transaction.js';
export async function runMediaService(ports:{workspaces:(after:string|null)=>Promise<string[]>;tick:(workspace:string)=>Promise<unknown>;cleanup:(workspace:string)=>Promise<void>;clickRetention:()=>Promise<void>;onError:()=>void},options:{signal:AbortSignal;pollMs?:number}){
 const poll=options.pollMs??5000;if(!Number.isInteger(poll)||poll<1000||poll>60000)throw new Error('Bounded worker poll required');
 let after:string|null=null;
 while(!options.signal.aborted){
  try{
   const workspaces=await ports.workspaces(after);if(workspaces.length>10)throw new Error('Workspace batch exceeded');
   if(workspaces.length===0)after=null;
   for(const workspace of workspaces){if(options.signal.aborted)break;try{await ports.cleanup(workspace);await ports.tick(workspace);}catch{ports.onError();}after=workspace;}
   await ports.clickRetention();
  }catch{ports.onError();}
  await delay(poll,undefined,{signal:options.signal}).catch(()=>{});
 }
}
export class PgMediaServiceDiscovery{
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly requestId:string){}
 workspaces(after:string|null){return withTransaction(this.pool,{actorKind:'worker',workspaceId:'00000000-0000-4000-8000-000000000000',requestId:this.requestId},async t=>(await t.query<{workspace_id:string}>('SELECT * FROM app_private.creative_media_worker_workspaces($1)',[after])).rows.map(x=>x.workspace_id));}
 clickRetention(){return withTransaction(this.pool,{actorKind:'worker',workspaceId:'00000000-0000-4000-8000-000000000000',requestId:this.requestId},async t=>{await t.query('SELECT app_private.creative_media_click_retention()');});}
}
