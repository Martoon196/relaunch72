import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { renderCrmPipelineBody, type CrmWorkspaceSnapshot } from '../src/portal/crm-views.js';
import { MHP_CRM_CLIENT_SOURCE } from '../src/mhp/crm-client.js';

const contactId='21111111-1111-4111-8111-111111111111';
const firstStage='31111111-1111-4111-8111-111111111111';
const secondStage='32222222-2222-4222-8222-222222222222';
const snapshot:CrmWorkspaceSnapshot={
  workspace:{id:'11111111-1111-4111-8111-111111111111',name:'Test business',timezone:'Europe/London',snapshotAt:'2026-10-29T12:00:00Z',canWrite:true},
  contacts:[],stages:[{id:firstStage,name:'New enquiry',position:0,isClosed:false},{id:secondStage,name:'Contacted',position:1,isClosed:false}],
  opportunities:[{id:'41111111-1111-4111-8111-111111111111',contactId,contactName:'Martin Test Investor',companyName:null,title:'Test lead',stageId:firstStage,
    valueMinor:0,currency:'GBP',ownerName:'Internal owner',expectedCloseDate:null,nextTaskAt:null,updatedAt:'2026-10-29T12:00:00Z',rowVersion:1,moveCommandKey:'move-test-1'}],
  tasks:[],timeline:[],
};

test('MHP card uses recorded investor needs and preserves the server stage form',()=>{
  const html=renderCrmPipelineBody(snapshot,{csrfToken:'csrf-test',mhpInvestorCards:true,conversationsAvailable:true,investorDetails:{[contactId]:{capital:'£150k available',interests:'BRR and HMOs'}}});
  assert.match(html,/Available capital<\/span><strong>£150k available/);
  assert.match(html,/Interested in<\/span><strong>BRR and HMOs/);
  assert.doesNotMatch(html,/<span>Owner<\/span>/);
  assert.match(html,/data-stage-id="32222222-2222-4222-8222-222222222222"/);
  assert.match(html,/data-opportunity-id="41111111-1111-4111-8111-111111111111"/);
  assert.match(html,/data-contact-href="\/portal\/crm\/contacts\/21111111-1111-4111-8111-111111111111" draggable="true" tabindex="0"/);
  assert.match(html,/href="\/portal\/investors\/email\?contact=21111111-1111-4111-8111-111111111111#compose"/);
  assert.match(html,/name="expected_version" value="1"/);
  assert.match(html,/name="target_stage_id" required/);
  assert.match(html,/Drag a card to another stage/);
});

test('MHP card hides email action without the workflow entitlement',()=>{
  const html=renderCrmPipelineBody(snapshot,{csrfToken:'csrf-test',mhpInvestorCards:true});
  assert.doesNotMatch(html,/href="\/portal\/investors\/email\?contact=/);
  assert.match(html,/Edit investor details/);
});

test('shared CRM remains form-driven and shows its original owner tile',()=>{
  const html=renderCrmPipelineBody(snapshot,{csrfToken:'csrf-test'});
  assert.match(html,/<span>Owner<\/span>/);
  assert.doesNotMatch(html,/mhp-investor-card|draggable="true"|Conversation →/);
  assert.match(html,/there is no pretend drag and drop/);
});

test('MHP client script is valid and submits the existing stage form',()=>{
  assert.doesNotThrow(()=>new Script(MHP_CRM_CLIENT_SOURCE));
  assert.match(MHP_CRM_CLIENT_SOURCE,/form\.requestSubmit\(submit\)/);
  assert.match(MHP_CRM_CLIENT_SOURCE,/interactive\(event\.target\)/);
});
