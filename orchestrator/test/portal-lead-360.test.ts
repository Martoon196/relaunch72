import assert from 'node:assert/strict';
import test from 'node:test';
import { lead360ScoreBand, renderLead360Body, type Lead360View } from '../src/portal/lead-360-view.js';

function caseFile(): Lead360View {
  return {
    identity: {
      contactId: '11111111-1111-4111-8111-111111111111',
      displayName: 'Avery North',
      companyName: 'North Homes',
      primaryEmail: 'avery@example.test',
      primaryPhone: '+44 7700 900123',
      ownerName: 'Martha',
    },
    score: 76,
    scoreExplanation: 'Completed the briefing, revisited pricing and replied with a buying question.',
    journey: {
      label: 'Self-serve conversion',
      stages: [
        { key: 'lead', label: 'Lead', state: 'complete', reachedAt: '2026-08-24T09:00:00.000Z' },
        { key: 'activated', label: 'Activated', state: 'complete', reachedAt: '2026-08-24T09:04:00.000Z' },
        { key: 'priced', label: 'Priced', state: 'current', reachedAt: '2026-08-25T10:00:00.000Z' },
        { key: 'sale', label: 'Sale', state: 'upcoming', reachedAt: null },
      ],
    },
    evidence: [
      { id: 'e1', kind: 'watched', title: 'Predator Briefing', detail: 'Replay session', percentage: 92, occurredAt: '2026-08-25T09:55:00.000Z', sourceLabel: 'Webinar player' },
      { id: 'e2', kind: 'offer', title: 'Apex annual offer', detail: 'Pricing page presented', percentage: null, occurredAt: '2026-08-25T10:00:00.000Z', sourceLabel: 'Property Predator' },
      { id: 'e3', kind: 'reply', title: 'Buying question received', detail: 'Asked about onboarding', percentage: null, occurredAt: '2026-08-25T10:12:00.000Z', sourceLabel: 'Email inbox' },
      { id: 'e4', kind: 'email', title: 'Property Predator email delivered', detail: 'Growth HQ launch proof', percentage: null, occurredAt: '2026-08-25T10:13:00.000Z', sourceLabel: 'Mailgun · signed receipt' },
    ],
    nextMove: { label: 'Call while the offer is fresh', reason: 'The lead replied after viewing pricing. Answer the onboarding question before introducing anything new.', dueAt: '2026-08-25T11:00:00.000Z' },
    offers: [{ id: 'o1', title: 'Apex annual', valueLabel: '£1,497 per year', state: 'no_response', presentedAt: '2026-08-25T10:00:00.000Z', responseAt: null, responseDetail: 'Buying question received; no commercial response recorded.' }],
    consent: [
      { channelLabel: 'Email', state: 'permitted', basis: 'Explicit product updates', updatedAt: '2026-08-24T09:00:00.000Z', endpoint: 'avery@example.test', contactPointId: '64646464-6464-4464-8464-646464646464', channel: 'email', purpose: 'property_predator_marketing', evidenceSource: 'founder.signed_form', policyVersion: 'pp-privacy-2026-08', policyTextSha256: 'c'.repeat(64), effectiveAt: '2026-08-24T09:00:00.000Z', recordedAt: '2026-08-24T09:00:02.000Z', recordedBy: '65656565-6565-4565-8565-656565656565', suppressionState: null, suppressionReason: null },
      { channelLabel: 'WhatsApp', state: 'unknown', basis: null, updatedAt: null, endpoint: '+447700900123', contactPointId: '66666666-6666-4666-8666-666666666666', channel: 'whatsapp', purpose: null, evidenceSource: null, policyVersion: null, policyTextSha256: null, effectiveAt: null, recordedAt: null, recordedBy: null, suppressionState: null, suppressionReason: null },
    ],
    suppressionReason: null,
    crm: {
      opportunities: [{ id: 'op1', title: 'Apex annual', stageLabel: 'Proposal', state: 'open', valueLabel: '£1,497' }],
      tasks: [{ id: 't1', title: 'Answer onboarding question', state: 'open', dueAt: '2026-08-25T11:00:00.000Z' }],
    },
    asOf: '2026-08-25T10:15:00.000Z',
  };
}

test('Lead 360 renders a semantic forensic case file with exact evidence and decision rails', () => {
  const html = renderLead360Body(caseFile());
  assert.match(html, /<article class="lead360" aria-labelledby="lead360-title">/);
  assert.match(html, /<nav class="lead360-journey" aria-label="Primary journey stages" data-primary-route="true">/);
  assert.match(html, /aria-current="step"/);
  assert.match(html, /Engagement evidence/);
  assert.match(html, /aria-label="Recorded evidence, newest first"/);
  assert.match(html, /data-evidence-kind="watched"/);
  assert.match(html, /92% complete/);
  assert.match(html, /Source · Webinar player/);
  assert.match(html, /data-evidence-kind="email"/);
  assert.match(html, /Property Predator email delivered/);
  assert.match(html, /Source · Mailgun · signed receipt/);
  assert.match(html, /25 Aug 2026, 09:55:00 UTC/);
  assert.match(html, /Best next move/);
  assert.match(html, /Primary route · Self-serve conversion/);
  assert.match(html, /Offer history/);
  assert.match(html, /No response recorded/);
  assert.match(html, /Consent \+ suppression/);
  assert.match(html, /CRM summary/);
});

test('Lead 360 renders every runtime enrollment with its own milestones, score timing and terminal state', () => {
  const view = caseFile();
  const journeys: NonNullable<Lead360View['journeys']> = [
    {
      label: 'Property Predator self-serve',
      isPrimary: true,
      status: 'active',
      enrolledAt: '2026-08-24T09:00:00.000Z',
      lastEventAt: '2026-08-25T10:00:00.000Z',
      endedAt: null,
      stages: [
        { key: 'lead', label: 'Lead', state: 'complete', reachedAt: '2026-08-24T09:00:00.000Z' },
        { key: 'priced', label: 'Pricing reviewed', state: 'current', reachedAt: '2026-08-25T10:00:00.000Z' },
        { key: 'sale', label: 'Sale', state: 'upcoming', reachedAt: null },
      ],
      score: {
        total: 76,
        explanation: 'Pricing and reply evidence increased intent.',
        sourceOccurredAt: '2026-08-25T10:12:00.000Z',
        evaluatedAt: '2026-08-25T10:12:01.000Z',
      },
    },
    {
      label: 'Property Predator agency LAPS',
      status: 'completed',
      enrolledAt: '2026-07-01T09:00:00.000Z',
      lastEventAt: '2026-08-22T15:00:00.000Z',
      endedAt: '2026-08-22T15:00:00.000Z',
      stages: [
        { key: 'appointment', label: 'Appointment', state: 'complete', reachedAt: '2026-08-20T10:00:00.000Z' },
        { key: 'sale', label: 'Agency sale', state: 'current', reachedAt: '2026-08-22T15:00:00.000Z' },
      ],
      score: {
        total: 48,
        explanation: 'The agency sale journey completed.',
        sourceOccurredAt: '2026-08-22T15:00:00.000Z',
        evaluatedAt: '2026-08-22T15:00:01.000Z',
      },
    },
  ];
  const html = renderLead360Body({
    ...view,
    journeys,
    journey: journeys[0]!,
    primaryJourneyLabel: 'Property Predator self-serve',
  });

  assert.equal((html.match(/<nav class="lead360-journey"/g) ?? []).length, 2);
  assert.equal((html.match(/<nav class="lead360-journey"[^>]*data-primary-route="true"/g) ?? []).length, 1);
  assert.equal((html.match(/>Primary route<\/span>/g) ?? []).length, 1);
  assert.ok(html.indexOf('Property Predator self-serve') < html.indexOf('Property Predator agency LAPS'));
  assert.match(html, /state-active">Active</);
  assert.match(html, /Latest event <time datetime="2026-08-25T10:00:00.000Z"/);
  assert.match(html, /state-completed">Completed</);
  assert.match(html, /Ended <time datetime="2026-08-22T15:00:00.000Z"/);
  assert.match(html, /Pricing and reply evidence increased intent\./);
  assert.match(html, /The agency sale journey completed\./);
  assert.match(html, /Evidence through<\/dt><dd><time datetime="2026-08-25T10:12:00.000Z"/);
  assert.match(html, /Evaluated<\/dt><dd><time datetime="2026-08-22T15:00:01.000Z"/);
  assert.equal((html.match(/aria-current="step"/g) ?? []).length, 2);
  assert.deepEqual(view.journey.stages.map((stage) => stage.label), ['Lead', 'Activated', 'Priced', 'Sale']);
});

test('Lead 360 orders the timeline newest first without changing the supplied array', () => {
  const view = caseFile();
  const original = view.evidence.map((item) => item.id);
  const html = renderLead360Body(view);
  assert.ok(html.indexOf('Buying question received') < html.indexOf('Apex annual offer'));
  assert.ok(html.indexOf('Apex annual offer') < html.indexOf('Predator Briefing'));
  assert.deepEqual(view.evidence.map((item) => item.id), original);
});

test('Lead 360 escapes every supplied display field and ignores undeclared provider data', () => {
  const base = caseFile();
  const poisoned = {
    ...base,
    identity: { ...base.identity, displayName: '<img src=x onerror=alert(1)>', companyName: 'A&B <Ltd>' },
    scoreExplanation: '<script>alert(1)</script>',
    journey: { label: '<Journey>', stages: [{ key: 'x', label: '<Stage>', state: 'current', reachedAt: null }] },
    evidence: [{ id: 'x', kind: 'read', title: '<Evidence>', detail: '"quoted" & unsafe', percentage: 50, occurredAt: 'bad"><script>', sourceLabel: '<source>' }],
    nextMove: { label: '<Call now>', reason: '<reason>', dueAt: null },
    offers: [{ id: 'x', title: '<Offer>', valueLabel: '<£1>', state: 'declined', presentedAt: '2026-08-25T10:00:00Z', responseAt: null, responseDetail: '<No>' }],
    consent: [{ channelLabel: '<Email>', state: 'suppressed', basis: '<basis>', updatedAt: null, endpoint: '<script>alert(1)</script>@example.test', contactPointId: '67676767-6767-4767-8767-676767676767', channel: 'email', purpose: '<purpose>', evidenceSource: '<source>', policyVersion: '<policy>', policyTextSha256: '<digest>', effectiveAt: null, recordedAt: null, recordedBy: '<operator>', suppressionState: 'suppressed', suppressionReason: '<suppressed>' }],
    suppressionReason: '<suppressed>',
    crm: { opportunities: [{ id: 'x', title: '<Deal>', stageLabel: '<Stage>', state: 'open', valueLabel: null }], tasks: [{ id: 'x', title: '<Task>', state: 'open', dueAt: null }] },
    providerSecret: 'DO-NOT-RENDER',
    rawPayload: '<raw-provider-payload>',
  } as Lead360View & { providerSecret: string; rawPayload: string };
  const html = renderLead360Body(poisoned);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /A&amp;B &lt;Ltd&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;Evidence&gt;/);
  assert.match(html, /&quot;quoted&quot; &amp; unsafe/);
  assert.match(html, /Source · &lt;source&gt;/);
  assert.doesNotMatch(html, /<img\b|<script\b/i);
  assert.doesNotMatch(html, /DO-NOT-RENDER|raw-provider-payload/);
});

test('Lead 360 applies the documented evidence-score bands at their exact boundaries', () => {
  assert.equal(lead360ScoreBand(70), 'burning');
  assert.equal(lead360ScoreBand(69), 'hot');
  assert.equal(lead360ScoreBand(45), 'hot');
  assert.equal(lead360ScoreBand(44), 'warm');
  assert.equal(lead360ScoreBand(22), 'warm');
  assert.equal(lead360ScoreBand(21), 'quiet');
  assert.equal(lead360ScoreBand(0), 'quiet');
  assert.equal(lead360ScoreBand(null), 'unscored');
  assert.match(renderLead360Body(caseFile()), /Primary journey score 76, Burning\. Primary route · Self-serve conversion/);
});

test('Lead 360 empty states invent no consumption, offers, consent or CRM work', () => {
  const base = caseFile();
  const html = renderLead360Body({
    ...base,
    score: null,
    scoreExplanation: null,
    journey: { label: 'Self-serve conversion', stages: [] },
    evidence: [],
    nextMove: null,
    offers: [],
    consent: [],
    crm: { opportunities: [], tasks: [] },
  });
  assert.match(html, /No journey enrolled/);
  assert.match(html, /No recorded engagement evidence/);
  assert.match(html, /No evidence-based next move/);
  assert.match(html, /No offer history/);
  assert.match(html, /No channel evidence/);
  assert.match(html, /No CRM opportunities/);
  assert.match(html, /No CRM tasks/);
  assert.match(html, /Primary journey score —, Unscored\. No primary route/);
  assert.doesNotMatch(html, /92% complete|Webinar player|£1,497/);
});

test('Lead 360 remains read-only and exposes no external-effect control', () => {
  const html = renderLead360Body(caseFile());
  assert.match(html, /Route context names the score source; consent and CRM tasks remain contact-wide\. Nothing has been sent or changed\./);
  assert.doesNotMatch(html, /<(?:form|button|input|select|textarea)\b/i);
  assert.doesNotMatch(html, /onclick=|onsubmit=|Send message|Publish post|Start automation/i);
  assert.doesNotMatch(html, /payload|event hash|provider secret/i);
});

test('the composed permission form adds evidence and still no external effect', () => {
  const html = renderLead360Body(caseFile(), {
    permissionCommandAvailable: true,
    permissionCommandKey: 'aa100000-0000-4000-8000-000000000001',
    csrfToken: 'csrf-token-value',
  });
  // Exactly one form, and it records permission rather than reaching a provider.
  assert.equal((html.match(/<form/giu) ?? []).length, 1);
  assert.match(html, /action="\/portal\/crm\/contacts\/permission"/);
  assert.doesNotMatch(
    html,
    /onclick=|onsubmit=|Send message|Publish post|Start automation/i,
  );
  assert.doesNotMatch(html, /payload|event hash|provider secret/i);
  assert.match(html, /never queues or sends a message/);
});
