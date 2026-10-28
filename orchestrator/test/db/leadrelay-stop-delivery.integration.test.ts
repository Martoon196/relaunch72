import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { withTransaction } from '../../src/db/transaction.js';
import { PgLeadRelayStopDelivery } from '../../src/integrations/leadrelay/stop-delivery-pg.js';

const url = process.env.LEADRELAY_STOP_TEST_DATABASE_URL;
// This fixture builds minimal prerequisites in an EMPTY disposable LOCAL DB.
// It never shares the regular integration/production URL and never drops data.
test('LeadRelay frozen stop ledger: real PostgreSQL contracts and two-session claims', {skip: !url}, async t => {
  const parsed = new URL(url!);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.match(parsed.pathname, /^\/leadrelay_stop_fixture_[a-z0-9_]+$/);
  const admin = new Pool({connectionString: url});
  const workspace = randomUUID(), other = randomUUID(), lrWorkspace = randomUUID();
  const installation = 'pp-stop-test';
  let runtime: Pool | undefined;
  try {
    await admin.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r72_owner') THEN CREATE ROLE r72_owner NOLOGIN INHERIT; END IF; END$$;
      CREATE SCHEMA app AUTHORIZATION r72_owner;
      CREATE SCHEMA app_private AUTHORIZATION r72_owner;
      SET ROLE r72_owner;
      CREATE TABLE app.workspaces(id uuid PRIMARY KEY);
      CREATE TABLE app_private.workspace_table_registry(schema_name name,table_name name,workspace_column name,PRIMARY KEY(schema_name,table_name));
      CREATE TABLE app_private.external_event_shadow_receipts(
        workspace_id uuid, source text, event_id uuid, event_type text,
        event_version smallint, subject_id uuid, disposition text,
        event_payload jsonb, PRIMARY KEY(workspace_id,source,event_id));
      CREATE FUNCTION app_private.current_workspace_id() RETURNS uuid LANGUAGE sql AS
        $$SELECT nullif(current_setting('app.workspace_id',true),'')::uuid$$;
      CREATE FUNCTION app_private.current_actor_kind() RETURNS text LANGUAGE sql AS
        $$SELECT nullif(current_setting('app.actor_kind',true),'')$$;
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM PUBLIC;
      RESET ROLE;`);
    const sql = await readFile(new URL('../../src/db/migrations/0121_leadrelay_stop_delivery.sql',import.meta.url),'utf8');
    await admin.query(`BEGIN;${sql}COMMIT;`);
    runtime = new Pool({connectionString: url,options:'-c role=r72_leadrelay_stop_runtime'});
    const configured = {hqWorkspaceId:workspace,leadRelayWorkspaceId:lrWorkspace,installationId:installation,
      origin:'https://leadrelay.example.com',hookSecret:'test-only-'.repeat(5),purchaseProductKeys:['apex']};
    const context = {actorKind:'worker' as const,workspaceId:workspace,requestId:'stop-ledger-test'};
    await admin.query('INSERT INTO app.workspaces VALUES($1),($2)',[workspace,other]);
    await admin.query('INSERT INTO app_private.leadrelay_stop_targets VALUES($1,$2,$3,false)',[workspace,installation,lrWorkspace]);
    const seed = async () => {
      const id=randomUUID(),subject=randomUUID(),lead=randomUUID();
      const event={id,type:'commerce.purchase.completed',version:1,occurredAt:'2026-10-28T12:00:00.000Z',
        correlationId:randomUUID(),subject:{kind:'account',id:subject},data:{provider:'stripe',
          providerEventId:'evt_test',checkoutSessionId:'cs_test',productKey:'apex',billingKind:'one_off',amountMinor:4950,currency:'gbp'}};
      await admin.query(`INSERT INTO app_private.external_event_shadow_receipts VALUES($1,'property_predator',$2,$3,1,$4,'shadow',$5)`,[workspace,id,event.type,subject,event]);
      const binding=(await admin.query(`INSERT INTO app_private.leadrelay_stop_bindings(workspace_id,installation_id,source_subject_id,event_type,product_key,lead_id,stop_scope)
        VALUES($1,$2,$3,$4,'apex',$5,'all_sales_followup_for_lead') RETURNING id`,[workspace,installation,subject,event.type,lead])).rows[0].id as string;
      return {id,subject,lead,binding,event};
    };
    const prepare=async(id:string)=>withTransaction(runtime!,context,async c=>(await c.query('SELECT app_private.prepare_leadrelay_stop($1,$2,$3) AS value',[workspace,installation,id])).rows[0].value);
    const claim=async(limit=20)=>withTransaction(runtime!,context,async c=>(await c.query('SELECT * FROM app_private.claim_leadrelay_stops($1,$2,$3)',[workspace,installation,limit])).rows);
    const settle=async(id:string,token:string,result:string,duplicate:boolean|null=null)=>withTransaction(runtime!,context,async c=>(await c.query('SELECT app_private.settle_leadrelay_stop($1,$2,$3,$4,$5,$6,$7) AS value',[workspace,installation,id,token,result,duplicate,result==='delivered'?null:'test_hold'])).rows[0].value);

    await t.test('default inert controller does no SQL/HTTP; target disabled refuses preparation',async()=>{
      const item=await seed();
      const disabled=new PgLeadRelayStopDelivery({pool:{connect:async()=>{throw Error('must stay inert');}} as Pick<Pool,'connect'>,installation:configured,
        fetchImpl:async()=>{throw Error('must stay inert');}});
      assert.equal(await disabled.prepare(item.id),'disabled');assert.deepEqual(await disabled.deliverPrepared(),[]);
      assert.equal(await prepare(item.id),'target_disabled');
      await admin.query('UPDATE app_private.leadrelay_stop_targets SET enabled=true WHERE workspace_id=$1',[workspace]);
    });
    await t.test('function-only capability: cannot enumerate evidence/change mapping/spoof workspace',async()=>{
      await assert.rejects(runtime!.query('SELECT * FROM app_private.external_event_shadow_receipts'),/permission denied/);
      await assert.rejects(runtime!.query('SELECT * FROM app_private.leadrelay_stop_bindings'),/permission denied/);
      await assert.rejects(withTransaction(runtime!,context,c=>c.query('SELECT app_private.prepare_leadrelay_stop($1,$2,$3)',[other,installation,randomUUID()])),/Invalid stop delivery context/);
      await assert.rejects(withTransaction(runtime!,context,c=>c.query('SELECT * FROM app_private.claim_leadrelay_stops($1,$2,NULL)',[workspace,installation])),/Invalid stop delivery context/);
      const roles=await admin.query(`SELECT rolname,rolcanlogin FROM pg_roles WHERE rolname IN ('r72_leadrelay_stop_definer','r72_leadrelay_stop_runtime')`);
      assert.ok(roles.rows.every(row=>row.rolcanlogin===false));
      const ownerPool=new PgLeadRelayStopDelivery({pool:admin,installation:configured,enabled:true});
      await assert.rejects(ownerPool.prepare(randomUUID()),/Dedicated stop-delivery database capability required/);
    });
    await t.test('explicit selected canonical event, duplicate preparation, frozen mapping and payload',async()=>{
      const item=await seed();assert.equal(await prepare(randomUUID()),'canonical_event_required');
      assert.equal(await prepare(item.id),'prepared');assert.equal(await prepare(item.id),'prepared');
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM app_private.leadrelay_stop_deliveries WHERE source_event_id=$1',[item.id])).rows[0].n,1);
      await assert.rejects(admin.query('UPDATE app_private.leadrelay_stop_bindings SET lead_id=$1 WHERE id=$2',[randomUUID(),item.binding]),/immutable/);
      await assert.rejects(admin.query(`UPDATE app_private.leadrelay_stop_deliveries SET canonical_payload='{}' WHERE source_event_id=$1`,[item.id]),/immutable/);
      // Corrupting a fixture's source row cannot rewrite already-frozen intent.
      await admin.query(`UPDATE app_private.external_event_shadow_receipts SET event_payload=jsonb_set(event_payload,'{data,amountMinor}','999') WHERE event_id=$1`,[item.id]);
      await assert.rejects(prepare(item.id),/conflicts with frozen intent/);
      const [row]=await claim();assert.equal(row.source_event_id,item.id);
      assert.equal(await settle(item.id,randomUUID(),'delivered',false),false);
      assert.equal(await settle(item.id,row.claim_token,'delivered',false),true);
      assert.equal(await settle(item.id,row.claim_token,'delivered',false),false);
    });
    await t.test('20 earlier revoked rows cannot starve valid target before LIMIT; two sessions cannot double-claim',async()=>{
      for(let i=0;i<21;i++){
        const item=await seed();await prepare(item.id);
        if(i<20)await admin.query('UPDATE app_private.leadrelay_stop_bindings SET revoked_at=clock_timestamp() WHERE id=$1',[item.binding]);
      }
      const first=await runtime!.connect(),second=await runtime!.connect();
      try{
        for(const c of [first,second]){await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_kind','worker',true)",[workspace]);}
        const one=await first.query('SELECT * FROM app_private.claim_leadrelay_stops($1,$2,1)',[workspace,installation]);
        assert.equal(one.rows.length,1);
        const two=await second.query('SELECT * FROM app_private.claim_leadrelay_stops($1,$2,1)',[workspace,installation]);
        assert.equal(two.rows.length,0);await first.query('COMMIT');await second.query('COMMIT');
        assert.equal(await settle(one.rows[0].source_event_id,one.rows[0].claim_token,'held'),true);
      }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');first.release();second.release();}
    });
    await t.test('per-target bounded backoff and stale processing hold without reclaim',async()=>{
      const item=await seed();await prepare(item.id);const [row]=await claim();
      assert.equal(await settle(item.id,row.claim_token,'deferred'),true);assert.deepEqual(await claim(),[]);
      await admin.query("UPDATE app_private.leadrelay_stop_deliveries SET retry_at=clock_timestamp()-interval '1 second' WHERE source_event_id=$1",[item.id]);
      const [retry]=await claim();assert.notEqual(retry.claim_token,row.claim_token);
      await admin.query("UPDATE app_private.leadrelay_stop_deliveries SET claimed_at=clock_timestamp()-interval '3 minutes' WHERE source_event_id=$1",[item.id]);
      assert.deepEqual(await claim(),[]);
      const stored=(await admin.query('SELECT state,reason_code FROM app_private.leadrelay_stop_deliveries WHERE source_event_id=$1',[item.id])).rows[0];
      assert.deepEqual(stored,{state:'held',reason_code:'stale_claim_reconcile'});
      assert.equal(await settle(item.id,retry.claim_token,'delivered',true),false);
    });
    await t.test('target disable or mapping revocation committed after claim blocks authorization',async()=>{
      const item=await seed();await prepare(item.id);const [row]=await claim();
      await admin.query('UPDATE app_private.leadrelay_stop_targets SET enabled=false WHERE workspace_id=$1',[workspace]);
      const authorize=()=>withTransaction(runtime!,context,async c=>(await c.query(
        'SELECT app_private.authorize_leadrelay_stop($1,$2,$3,$4) AS value',[workspace,installation,item.id,row.claim_token])).rows[0].value);
      assert.equal(await authorize(),false);
      await admin.query('UPDATE app_private.leadrelay_stop_targets SET enabled=true WHERE workspace_id=$1',[workspace]);
      await admin.query('UPDATE app_private.leadrelay_stop_bindings SET revoked_at=clock_timestamp() WHERE id=$1',[item.binding]);
      assert.equal(await authorize(),false);assert.equal(await settle(item.id,row.claim_token,'held'),true);
    });
    await t.test('two-session authorization locks survive until accepted receipt settlement',async()=>{
      const item=await seed();await prepare(item.id);const [row]=await claim();
      const first=await runtime!.connect(),second=await admin.connect();
      try{
        await first.query('BEGIN');await first.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_kind','worker',true)",[workspace]);
        assert.equal((await first.query('SELECT app_private.authorize_leadrelay_stop($1,$2,$3,$4) AS value',[workspace,installation,item.id,row.claim_token])).rows[0].value,true);
        await second.query('BEGIN');await second.query("SET LOCAL lock_timeout='60ms'");
        await assert.rejects(second.query('UPDATE app_private.leadrelay_stop_targets SET enabled=false WHERE workspace_id=$1',[workspace]),/lock timeout/);
        await second.query('ROLLBACK');
        assert.equal((await first.query("SELECT app_private.settle_leadrelay_stop($1,$2,$3,$4,'delivered',false,NULL) AS value",[workspace,installation,item.id,row.claim_token])).rows[0].value,true);
        await first.query('COMMIT');
        await second.query('UPDATE app_private.leadrelay_stop_targets SET enabled=false WHERE workspace_id=$1',[workspace]);
        assert.equal((await admin.query('SELECT state FROM app_private.leadrelay_stop_deliveries WHERE source_event_id=$1',[item.id])).rows[0].state,'delivered');
        await second.query('UPDATE app_private.leadrelay_stop_targets SET enabled=true WHERE workspace_id=$1',[workspace]);
      }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');first.release();second.release();}
    });
    await t.test('accepted-but-unknown HTTP holds; explicit reconciliation preserves body/id then confirms duplicate',async()=>{
      const item=await seed(),bodies:string[]=[];
      const unknown=new PgLeadRelayStopDelivery({pool:runtime!,installation:configured,enabled:true,
        fetchImpl:async(_url,init)=>{bodies.push(init.body);throw Error('response lost after acceptance');}});
      assert.equal(await unknown.prepare(item.id),'prepared');
      const outcome=await unknown.deliverPrepared();assert.equal(outcome[0]?.reason,'stop_outcome_unknown');
      assert.deepEqual(await unknown.deliverPrepared(),[]);assert.equal(bodies.length,1);
      // Only owner fixture reconciliation can release this held exact intent.
      await admin.query("UPDATE app_private.leadrelay_stop_deliveries SET state='queued',retry_at=clock_timestamp() WHERE source_event_id=$1",[item.id]);
      const recovered=new PgLeadRelayStopDelivery({pool:runtime!,installation:configured,enabled:true,
        fetchImpl:async(_url,init)=>{bodies.push(init.body);return new Response(JSON.stringify({ok:true,duplicate:true}),{headers:{'content-type':'application/json'}});}});
      assert.equal((await recovered.deliverPrepared())[0]?.disposition,'delivered');
      assert.equal(bodies[0],bodies[1]);assert.deepEqual(await recovered.deliverPrepared(),[]);
    });
  }finally{await runtime?.end();await admin.end();}
});
