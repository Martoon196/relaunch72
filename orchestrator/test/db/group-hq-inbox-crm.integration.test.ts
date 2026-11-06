import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Client,type Pool } from 'pg';
import { assertDisposableTestDatabase,testDatabaseSkipReason } from './database-helper.js';
import { GroupHqInboxCrmService,InboxCrmError,createInboxCrmRunner,type InboxCrmConfig } from '../../src/integrations/group-hq-crm/inbox.js';

test('owner inbox creates, links and records messages under real web/CRM roles without fake identities or cross-workspace writes',
  {skip:testDatabaseSkipReason()},async()=>{
    const url=process.env.TEST_DATABASE_URL!;
    assertDisposableTestDatabase(url);
    const seed=new Client({connectionString:url});await seed.connect();
    const org=randomUUID(),workspace=randomUUID(),foreignWorkspace=randomUUID(),owner=randomUUID(),pipeline=randomUUID(),stage=randomUUID();
    const suffix=randomUUID();
    const rolePool=(role:'r72_web'|'r72_crm_command')=>({async connect(){
      const c=new Client({connectionString:url});await c.connect();await c.query(`SET ROLE ${role}`);
      return {query:c.query.bind(c),release(){void c.end();}};
    }}) as unknown as Pick<Pool,'connect'>;
    try {
      await seed.query('SET ROLE r72_owner');
      await seed.query('INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,$2,$3,\'direct_customer\')',[org,'Inbox role proof','inbox-'+suffix]);
      await seed.query('INSERT INTO app.users(id,email,status) VALUES($1,$2,\'active\')',[owner,`inbox-${suffix}@example.test`]);
      await seed.query('INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$3,\'Inbox proof\',\'inbox-proof\'),($2,$3,\'Foreign proof\',\'foreign-proof\')',[workspace,foreignWorkspace,org]);
      await seed.query('INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,\'owner\',\'active\')',[org,owner]);
      await seed.query('INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES($1,$2,$3,\'owner\',\'active\')',[workspace,org,owner]);
      await seed.query('INSERT INTO app.pipelines(id,workspace_id,name,slug,is_default) VALUES($1,$2,\'Enquiries\',\'enquiries\',true)',[pipeline,workspace]);
      await seed.query('INSERT INTO app.pipeline_stages(id,workspace_id,pipeline_id,name,slug,position,stage_type) VALUES($1,$2,$3,\'New\',\'new\',1,\'open\')',[stage,workspace,pipeline]);
      const cfg:InboxCrmConfig={secret:'test-only-secret-'+'x'.repeat(32),scopes:{kp:{label:'Key Properties',workspaceId:workspace,
        organizationId:org,ownerUserId:owner,pipelineId:pipeline,stageId:stage,actorEmails:['owner@example.test']}}};
      const service=new GroupHqInboxCrmService(rolePool('r72_web'),createInboxCrmRunner(rolePool('r72_crm_command')),cfg);
      const source={channel:'facebook',accountId:'native-owner',participantId:'native-person-'+suffix,threadId:'native-thread-'+suffix};
      const input={requestId:randomUUID(),actorEmail:'owner@example.test',brand:'kp',source,displayName:'Durham role-test contact'};
      const created=await service.execute({...input,action:'create'}) as {contactId:string;opportunityId:string;createdContact:boolean;disposition:string};
      assert.equal(created.createdContact,true);
      const replay=await service.execute({...input,requestId:randomUUID(),action:'create'}) as typeof created;
      assert.equal(replay.contactId,created.contactId);assert.equal(replay.opportunityId,created.opportunityId);assert.equal(replay.disposition,'replayed');
      const concurrentInput={...input,action:'create',source:{...source,participantId:'race-person-'+suffix,threadId:'race-thread-'+suffix}};
      const raced=await Promise.all([service.execute({...concurrentInput,requestId:randomUUID()}),service.execute({...concurrentInput,requestId:randomUUID()})]) as typeof created[];
      assert.equal(raced[0]!.contactId,raced[1]!.contactId);assert.equal(raced[0]!.opportunityId,raced[1]!.opportunityId);
      assert.deepEqual(raced.map(r=>r.disposition).sort(),['applied','replayed']);
      const point=await seed.query('SELECT kind,is_verified,consent_status,value FROM app.contact_points WHERE workspace_id=$1 AND contact_id=$2',[workspace,created.contactId]);
      assert.equal(point.rows.length,1);assert.equal(point.rows[0].kind,'social');assert.equal(point.rows[0].is_verified,false);
      assert.equal(point.rows[0].consent_status,'unknown');assert.match(point.rows[0].value,/^facebook:ghq:[a-f0-9]{64}$/u);
      const linked=await service.execute({...input,action:'link',contactId:created.contactId}) as {activityId:string};
      const linkedReplay=await service.execute({...input,action:'link',contactId:created.contactId}) as typeof linked;
      assert.equal(linkedReplay.activityId,linked.activityId);
      const message={id:'native-message-'+suffix,body:'Requested property details',direction:'incoming',occurredAt:'2026-11-01T10:00:00Z'};
      const first=await service.execute({...input,action:'activity',contactId:created.contactId,message}) as {activityId:string};
      const second=await service.execute({...input,action:'activity',contactId:created.contactId,message}) as typeof first;
      assert.equal(first.activityId,second.activityId);
      await assert.rejects(service.execute({...input,action:'activity',contactId:created.contactId,message:{...message,body:'Changed evidence'}}),
        e=>e instanceof InboxCrmError&&e.code==='request_conflict');
      const foreignContact=randomUUID();
      await seed.query('INSERT INTO app.contacts(id,workspace_id,display_name) VALUES($1,$2,\'Other business\')',[foreignContact,foreignWorkspace]);
      await assert.rejects(service.execute({...input,action:'link',source:{...source,threadId:'foreign-link'},contactId:foreignContact}),
        e=>e instanceof InboxCrmError&&e.status===404);
      const activity=await seed.query('SELECT contact_id,channel,actor_user_id,metadata FROM app.activities WHERE id=$1',[first.activityId]);
      assert.equal(activity.rows[0].contact_id,created.contactId);assert.equal(activity.rows[0].channel,'social');
      assert.equal(activity.rows[0].actor_user_id,owner);assert.equal(activity.rows[0].metadata.providerEvidence,'connector_assertion');
      await seed.query('UPDATE app.workspace_memberships SET status=\'suspended\',updated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2',[workspace,owner]);
      await assert.rejects(service.execute({...input,action:'create',source:{...source,threadId:'after-revocation'}}),
        e=>e instanceof InboxCrmError&&e.status===403);
    } finally {
      try {
        await seed.query('SET ROLE r72_owner');
        for(const table of ['activities','opportunity_stage_history','tasks','opportunities','contact_points','contacts','command_receipts','outbox_events','pipeline_stages','pipelines','workspace_memberships'])
          await seed.query(`DELETE FROM app.${table} WHERE workspace_id=ANY($1::uuid[])`,[[workspace,foreignWorkspace]]);
        await seed.query('DELETE FROM app.organization_memberships WHERE organization_id=$1',[org]);
        await seed.query('DELETE FROM app.workspaces WHERE organization_id=$1',[org]);
        await seed.query('DELETE FROM app.organizations WHERE id=$1',[org]);
        await seed.query('DELETE FROM app.users WHERE id=$1',[owner]);
      } finally {await seed.end();}
    }
  });
