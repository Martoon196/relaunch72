import assert from 'node:assert/strict';
import test from 'node:test';
import { createPropertyPredatorTestInboxSnapshot } from '../src/portal/conversion-inbox-fixtures.js';
import {
  CONVERSION_INBOX_MAX_MESSAGE_BYTES,
  presentConversionInbox,
  type ConversionInboxSnapshot,
} from '../src/portal/conversion-inbox-presenter.js';
import {
  renderConversionInboxBody,
  type ConversionInboxActionSecurity,
} from '../src/portal/conversion-inbox-view.js';
import {
  conversionInboxNoticeFromQuery,
  conversionInboxNoticeToken,
} from '../src/portal/conversion-inbox-actions.js';

const ACTION_SECURITY: ConversionInboxActionSecurity = {
  csrfToken: 'fixture-csrf-token',
  createDraftKeys: {},
  reviseDraftKeys: {
    '60000000-0000-4000-8000-000000000005': 'revise-command-5',
  },
  requestApprovalKeys: {
    '60000000-0000-4000-8000-000000000005': 'request-command-5',
  },
  decisionKeys: {
    '80000000-0000-4000-8000-000000000001': 'decision-command-1',
  },
  queueKeys: {
    '60000000-0000-4000-8000-000000000004': 'queue-command-4',
  },
};

function render(
  snapshot: ConversionInboxSnapshot = createPropertyPredatorTestInboxSnapshot(),
  filters: Readonly<Record<string, unknown>> = {},
  security?: ConversionInboxActionSecurity,
): string {
  return renderConversionInboxBody(presentConversionInbox(snapshot, {
    workspaceName: 'Property Predator Growth HQ',
    filters,
  }), { security });
}

test('renders a dense Predator-branded omnichannel conversion workspace', () => {
  const html = render();
  assert.match(html, /data-property-predator-conversion-inbox/);
  assert.match(html, /data-environment="test"/);
  assert.match(html, /Growth HQ · Conversion Inbox/);
  assert.match(html, /Every channel\. <em>One human queue\.<\/em>/);
  assert.match(html, /--ci-teal:#00e5cc/);
  assert.match(html, /grid-template-columns:76px minmax\(280px,350px\) minmax\(420px,1fr\) minmax\(270px,315px\)/);
  assert.match(html, /Rahman Property Partners/);
  assert.match(html, /Journey stage/);
  assert.match(html, /Lead score/);
  assert.match(html, /North Star Network/);
  assert.match(html, /aria-label="TEST rail activity: Simulator accepted"/);
  assert.match(html, /Trace TEST 91000000…0001/);
});

test('makes the test and simulation boundary impossible to miss', () => {
  const html = render();
  assert.match(html, /TEST \/ SIMULATED/);
  assert.match(html, /Contact records may be workspace CRM data/);
  assert.match(html, /Provider adapters are non-routable; no message here has contacted anyone/);
  assert.match(html, /Email · TEST/);
  assert.match(html, /SIMULATED delivered · no real delivery occurred/);
  assert.match(html, /No message left Growth HQ/);
  assert.match(html, /cannot contact anyone or invoke a live provider/);
  assert.doesNotMatch(html, /\bmessage sent\b|\bsent successfully\b|\bsuccessfully delivered\b|data-environment="live"/i);
  assert.doesNotMatch(html, /action="[^"]*(?:send|deliver|publish)/i);
  assert.doesNotMatch(html, /91000000-0000-4000-8000-000000000001/);
});

test('shows truthful queued, accepted, reconciled, attention and empty TEST rail states', () => {
  const fixture = createPropertyPredatorTestInboxSnapshot();
  const cases = [
    ['email', 'accepted', 'Simulator accepted'],
    ['whatsapp', 'queued', 'Queued for simulator'],
    ['instagram', 'attention', 'Needs attention'],
    ['sms', 'reconciled', 'Reconciled'],
  ] as const;
  for (const [channel, state, label] of cases) {
    const html = render(fixture, { channel });
    assert.match(html, new RegExp(`data-rail-state="${state}"`));
    assert.match(html, new RegExp(`>${label}<`));
    assert.match(html, /TEST rail/);
    assert.match(html, /Last change <time datetime=/);
  }
  const empty = render(fixture, { channel: 'facebook' });
  assert.match(empty, /data-rail-state="none"/);
  assert.match(empty, /No operation recorded/);
  assert.match(empty, /Nothing is queued for this conversation/);
});

test('renders all five channel controls and real fictional test queue fixtures', () => {
  const html = render();
  for (const glyph of ['HQ', 'EM', 'WA', 'SM', 'IG', 'FB']) {
    assert.match(html, new RegExp(`>${glyph}<`));
  }
  for (const person of ['Aisha Rahman', 'Priya Nair', 'Marcus Reed', 'Sophie Grant', 'Liam Carter']) {
    assert.match(html, new RegExp(person));
  }
  assert.equal((html.match(/<li class="ci-conversation">/g) ?? []).length, 5);
  assert.match(html, /aria-label="TEST and simulated conversation queue"/);
});

test('uses singular conversation copy when a channel has one loaded fixture', () => {
  const html = render(createPropertyPredatorTestInboxSnapshot(), { channel: 'whatsapp' });
  assert.match(html, /aria-label="WhatsApp, 1 loaded test conversation"/);
  assert.match(html, />1 loaded test conversation matches the current filters\.<\/div>/);
  assert.doesNotMatch(html, /1 loaded test conversations/);
});

test('shows selected transcript, draft state, approval gate, consent and simulator delivery state', () => {
  const html = render();
  assert.match(html, /id="ci-transcript" tabindex="-1"/);
  assert.match(html, /aria-label="Test message transcript"/);
  assert.match(html, /Thanks for watching the agency briefing/);
  assert.match(html, /Thursday works/);
  assert.match(html, /Reply draft/);
  assert.match(html, /Immutable test draft v1/);
  assert.match(html, /Approval pending · Not queued/);
  assert.match(html, /Test fixture consent event/);
  assert.match(html, /Exact draft version/);
  assert.match(html, /Human approval/);
  assert.match(html, /Current consent/);
  assert.match(html, /data-delivery-state="not_queued"/);
  assert.match(html, /No provider operation exists for this exact draft/);
});

test('approved social reply remains visibly locked when consent is unknown', () => {
  const html = render(createPropertyPredatorTestInboxSnapshot(), { channel: 'instagram' });
  assert.match(html, /Marcus Reed/);
  assert.match(html, /Exact version approved/);
  assert.match(html, /Social messaging/);
  assert.match(html, /Not established/);
  assert.match(html, /Gate remains closed/);
  assert.match(html, />Approval gate locked<\/button>/);
  assert.doesNotMatch(html, />Queue TEST operation<\/button>/);
});

test('escapes every user and source controlled field at the view boundary', () => {
  const base = createPropertyPredatorTestInboxSnapshot();
  const firstSummary = base.page.conversations[0]!;
  const firstThread = base.threads[0]!;
  const attack = '<script data-pwned>window.pwned=true</script>';
  const snapshot: ConversionInboxSnapshot = {
    page: {
      ...base.page,
      conversations: [{
        ...firstSummary,
        contactName: attack,
        subject: 'Subject <img src=x onerror=boom>',
        latestMessage: { ...firstSummary.latestMessage!, body: 'Preview <svg onload=boom>' },
      }],
    },
    threads: [{
      ...firstThread,
      lead: {
        ...firstThread.lead,
        displayName: attack,
        companyName: '<b>Unsafe company</b>',
        sourceLabel: '<source>',
        affiliateLabel: '<affiliate>',
      },
      messages: [{
        ...firstThread.messages[0]!,
        authorLabel: '<author>',
        body: '<iframe src=evil></iframe>',
      }],
      consents: [{
        ...firstThread.consents[0]!,
        basis: '<consent-basis>',
      }],
      draft: {
        ...firstThread.draft,
        body: '</textarea><script>boom</script>',
        approvalNote: '<review-note>',
      },
    }],
  };
  const html = renderConversionInboxBody(presentConversionInbox(snapshot, {
    workspaceName: '<workspace>',
    filters: { query: '<script' },
  }));
  assert.doesNotMatch(html, /<script data-pwned>|<iframe src=evil>|<img src=x|<svg onload=boom>|<b>Unsafe company|<consent-basis>|<review-note>|<workspace>/);
  assert.match(html, /&lt;script data-pwned&gt;/);
  assert.match(html, /&lt;iframe src=evil&gt;/);
  assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;boom&lt;\/script&gt;/);
  assert.match(html, /&lt;review-note&gt;/);
  assert.match(html, /&lt;workspace&gt;/);
  assert.match(html, /value="&lt;script"/);
});

test('uses semantic landmarks, associated controls and touch-size targets', () => {
  const html = render(createPropertyPredatorTestInboxSnapshot(), { channel: 'facebook' }, ACTION_SECURITY);
  assert.match(html, /<nav class="ci-channels" aria-label="Test conversation channels">/);
  assert.match(html, /<main class="ci-thread" aria-labelledby="ci-thread-title">/);
  assert.match(html, /<aside class="ci-context" aria-label="Lead and safety context">/);
  assert.match(html, /<label id="ci-draft-title" for="ci-reply-draft">/);
  assert.match(html, /<textarea id="ci-reply-draft"/);
  assert.match(html, /action="\/portal\/inbox\/messages\/60000000-0000-4000-8000-000000000005\/versions"/);
  assert.match(html, /action="\/portal\/inbox\/messages\/60000000-0000-4000-8000-000000000005\/approval-requests"/);
  assert.match(html, /name="_csrf" value="fixture-csrf-token"/);
  assert.match(html, />Save new immutable version<\/button>/);
  assert.match(html, />Request human approval<\/button>/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /aria-label="TEST rail activity/);
  assert.match(html, /\.ci-field input,.ci-field select\{[^}]*height:44px/);
  assert.match(html, /\.ci-draft-actions button,.ci-review-actions button\{[^}]*min-height:44px/);
  assert.match(html, /@media\(max-width:840px\)/);
  assert.match(html, /@media\(max-width:560px\)/);
  assert.match(html, /\.ci-rail-activity\{display:grid;grid-template-columns:auto minmax\(0,1fr\)/);
  assert.match(html, /\.ci-rail-activity\{grid-template-columns:auto minmax\(0,1fr\);align-items:start/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
});

test('renders manager-only approval and consent-gated TEST queue controls without a live send route', () => {
  const approval = render(createPropertyPredatorTestInboxSnapshot(), { channel: 'email' }, ACTION_SECURITY);
  assert.match(approval, /action="\/portal\/inbox\/approval-requests\/80000000-0000-4000-8000-000000000001\/decisions"/);
  assert.match(approval, /Approve exact v1/);
  assert.match(approval, /Request changes/);
  assert.match(approval, /Reject/);

  const queue = render(createPropertyPredatorTestInboxSnapshot(), { channel: 'sms' }, ACTION_SECURITY);
  assert.match(queue, /action="\/portal\/inbox\/messages\/60000000-0000-4000-8000-000000000004\/test-queue"/);
  assert.match(queue, /name="purpose" value="appointment_follow_up"/);
  assert.match(queue, />Queue TEST operation<\/button>/);
  assert.doesNotMatch(queue, /action="[^"]*(?:send|deliver|publish)/i);
});

test('reports a clipped database draft and locks approval so its unseen tail cannot be approved', () => {
  const base = createPropertyPredatorTestInboxSnapshot();
  const hiddenTail = 'TAIL-MUST-BE-REVIEWED';
  const fullDraft = `${'x'.repeat(CONVERSION_INBOX_MAX_MESSAGE_BYTES)}${hiddenTail}`;
  const snapshot: ConversionInboxSnapshot = {
    ...base,
    threads: [{
      ...base.threads[0]!,
      draft: {
        ...base.threads[0]!.draft,
        body: fullDraft,
      },
    }, ...base.threads.slice(1)],
  };
  const view = presentConversionInbox(snapshot, {
    workspaceName: 'Property Predator Growth HQ',
    filters: { channel: 'email' },
  });
  const html = renderConversionInboxBody(view, { security: ACTION_SECURITY });

  assert.equal(view.selectedThread?.draft.bodyTruncated, true);
  assert.equal(view.selectedThread?.draft.body.endsWith(hiddenTail), false);
  assert.equal(view.selectedThread?.draft.mayQueueTestOperation, false);
  assert.doesNotMatch(html, new RegExp(hiddenTail));
  assert.match(html, /Long draft clipped at the safe display boundary/);
  assert.match(html, /Approval, editing and queueing are locked until the complete draft can be reviewed/);
  assert.match(html, />Full review required<\/button>/);
  assert.doesNotMatch(html, />Approve exact v1<\/button>/);
  assert.doesNotMatch(html, /approval-requests\/80000000-0000-4000-8000-000000000001\/decisions/);
});

test('Conversion Inbox notices are session-bound and describe only protected TEST outcomes', () => {
  const secret = 'conversion-inbox-notice-secret';
  const session = 'conversion-inbox-session-a';
  const token = conversionInboxNoticeToken(secret, session, 'test_queued');
  const notice = conversionInboxNoticeFromQuery(
    new URLSearchParams({ notice: token }),
    secret,
    session,
  );
  assert.equal(notice?.title, 'TEST operation queued');
  assert.match(notice?.message ?? '', /non-routable simulator operation/);
  assert.match(notice?.message ?? '', /No real person, account or provider was contacted/);
  assert.equal(conversionInboxNoticeFromQuery(
    new URLSearchParams({ notice: token }),
    secret,
    'different-session',
  ), undefined);
  assert.equal(conversionInboxNoticeFromQuery(
    new URLSearchParams({ notice: `${token}tampered` }),
    secret,
    session,
  ), undefined);
});

test('preserves filters in selected-thread links and exposes an honest bounded state', () => {
  const base = createPropertyPredatorTestInboxSnapshot();
  const snapshot: ConversionInboxSnapshot = {
    ...base,
    page: {
      ...base.page,
      nextCursor: {
        beforeLastMessageAt: '2026-08-25T16:52:00.000Z',
        beforeConversationId: base.page.conversations.at(-1)!.conversationId,
      },
    },
  };
  const html = render(snapshot, { channel: 'email', queue: 'unread', query: 'Aisha' });
  assert.match(html, /href="\/portal\/inbox\?q=Aisha&amp;channel=email&amp;queue=unread&amp;conversation=10000000-0000-4000-8000-000000000001"/);
  assert.match(html, /<strong>Bounded queue\.<\/strong>/);
  assert.match(html, /more may exist/);
  assert.doesNotMatch(html, /only conversations|complete queue/i);
});

test('renders a safe empty detail state when no matching thread projection is available', () => {
  const base = createPropertyPredatorTestInboxSnapshot();
  const html = render({ page: base.page, threads: [] });
  assert.match(html, /Select a loaded test conversation/);
  assert.match(html, /No provider is connected/);
  assert.doesNotMatch(html, /id="ci-reply-draft"/);
});
