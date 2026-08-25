import assert from 'node:assert/strict';
import test from 'node:test';
import {
  renderJourneyManagerBody,
  type JourneyManagerView,
} from '../src/portal/journey-manager-view.js';

function view(): JourneyManagerView {
  return {
    workspaceName: 'Property Predator <HQ>',
    asOf: '2026-08-25T20:45:00.000Z',
    state: 'ready',
    readinessTitle: 'Exact foundation active',
    readinessSummary: 'Both immutable v2 routes and the shared score model match the owned blueprint.',
    routes: [
      {
        slug: 'property-predator-self-serve',
        label: 'Property Predator self-serve conversion',
        description: 'Product-led conversion from an identified account to an authoritative paid sale.',
        version: 2,
        state: 'active',
        enrollmentLabel: 'Product-led',
        milestones: [
          { key: 'lead', label: 'Lead', semantic: 'lead', isCompletion: false },
          { key: 'activated', label: 'Activated', semantic: 'activation', isCompletion: false },
          { key: 'priced', label: 'Priced', semantic: 'offer', isCompletion: false },
          { key: 'sale', label: 'Sale', semantic: 'sale', isCompletion: true },
        ],
        triggers: [
          { kind: 'event', sourceKey: 'identity.account.created', milestoneKey: 'lead', evidenceLabel: 'Account created' },
          { kind: 'event', sourceKey: 'product.analysis.completed', milestoneKey: 'activated', evidenceLabel: 'Analysis completed' },
          { kind: 'event', sourceKey: 'offer.presented', milestoneKey: 'priced', evidenceLabel: 'Offer presented' },
          { kind: 'commerce', sourceKey: 'payment_collected', milestoneKey: 'sale', evidenceLabel: 'Payment collected' },
        ],
      },
      {
        slug: 'property-predator-agency-laps',
        label: 'Property Predator agency LAPS',
        description: 'Sales-assisted Lead, Appointment, Presentation and Sale.',
        version: 2,
        state: 'active',
        enrollmentLabel: 'Sales-assisted',
        milestones: [
          { key: 'lead', label: 'Lead', semantic: 'lead', isCompletion: false },
          { key: 'appointment', label: 'Appointment', semantic: 'appointment', isCompletion: false },
          { key: 'presentation', label: 'Presentation', semantic: 'presentation', isCompletion: false },
          { key: 'sale', label: 'Sale', semantic: 'sale', isCompletion: true },
        ],
        triggers: [
          { kind: 'event', sourceKey: 'sales.appointment.booked', milestoneKey: 'appointment', evidenceLabel: 'Appointment booked' },
          { kind: 'event', sourceKey: 'sales.presentation.completed', milestoneKey: 'presentation', evidenceLabel: 'Presentation completed' },
          { kind: 'commerce', sourceKey: 'payment_collected', milestoneKey: 'sale', evidenceLabel: 'Payment collected' },
        ],
      },
    ],
    scoring: {
      label: 'Property Predator lead score', version: 2, state: 'active', ruleCount: 7,
      components: [
        { key: 'fit', label: 'Fit', maxPoints: 30, allocatedPoints: 0 },
        { key: 'engagement', label: 'Engagement', maxPoints: 35, allocatedPoints: 35 },
        { key: 'intent', label: 'Intent', maxPoints: 35, allocatedPoints: 35 },
      ],
      bands: [
        { key: 'quiet', label: 'Quiet', minScore: 0, maxScore: 21 },
        { key: 'warm', label: 'Warm', minScore: 22, maxScore: 44 },
        { key: 'hot', label: 'Hot', minScore: 45, maxScore: 69 },
        { key: 'burning', label: 'Burning', minScore: 70, maxScore: 100 },
      ],
      excludedSignals: ['Consent', 'Suppression', 'CRM tasks'],
    },
    setup: { state: 'ready', canManage: true, postAction: '/portal/journeys/install' },
  };
}

test('Journey Manager renders both exact conversion topologies and evidence sources', () => {
  const html = renderJourneyManagerBody(view());
  assert.match(html, /<article class="jm" aria-labelledby="jm-title">/);
  assert.match(html, /Visual journey map/);
  assert.match(html, /Two motions\. One evidence spine\./);
  assert.equal((html.match(/class="jm-route" data-state="active"/g) ?? []).length, 2);
  assert.equal((html.match(/class="jm-milestone/g) ?? []).length, 8);
  assert.match(html, /property-predator-self-serve/);
  assert.match(html, /identity\.account\.created/);
  assert.match(html, /product\.analysis\.completed/);
  assert.match(html, /property-predator-agency-laps/);
  assert.match(html, /sales\.appointment\.booked/);
  assert.match(html, /sales\.presentation\.completed/);
  assert.equal((html.match(/payment_collected/g) ?? []).length, 2);
  assert.match(html, /No direct trigger/);
  assert.match(html, /8<\/strong><span>Ordered conversion facts/);
  assert.match(html, /7<\/strong><span>Exact evidence sources/);
});

test('Journey Manager explains score allocation, thresholds and non-score signals', () => {
  const html = renderJourneyManagerBody(view());
  assert.match(html, /Property Predator lead score/);
  assert.match(html, /7 evidence rules/);
  assert.match(html, /Fit<\/strong><span>0 \/ 30 pts/);
  assert.match(html, /Engagement<\/strong><span>35 \/ 35 pts/);
  assert.match(html, /role="meter" aria-label="Intent score allocation"/);
  assert.match(html, /Quiet<\/strong><span>0–21/);
  assert.match(html, /Burning<\/strong><span>70–100/);
  assert.match(html, /Exact evidence only/);
  assert.match(html, /Communication permission<\/span><strong>Separate from intent/);
  assert.match(html, />Consent<\/span>/);
  assert.match(html, />Suppression<\/span>/);
  assert.match(html, />CRM tasks<\/span>/);
});

test('ready Journey Manager is read-only and makes no external-effect claim', () => {
  const html = renderJourneyManagerBody(view());
  assert.match(html, /No setup action is required/);
  assert.match(html, /Definitions only · no provider action from this screen/);
  assert.doesNotMatch(html, /<(?:form|button|input|select|textarea)\b/i);
  assert.doesNotMatch(html, /messages sent|posts published|provider connected|lead converted/i);
});

test('available manager setup has CSRF, idempotency and typed confirmation boundaries', () => {
  const html = renderJourneyManagerBody({
    ...view(), state: 'action_required', readinessTitle: 'Foundation required',
    setup: {
      state: 'available', canManage: true, postAction: '/portal/journeys/install?x=<unsafe>',
      csrfToken: 'csrf<&"token', commandKey: 'journey:<command>', confirmationToken: 'INSTALL <PP>',
    },
  });
  assert.match(html, /<form class="jm-setup-form" method="post" action="\/portal\/journeys\/install\?x=&lt;unsafe&gt;">/);
  assert.match(html, /name="_csrf" value="csrf&lt;&amp;&quot;token"/);
  assert.match(html, /name="command_key" value="journey:&lt;command&gt;"/);
  assert.match(html, /Type <code>INSTALL &lt;PP&gt;<\/code> to confirm/);
  assert.match(html, /name="confirmation" required/);
  assert.match(html, /This changes definitions only/);
  assert.match(html, /It does not send a message, publish a post or connect a provider/);
});

test('setup fails visually closed when access or mutation tokens are incomplete', () => {
  const readOnly = renderJourneyManagerBody({
    ...view(), state: 'action_required',
    setup: { state: 'available', canManage: false, postAction: '/portal/journeys/install' },
  });
  assert.match(readOnly, /needs a workspace manager/);
  assert.doesNotMatch(readOnly, /<form\b/);

  const incomplete = renderJourneyManagerBody({
    ...view(), state: 'action_required',
    setup: { state: 'available', canManage: true, postAction: '/portal/journeys/install', csrfToken: 'csrf' },
  });
  assert.match(incomplete, /closed until the protected runtime boundary/);
  assert.doesNotMatch(incomplete, /<form\b/);

  const blocked = renderJourneyManagerBody({
    ...view(), state: 'degraded',
    setup: { state: 'blocked', canManage: true, postAction: '', blocker: 'Unsafe <runtime> state' },
  });
  assert.match(blocked, /Unsafe &lt;runtime&gt; state/);
  assert.doesNotMatch(blocked, /<form\b/);
});

test('Journey Manager escapes supplied content and tolerates unavailable timestamps and empty definitions', () => {
  const base = view();
  const html = renderJourneyManagerBody({
    ...base,
    workspaceName: '<img src=x onerror=alert(1)>', asOf: 'bad"><script>',
    readinessTitle: '<script>alert(1)</script>', readinessSummary: 'A&B <unsafe>', routes: [],
    scoring: { ...base.scoring, label: '<score>', components: [], bands: [], excludedSignals: ['<consent>'] },
    notice: { kind: 'error', title: '<Failure>', message: 'Bad & unsafe' },
  });
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /A&amp;B &lt;unsafe&gt;/);
  assert.match(html, /No route definitions found/);
  assert.match(html, /No scoring components are published/);
  assert.match(html, /time unavailable/);
  assert.doesNotMatch(html, /<img\b|<script\b/i);
});

test('Journey Manager ships responsive and forced-colour semantics', () => {
  const html = renderJourneyManagerBody(view());
  assert.match(html, /@media\(max-width:760px\)/);
  assert.match(html, /@media\(max-width:480px\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.match(html, /<ol class="jm-topology"[^>]+aria-label="Property Predator self-serve conversion milestones">/);
  assert.match(html, /aria-label="Evidence that advances Sale"/);
  assert.match(html, /aria-label="Scoring and setup controls"/);
});
