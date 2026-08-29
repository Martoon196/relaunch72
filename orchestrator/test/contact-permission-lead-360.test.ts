import assert from 'node:assert/strict';
import test from 'node:test';
import {
  renderLead360Body,
  type Lead360ConsentView,
  type Lead360View,
} from '../src/portal/lead-360-view.js';
import {
  CONTACT_PERMISSION_ROUTE,
  contactPermissionNoticeFromQuery,
  contactPermissionNoticeToken,
} from '../src/portal/contact-permission-actions.js';

const CONTACT_ID = 'fc100000-0000-4000-8000-000000000001';
const POINT_ID = 'fd100000-0000-4000-8000-000000000001';

function endpoint(overrides: Partial<Lead360ConsentView> = {}): Lead360ConsentView {
  return {
    channelLabel: 'Email · avery@example.test',
    state: 'permitted',
    basis: 'Property Predator marketing · Consent',
    updatedAt: '2026-08-30T09:00:00.000Z',
    endpoint: 'avery@example.test',
    contactPointId: POINT_ID,
    channel: 'email',
    purpose: 'property_predator_marketing',
    evidenceSource: 'founder.written_confirmation',
    policyVersion: 'pp-privacy-2026-08',
    policyTextSha256: 'a'.repeat(64),
    effectiveAt: '2026-08-30T09:00:00.000Z',
    recordedAt: '2026-08-30T09:00:03.000Z',
    recordedBy: 'ab100000-0000-4000-8000-000000000001',
    suppressionState: null,
    suppressionReason: null,
    ...overrides,
  };
}

function view(consent: readonly Lead360ConsentView[] = [endpoint()]): Lead360View {
  return {
    identity: {
      contactId: CONTACT_ID, displayName: 'Avery Stone', companyName: null,
      primaryEmail: 'avery@example.test', primaryPhone: null, ownerName: null,
    },
    score: null, scoreExplanation: null,
    journey: { label: 'Agency LAPS', stages: [] },
    evidence: [], nextMove: null, offers: [],
    consent, suppressionReason: null,
    crm: { opportunities: [], tasks: [] },
    asOf: '2026-08-30T10:00:00.000Z',
  };
}

const COMPOSED = {
  permissionCommandAvailable: true,
  permissionCommandKey: 'aa100000-0000-4000-8000-000000000001',
  csrfToken: 'csrf-token-value',
};

test('every recorded permission dimension is shown on the case file', () => {
  const html = renderLead360Body(view(), COMPOSED);
  for (const shown of [
    'avery@example.test',
    'property_predator_marketing',
    'founder.written_confirmation',
    'pp-privacy-2026-08',
    'a'.repeat(64),
    '2026-08-30T09:00:03.000Z',
    'ab100000-0000-4000-8000-000000000001',
  ]) {
    assert.ok(html.includes(shown), `the case file must show ${shown}`);
  }
  for (const label of [
    'Endpoint', 'Purpose', 'Evidence source', 'Policy version', 'Policy digest',
    'Effective', 'Recorded', 'Recording operator', 'Suppression',
  ]) {
    assert.ok(html.includes(`<dt>${label}</dt>`), `missing label ${label}`);
  }
});

test('missing evidence is named as missing rather than left blank', () => {
  const html = renderLead360Body(view([endpoint({
    evidenceSource: null, policyVersion: null, policyTextSha256: null,
    recordedAt: null, recordedBy: null, purpose: null,
  })]), COMPOSED);
  for (const honest of [
    'No evidence source recorded', 'No policy version recorded',
    'No policy digest recorded', 'Operator not recorded', 'No purpose recorded',
  ]) {
    assert.ok(html.includes(honest), `missing honest empty state: ${honest}`);
  }
});

test('suppression stays visible beside a granted permission', () => {
  // Suppression precedence is the whole point: a granted decision must never
  // read as permission to send while a suppression stands.
  const html = renderLead360Body(view([endpoint({
    state: 'suppressed',
    suppressionState: 'suppressed',
    suppressionReason: 'twilio_stop',
  })]), COMPOSED);
  assert.match(html, /lead360-suppression-state">suppressed</);
  assert.ok(html.includes('twilio_stop'));
  assert.ok(html.includes('never clears an existing suppression'));
});

test('a withdrawal is shown as its own state, not as absent evidence', () => {
  for (const [state, label] of [
    ['withdrawn', 'Withdrawn'], ['denied', 'Denied'], ['unknown', 'Not evidenced'],
  ] as const) {
    const html = renderLead360Body(view([endpoint({ state })]), COMPOSED);
    assert.ok(html.includes(label), `${state} must render as ${label}`);
  }
});

test('the empty case file invites a first decision instead of dead-ending', () => {
  const html = renderLead360Body(view([]), COMPOSED);
  assert.ok(html.includes('No channel evidence'));
  assert.ok(html.includes('Record a decision below'));
  // With no endpoint to bind to, the form is withheld rather than shown broken.
  assert.ok(html.includes('no email, SMS or WhatsApp endpoint'));
  assert.equal(html.includes(`action="${CONTACT_PERMISSION_ROUTE}"`), false);
});

test('the form is withheld entirely when the boundary is not composed', () => {
  const html = renderLead360Body(view(), { permissionCommandAvailable: false });
  assert.ok(html.includes('boundary is not composed for this workspace'));
  assert.equal(html.includes(`action="${CONTACT_PERMISSION_ROUTE}"`), false);
  // Control-free, not merely disabled: with no boundary the case file keeps
  // the read-only guarantee the rest of the page has always made.
  assert.doesNotMatch(html, /<(?:form|button|input|select|textarea)/iu);
});

test('every operator and contact controlled value is escaped', () => {
  const hostile = '"><script>alert(1)</script>';
  const html = renderLead360Body(view([endpoint({
    channelLabel: hostile, basis: hostile, endpoint: hostile, purpose: hostile,
    evidenceSource: hostile, policyVersion: hostile, policyTextSha256: hostile,
    recordedBy: hostile, suppressionState: hostile, suppressionReason: hostile,
    contactPointId: hostile,
  })]), { ...COMPOSED, csrfToken: hostile, permissionCommandKey: hostile });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.ok(html.includes('&lt;script&gt;'));
  // The attribute-breaking quote must not survive into any attribute either.
  assert.equal(/value="[^"]*"><script/u.test(html), false);
});

test('the founder form carries CSRF, a command key and an explicit confirmation', () => {
  const html = renderLead360Body(view(), COMPOSED);
  assert.ok(html.includes(`action="${CONTACT_PERMISSION_ROUTE}"`));
  assert.ok(html.includes('name="_csrf" value="csrf-token-value"'));
  assert.ok(html.includes('name="command_key" value="aa100000-0000-4000-8000-000000000001"'));
  assert.ok(html.includes(`name="contact_id" value="${CONTACT_ID}"`));
  assert.match(html, /name="confirm_permission" value="RECORD" required/);
  // Only the three permission acts are offered.
  for (const decision of ['granted', 'denied', 'withdrawn']) {
    assert.ok(html.includes(`<option value="${decision}">`), `missing ${decision}`);
  }
});

test('the permission panel meets the case file accessibility contract', () => {
  const html = renderLead360Body(view(), COMPOSED);
  assert.match(html, /<section class="lead360-section" aria-labelledby="lead360-permission">/);
  assert.match(html, /<h2 id="lead360-permission">/);
  // Every control is inside its own label, so nothing depends on placeholder text.
  const controls = html.match(/<(input|select)\b[^>]*name="(?!_csrf|command_key|contact_id)/gu) ?? [];
  assert.ok(controls.length >= 9, 'expected the founder fields');
  for (const field of [
    'contact_point_id', 'channel', 'purpose', 'decision', 'lawful_basis',
    'evidence_source', 'policy_version', 'policy_text_sha256', 'source_event_id',
    'occurred_at',
  ]) {
    assert.match(
      html, new RegExp(`<label class="lead360-(field|permission-check)">[^<]*<span>[^<]*</span><(input|select)[^>]*name="${field}"`),
      `${field} must be inside a labelled control`,
    );
  }
  // 44px targets and a visible focus ring for keyboard operators.
  assert.ok(html.includes('min-height:44px'));
  assert.ok(html.includes(':focus-visible{outline:2px solid'));
});

test('a notice renders only when its signature matches this session', () => {
  const secret = 'notice-secret';
  const session = 'session-token';
  const token = contactPermissionNoticeToken(secret, session, 'permission_recorded');
  const genuine = contactPermissionNoticeFromQuery(
    new URLSearchParams({ notice: token }), secret, session,
  );
  assert.equal(genuine?.code, 'permission_recorded');
  const html = renderLead360Body(view(), { ...COMPOSED, notice: genuine });
  assert.match(html, /role="status" aria-live="polite"/);
  assert.ok(html.includes('Permission decision recorded'));

  for (const forged of [
    'permission_recorded.forged',
    'permission_recorded',
    contactPermissionNoticeToken(secret, 'another-session', 'permission_recorded'),
    contactPermissionNoticeToken('another-secret', session, 'permission_recorded'),
    `permission_forbidden.${token.split('.')[1]}`,
  ]) {
    assert.equal(
      contactPermissionNoticeFromQuery(
        new URLSearchParams({ notice: forged }), secret, session,
      ),
      null,
      `forged notice accepted: ${forged}`,
    );
  }
});
