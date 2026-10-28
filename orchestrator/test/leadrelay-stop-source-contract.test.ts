import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePropertyPredatorExternalEvent} from '../src/integrations/external-events/contracts.js';
import {createPropertyPredatorStopRelay} from '../src/integrations/leadrelay/stop-relay.mjs';

test('stop translator accepts the actual strict HQ canonical purchase and appointment schemas',async()=>{
  const workspace='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222';
  const common={id:'33333333-3333-4333-8333-333333333333',version:1,occurredAt:'2026-10-28T12:00:00.000Z',correlationId:'44444444-4444-4444-8444-444444444444',subject:{kind:'account',id:'55555555-5555-4555-8555-555555555555'}};
  for(const candidate of [
    {...common,type:'commerce.purchase.completed',data:{provider:'stripe',providerEventId:'evt_actual_schema_fixture',checkoutSessionId:'cs_actual_schema_fixture',productKey:'pro_investor',billingKind:'subscription',subscriptionId:'sub_fixture',amountMinor:4950,currency:'gbp'}},
    {...common,type:'sales.appointment.booked',data:{appointmentId:'calendar_fixture_id',startsAt:'2026-11-01T12:00:00.000Z',bookingSource:'self_serve_calendar',meetingKind:'discovery'}},
  ]){
    const canonical=parsePropertyPredatorExternalEvent(candidate),sent:Record<string,unknown>[]=[];
    const relay=createPropertyPredatorStopRelay({installation:{hqWorkspaceId:workspace,leadRelayWorkspaceId:target,installationId:'pp',origin:'https://leadrelay.example',hookSecret:'synthetic-canonical-contract-only-0123456789',purchaseProductKeys:['pro_investor']},
      loadCanonicalEvent:async()=>({hqWorkspaceId:workspace,source:'property_predator',event:canonical}),
      resolveLeadBinding:async(q)=>({...q,leadId:'66666666-6666-4666-8666-666666666666',stopScope:'all_sales_followup_for_lead'}),
      fetchImpl:async(_url:unknown,options:RequestInit)=>{sent.push(JSON.parse(String(options.body)));return new Response('{"ok":true,"duplicate":false}',{headers:{'content-type':'application/json'}});}});
    assert.equal((await relay({hqWorkspaceId:workspace,eventId:canonical.id})).disposition,'delivered');
    assert.equal(sent.length,1);assert.equal(sent[0]?.type,canonical.type==='commerce.purchase.completed'?'purchase.confirmed':'meeting.booked');
  }
});
