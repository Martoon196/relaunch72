import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPropertyPredatorLiveChannelsFixture,
  PROPERTY_PREDATOR_LIVE_CHANNELS_AS_OF,
} from '../src/portal/live-channels-fixtures.js';
import {
  LIVE_CHANNELS_PAUSE_ROUTE,
  LIVE_CHANNELS_ROUTE,
  presentLiveChannels,
  type LiveChannelsSourceSnapshot,
} from '../src/portal/live-channels-presenter.js';
import { renderLiveChannelsBody } from '../src/portal/live-channels-view.js';

type MutableSnapshot = {
  workspaceId: string;
  snapshotAt: string;
  dataset: 'postgres_authoritative' | 'illustrative_fixture';
  rails: Array<Record<string, any>>;
};

function mutable(): MutableSnapshot {
  return structuredClone(createPropertyPredatorLiveChannelsFixture()) as unknown as MutableSnapshot;
}

function snapshotOf(data: MutableSnapshot): LiveChannelsSourceSnapshot {
  return data as unknown as LiveChannelsSourceSnapshot;
}

/** Authoritative snapshot where customer email is genuinely live inside its caps. */
function authoritative(): MutableSnapshot {
  const data = mutable();
  data.dataset = 'postgres_authoritative';
  data.rails[0]!.outboundOrReplyState = 'ready';
  data.rails[0]!.blockerCodes = [];
  return data;
}

const RENDER = {
  workspaceName: 'Property Predator Growth HQ',
  csrfToken: 'test-csrf-token',
  pauseCommandAvailable: false,
  pauseCommandKeys: {
    all: 'fa900000-0000-4000-8000-0000000000a1',
    customer_email: 'fa900000-0000-4000-8000-0000000000a2',
    owned_social: 'fa900000-0000-4000-8000-0000000000a3',
    whatsapp: 'fa900000-0000-4000-8000-0000000000a4',
    sms: 'fa900000-0000-4000-8000-0000000000a6',
    social_dm: 'fa900000-0000-4000-8000-0000000000a5',
  },
  railStatusAvailable: true,
  handoff: {
    conversionInboxComposed: true,
    inboxOperationsComposed: true,
    lead360Composed: true,
  },
} as const;

test('route constants live under /portal/channels', () => {
  assert.equal(LIVE_CHANNELS_ROUTE, '/portal/channels/live');
  assert.equal(LIVE_CHANNELS_PAUSE_ROUTE, '/portal/channels/live/emergency-pause');
});

test('fixture presents five rails with derived postures and no deliverable channel', () => {
  const view = presentLiveChannels(createPropertyPredatorLiveChannelsFixture());
  assert.equal(view.illustrative, true);
  assert.equal(view.snapshotAt, PROPERTY_PREDATOR_LIVE_CHANNELS_AS_OF);
  assert.deepEqual(
    view.channels.map((channel) => [channel.rail, channel.posture]),
    [
      ['customer_email', 'paused'],
      ['owned_social', 'blocked'],
      ['whatsapp', 'blocked'],
      ['sms', 'not_connected'],
      ['social_dm', 'not_connected'],
    ],
  );
  assert.equal(view.readyCount, 0);
  assert.equal(view.launchReadinessLabel, '0 of 5 channels live');
  assert.equal(view.allComposedPaused, false);
  assert.equal(view.totalUsedToday, 4);
  assert.equal(view.totalDailyCap, 22);
  assert.equal(view.attentionRailCount, 1);
  assert.deepEqual(view.approvalRequiredRailLabels, ['Meta WhatsApp']);
  assert.deepEqual(
    view.latestReceipts.map((receipt) => receipt.rail),
    ['customer_email', 'whatsapp', 'owned_social'],
  );
  assert.equal(view.whatsappInboundReady, false);
});

test('ready and degraded derive only from authoritative evidence', () => {
  const live = presentLiveChannels(snapshotOf(authoritative()));
  assert.equal(live.channels[0]!.posture, 'ready');
  assert.equal(live.readyCount, 1);
  assert.equal(live.launchReadinessLabel, '1 of 5 channels live');

  const degraded = authoritative();
  degraded.rails[0]!.connectionState = 'degraded';
  assert.equal(presentLiveChannels(snapshotOf(degraded)).channels[0]!.posture, 'degraded');
});

test('an emergency-paused rail reads as paused, not ready', () => {
  const paused = authoritative();
  paused.rails[0]!.blockerCodes = ['EMERGENCY_PAUSED'];
  const view = presentLiveChannels(snapshotOf(paused));
  assert.equal(view.channels[0]!.posture, 'paused');
  assert.equal(view.channels[0]!.pauseEngaged, true);
});

test('a configured-but-unproven connection can never read as ready', () => {
  const configured = authoritative();
  configured.rails[0]!.connectionState = 'configured';
  const card = presentLiveChannels(snapshotOf(configured)).channels[0]!;
  assert.equal(card.posture, 'blocked');
  assert.ok(card.whyBlocked.some((blocker) =>
    blocker.code === 'CONNECTION_NOT_PROVEN_READY' && blocker.derived));
});

test('an illustrative fixture can never depict a deliverable channel', () => {
  const data = mutable();
  data.rails[0]!.outboundOrReplyState = 'ready';
  data.rails[0]!.blockerCodes = [];
  assert.throws(() => presentLiveChannels(snapshotOf(data)), /illustrative fixture can never depict a deliverable/);
});

test('the dataset discriminator is required and closed', () => {
  const data = mutable();
  (data as any).dataset = 'evidence';
  assert.throws(() => presentLiveChannels(snapshotOf(data)), /dataset is invalid/);
});

test('the exact four-rail set is required', () => {
  const missing = mutable();
  missing.rails.pop();
  assert.throws(() => presentLiveChannels(snapshotOf(missing)), /exact four-rail set/);

  const duplicated = mutable();
  duplicated.rails[3] = structuredClone(duplicated.rails[0]!);
  assert.throws(() => presentLiveChannels(snapshotOf(duplicated)), /incomplete or duplicated/);
});

test('the social DM rail accepts composed Zernio evidence and rejects retired adapter claims', () => {
  const ready = authoritative();
  ready.rails[4]!.connectionState = 'ready';
  ready.rails[4]!.inboundState = 'ready';
  ready.rails[4]!.outboundOrReplyState = 'ready';
  ready.rails[4]!.blockerCodes = [];
  assert.equal(presentLiveChannels(snapshotOf(ready)).channels[4]!.posture, 'ready');

  const retired = mutable();
  retired.rails[4]!.connectionState = 'not_composed';
  retired.rails[4]!.outboundOrReplyState = 'not_supported';
  retired.rails[4]!.blockerCodes = ['LIVE_ADAPTER_NOT_COMPOSED'];
  assert.throws(() => presentLiveChannels(snapshotOf(retired)), /composed Zernio account and reply evidence/);
});

test('caps must match the foundation hard caps and stay internally consistent', () => {
  const wrongLimit = mutable();
  wrongLimit.rails[0]!.caps.daily.limit = 11;
  assert.throws(() => presentLiveChannels(snapshotOf(wrongLimit)), /caps do not match the foundation hard caps/);

  const badRemaining = mutable();
  badRemaining.rails[0]!.caps.daily.remaining = 5;
  assert.throws(() => presentLiveChannels(snapshotOf(badRemaining)), /cap windows are contradictory/);

  const inverted = mutable();
  inverted.rails[0]!.caps.daily.used = 6;
  inverted.rails[0]!.caps.daily.remaining = 4;
  inverted.rails[0]!.caps.monthly.used = 5;
  inverted.rails[0]!.caps.monthly.remaining = 45;
  assert.throws(() => presentLiveChannels(snapshotOf(inverted)), /cap windows are contradictory/);
});

test('cap-reached evidence must agree across state, code and counts', () => {
  const silent = authoritative();
  silent.rails[0]!.caps.daily.used = 10;
  silent.rails[0]!.caps.daily.remaining = 0;
  silent.rails[0]!.caps.monthly.used = 10;
  silent.rails[0]!.caps.monthly.remaining = 40;
  assert.throws(() => presentLiveChannels(snapshotOf(silent)), /cap evidence is contradictory/);
});

test('blocker codes must accompany the states that imply them', () => {
  const effects = mutable();
  effects.rails[1]!.blockerCodes = ['OUTCOME_UNKNOWN_QUARANTINED'];
  assert.throws(() => presentLiveChannels(snapshotOf(effects)), /blocker codes contradict its states/);

  const duplicate = mutable();
  duplicate.rails[1]!.blockerCodes = ['EFFECTS_DISABLED', 'EFFECTS_DISABLED', 'OUTCOME_UNKNOWN_QUARANTINED'];
  assert.throws(() => presentLiveChannels(snapshotOf(duplicate)), /invalid or duplicated/);

  const unknown = mutable();
  unknown.rails[1]!.blockerCodes = ['EFFECTS_DISABLED', 'OUTCOME_UNKNOWN_QUARANTINED', 'NOT_A_CODE'];
  assert.throws(() => presentLiveChannels(snapshotOf(unknown)), /invalid or duplicated/);
});

test('receipts are validated for presence, pairing, identity and instant', () => {
  const orphan = mutable();
  orphan.rails[3]!.latestReceipt = {
    receiptId: 'fa300000-0000-4000-8000-000000000009',
    outcome: 'accepted',
    recordedAt: '2026-08-27T08:00:00.000Z',
    evidenceSha256: 'd'.repeat(64),
  };
  assert.throws(() => presentLiveChannels(snapshotOf(orphan)), /receipt presence contradicts/);

  const mismatch = mutable();
  mismatch.rails[0]!.latestReceipt.outcome = 'failed';
  assert.throws(() => presentLiveChannels(snapshotOf(mismatch)), /outcome contradicts its receipt state/);

  const future = mutable();
  future.rails[0]!.latestReceipt.recordedAt = '2026-08-27T12:00:01.000Z';
  assert.throws(() => presentLiveChannels(snapshotOf(future)), /newer than its snapshot/);

  const badSha = mutable();
  badSha.rails[0]!.latestReceipt.evidenceSha256 = 'not-a-sha';
  assert.throws(() => presentLiveChannels(snapshotOf(badSha)), /receipt evidence is invalid/);

  const badId = mutable();
  badId.rails[0]!.latestReceipt.receiptId = 'nope';
  assert.throws(() => presentLiveChannels(snapshotOf(badId)), /receipt evidence is invalid/);
});

test('view renders the fixture truthfully with the illustrative boundary', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), RENDER);
  assert.match(html, /ILLUSTRATIVE TEST DATA/);
  assert.match(html, /NO PROVIDER WAS READ/);
  assert.match(html, /data-dataset="illustrative_fixture"/);
  assert.match(html, /0 of 5 channels live/);
  assert.doesNotMatch(html, /All channels live/);
  assert.match(html, /4 of 22 capped dispatches used/);
  assert.match(html, /4 \/ 10/);
  assert.match(html, /aria-current="page">Live Channels/);
  assert.match(html, /Social DMs/);
  assert.match(html, /PROVIDER_NOT_CONFIGURED/);
  assert.match(html, /PAUSE ENGAGED/);
  assert.match(html, /not yet readable/);
  assert.doesNotMatch(html, /api[_-]?key|secret=|bearer/i);
});

test('view renders authoritative evidence with its own boundary copy', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(snapshotOf(authoritative())), RENDER);
  assert.match(html, /POSTGRES-AUTHORITATIVE EVIDENCE/);
  assert.match(html, /READ-ONLY EVIDENCE/);
  assert.match(html, /data-dataset="postgres_authoritative"/);
  assert.doesNotMatch(html, /ILLUSTRATIVE TEST DATA/);
  assert.match(html, /Connected · ready/);
});

test('static banners are labelled sections, not live regions', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), RENDER);
  assert.match(html, /<section class="plc-boundary" aria-label="Data provenance">/);
  assert.doesNotMatch(html, /plc-boundary[^>]*role=/);
});

test('post-action notices keep status and alert semantics', () => {
  const error = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), {
    ...RENDER,
    notice: { kind: 'error', title: 'Pause command rejected', message: 'Nothing was changed.' },
  });
  assert.match(error, /class="plc-notice error" role="alert"/);
  const success = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), {
    ...RENDER,
    notice: { kind: 'success', title: 'Emergency pause engaged', message: 'Done.' },
  });
  assert.match(success, /class="plc-notice success" role="status"/);
});

test('view escapes hostile dynamic content', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), {
    ...RENDER,
    workspaceName: '"><svg onload=alert(1)>',
    notice: { kind: 'info', title: '<script>alert(1)</script>', message: '<img src=x onerror=alert(1)>' },
  });
  assert.doesNotMatch(html, /<script>alert|<img src=x|<svg onload/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('view carries accessible landmarks, focus and adaptive media rules', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), RENDER);
  assert.match(html, /<section class="plc" aria-labelledby="live-channels-title"/);
  assert.match(html, /aria-labelledby="live-customer-email-title"/);
  assert.match(html, /aria-labelledby="live-social-dm-title"/);
  assert.match(html, /aria-label="Launch readiness"/);
  assert.match(html, /aria-label="Proven rail states"/);
  assert.match(html, /aria-label="Caps and usage"/);
  assert.match(html, /focus-visible\{outline:3px solid var\(--plc-teal\)/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.match(html, /outline-color:Highlight/);
  assert.match(html, /@media\(max-width:1180px\)/);
  assert.match(html, /@media\(max-width:1024px\)/);
  assert.match(html, /@media\(max-width:760px\)/);
  assert.match(html, /@media\(max-width:480px\)/);
  assert.match(html, /min-height:48px/);
  assert.match(html, /min-height:44px/);
  const gaugeBars = html.match(/class="plc-gauge-track" aria-hidden="true"/g) ?? [];
  assert.equal(gaugeBars.length, 10);
});

test('small text tokens keep WCAG AA contrast on their dark surfaces', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), RENDER);
  const token = (name: string): string => {
    const match = html.match(new RegExp(`--plc-${name}:(#[0-9a-f]{6})`, 'i'));
    assert.ok(match, `missing colour token --plc-${name}`);
    return match![1]!;
  };
  const luminance = (hex: string): number => {
    const channels = hex.slice(1).match(/.{2}/g)!.map((value) => Number.parseInt(value, 16) / 255);
    const [red, green, blue] = channels.map((value) => (
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    ));
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  };
  const ratio = (fg: string, bg: string): number => {
    const [a, b] = [luminance(fg), luminance(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  for (const [fg, bg] of [
    ['ink', 'panel'], ['muted', 'panel'], ['faint', 'panel'],
    ['teal', 'bg'], ['green', 'bg'], ['amber', 'bg'], ['red', 'bg'],
  ] as const) {
    assert.ok(
      ratio(token(fg), token(bg)) >= 4.5,
      `--plc-${fg} must retain 4.5:1 contrast on --plc-${bg}`,
    );
  }
});

test('emergency controls stay honest about the missing command boundary', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), RENDER);
  assert.match(html, /command boundary not composed/);
  assert.match(html, /disabled aria-disabled="true"/);
  assert.doesNotMatch(html, new RegExp(`<form method="post" action="${LIVE_CHANNELS_PAUSE_ROUTE}"`));
  // The fail-safe boundary: no control can ever release or resume a pause.
  assert.doesNotMatch(html, /name="confirm_resume"|name="confirm_release"|>Release pause|>Resume dispatch/i);
  assert.match(html, /deliberately no resume control here/);
});

test('preview-only pause forms demand deliberate confirmation with scope-bound keys', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), {
    ...RENDER,
    pauseCommandAvailable: true,
  });
  assert.match(html, new RegExp(`<form method="post" action="${LIVE_CHANNELS_PAUSE_ROUTE}"`));
  assert.match(html, /type="checkbox" name="confirm_pause" value="ENGAGE" required/);
  assert.match(html, /name="scope" value="all"/);
  assert.match(html, /name="scope" value="owned_social"/);
  // An engaged rail never renders a pause form.
  assert.doesNotMatch(html, /name="scope" value="customer_email"/);
  const socialForm = /name="command_key" value="([^"]+)">\s*<input type="hidden" name="scope" value="owned_social"/.exec(html);
  assert.ok(socialForm);
  assert.equal(socialForm![1], RENDER.pauseCommandKeys.owned_social);
  assert.match(html, new RegExp(`name="command_key" value="${RENDER.pauseCommandKeys.all}"`));
});

test('empty receipt evidence renders a truthful empty state', () => {
  const data = mutable();
  for (const rail of data.rails) {
    rail.latestReceipt = null;
    rail.receiptState = 'none';
  }
  // Clearing owned_social's receipt removes its outcome_unknown pairing need.
  data.rails[1]!.blockerCodes = ['EFFECTS_DISABLED'];
  const html = renderLiveChannelsBody(presentLiveChannels(snapshotOf(data)), RENDER);
  assert.match(html, /No receipts recorded yet\./);
  assert.match(html, /Nothing is inferred; only recorded receipts are shown\./);
});

test('rail status links disappear when the readiness cockpit is not composed', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), {
    ...RENDER,
    railStatusAvailable: false,
  });
  assert.doesNotMatch(html, /href="\/portal\/providers\/readiness"/);
  assert.match(html, /Clear the first blocker/);
});

test('cross-surface links land on real portal routes', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), RENDER);
  assert.match(html, /href="\/portal\/inbox\?channel=email"/);
  assert.match(html, /href="\/portal\/inbox\?channel=whatsapp"/);
  assert.match(html, /href="\/portal\/inbox\?channel=sms"/);
  assert.match(html, /href="\/portal\/inbox\?queue=approval"/);
  assert.match(html, /href="\/portal\/inbox"/);
  assert.match(html, /href="\/portal\/campaigns"/);
  assert.match(html, /href="\/portal\/content\/calendar"/);
  assert.match(html, /href="\/portal\/providers\/readiness"/);
  assert.match(html, /href="\/portal\/crm\/contacts"/);
});

test('handoff card reflects only proven composition facts', () => {
  const bare = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), {
    ...RENDER,
    handoff: {
      conversionInboxComposed: false,
      inboxOperationsComposed: false,
      lead360Composed: false,
    },
  });
  assert.match(bare, /Conversion Inbox is not composed/);
  assert.match(bare, /Inbox operations are not composed/);
  assert.match(bare, /Lead 360 is not composed/);
  assert.match(bare, /Inbound WhatsApp ingress is not proven ready/);

  const composed = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), RENDER);
  assert.match(composed, /assignment, internal notes and admin calls are live commands/);
});

test('a live rail still gated by approval never says no action is needed', () => {
  // The production customer-email card said both things at once: "A human
  // approval decision is required before anything can dispatch" beside "No
  // action needed — watch the Conversion Inbox for sends as they land". The
  // founder would wait for sends that approval was blocking.
  const data = authoritative();
  data.rails[0]!.outboundOrReplyState = 'approval_required';
  data.rails[0]!.blockerCodes = ['APPROVAL_REQUIRED'];
  const view = presentLiveChannels(snapshotOf(data));
  const card = view.channels[0]!;
  // Connected, healthy, and nothing can leave it. Calling that "ready" and
  // counting it as a live rail was the second half of the same contradiction.
  assert.equal(card.posture, 'gated');
  assert.equal(card.postureLabel, 'Connected · gated');
  assert.notEqual(card.postureTone, 'ready');
  assert.equal(view.gatedCount, 1);
  assert.equal(view.readyCount, 0);
  assert.doesNotMatch(view.launchReadinessLabel, /All channels live/);
  assert.equal(card.approvalRequired, true);
  assert.notEqual(card.nextAction.label, 'No action needed');
  assert.match(card.nextAction.detail, /approval decision is required/);
  assert.match(card.nextAction.detail, /Nothing dispatches until it clears\./);
  // It must point at the gate, not at the Inbox the founder cannot make move.
  assert.match(card.nextAction.link?.href ?? '', /queue=approval/);
  assert.doesNotMatch(card.nextAction.detail, /as they land/);
});

test('a live rail at its cap is told the cap holds it, not to watch for sends', () => {
  // The presenter refuses contradictory cap evidence, so the usage numbers must
  // agree with the code. That guard is why this fixture exhausts the daily cap.
  const data = authoritative();
  data.rails[0]!.outboundOrReplyState = 'cap_reached';
  data.rails[0]!.caps = {
    daily: { used: 10, limit: 10, remaining: 0 },
    monthly: { used: 14, limit: 50, remaining: 36 },
  };
  data.rails[0]!.blockerCodes = ['CAP_REACHED'];
  const view = presentLiveChannels(snapshotOf(data));
  const card = view.channels[0]!;
  assert.equal(card.posture, 'gated');
  assert.equal(card.postureLabel, 'Connected · gated');
  assert.equal(view.readyCount, 0, 'a rail at its cap sends nothing and is not live');
  assert.notEqual(card.nextAction.label, 'No action needed');
  assert.match(card.nextAction.detail, /Nothing dispatches until it clears\./);
  assert.doesNotMatch(card.nextAction.detail, /as they land/);
});

test('every gate on customer email keeps it out of the live rail count', () => {
  // Approval, permission, receipt and cap are four different reasons the same
  // rail cannot send. None of them may be reported as a live sending rail.
  // Each fixture keeps the states and codes consistent, because the presenter
  // refuses contradictory evidence outright.
  const gates: readonly {
    code: string; apply: (rail: Record<string, unknown>) => void; gated: boolean;
  }[] = [
    {
      code: 'APPROVAL_REQUIRED',
      apply: (rail) => {
        rail.outboundOrReplyState = 'approval_required';
        rail.blockerCodes = ['APPROVAL_REQUIRED'];
      },
      gated: true,
    },
    {
      code: 'CAP_REACHED',
      apply: (rail) => {
        rail.outboundOrReplyState = 'cap_reached';
        rail.caps = {
          daily: { used: 10, limit: 10, remaining: 0 },
          monthly: { used: 14, limit: 50, remaining: 36 },
        };
        rail.blockerCodes = ['CAP_REACHED'];
      },
      gated: true,
    },
    {
      // The operator's permission evidence. It stops every send, but the
      // connection is fine, so "Blocked" would describe the wrong thing.
      code: 'OPERATOR_AUTHORITY_REQUIRED',
      apply: (rail) => { rail.blockerCodes = ['OPERATOR_AUTHORITY_REQUIRED']; },
      gated: true,
    },
    {
      code: 'RECEIPT_NEEDS_ATTENTION',
      apply: (rail) => {
        rail.receiptState = 'needs_attention';
        // The receipt evidence must agree with the state, or the presenter
        // refuses the whole snapshot before any posture is derived.
        rail.latestReceipt = {
          receiptId: 'fa300000-0000-4000-8000-00000000000a',
          outcome: 'failed',
          recordedAt: '2026-08-27T08:00:00.000Z',
          evidenceSha256: 'e'.repeat(64),
        };
        rail.blockerCodes = ['RECEIPT_NEEDS_ATTENTION'];
      },
      gated: false,
    },
  ];
  for (const gate of gates) {
    const data = authoritative();
    gate.apply(data.rails[0]! as unknown as Record<string, unknown>);
    const view = presentLiveChannels(snapshotOf(data));
    const card = view.channels[0]!;
    assert.equal(card.rail, 'customer_email', gate.code);
    assert.notEqual(card.posture, 'ready', gate.code);
    assert.notEqual(card.postureLabel, 'Connected · ready', gate.code);
    assert.equal(view.readyCount, 0, gate.code);
    assert.doesNotMatch(view.launchReadinessLabel, /All channels live/, gate.code);
    if (gate.gated) {
      assert.equal(card.posture, 'gated', gate.code);
      assert.equal(card.postureLabel, 'Connected · gated', gate.code);
    }
  }
});

test('a genuinely broken rail is still blocked, not softened into gated', () => {
  // The gate set must not become a way to describe a broken connection as a
  // rail merely waiting on a decision.
  for (const broken of [
    (rail: Record<string, unknown>) => {
      rail.connectionState = 'revoked';
      rail.blockerCodes = ['APPROVAL_REQUIRED'];
      rail.outboundOrReplyState = 'approval_required';
    },
    (rail: Record<string, unknown>) => {
      rail.outboundOrReplyState = 'effects_disabled';
      rail.blockerCodes = ['EFFECTS_DISABLED'];
    },
    (rail: Record<string, unknown>) => {
      rail.blockerCodes = ['APPROVAL_REQUIRED', 'CONSENT_REQUIRED'];
      rail.outboundOrReplyState = 'approval_required';
    },
  ]) {
    const data = authoritative();
    broken(data.rails[0]! as unknown as Record<string, unknown>);
    const card = presentLiveChannels(snapshotOf(data)).channels[0]!;
    assert.equal(card.posture, 'blocked');
  }
});

test('a gated rail is still composed, so the summary does not call it missing', () => {
  const clean = presentLiveChannels(snapshotOf(authoritative()));
  const data = authoritative();
  data.rails[0]!.outboundOrReplyState = 'approval_required';
  data.rails[0]!.blockerCodes = ['APPROVAL_REQUIRED'];
  const view = presentLiveChannels(snapshotOf(data));
  // Gated is a live-rail truth correction, not a claim the rail is absent.
  assert.equal(view.notConnectedCount, clean.notConnectedCount);
  assert.equal(view.channels[0]!.posture, 'gated');
  assert.equal(clean.channels[0]!.posture, 'ready');
});

test('a genuinely clear live rail still says no action is needed', () => {
  // The fix must not turn every live rail into a false alarm.
  const card = presentLiveChannels(snapshotOf(authoritative())).channels[0]!;
  assert.equal(card.posture, 'ready');
  assert.deepEqual(card.whyBlocked, []);
  assert.equal(card.nextAction.label, 'No action needed');
  assert.match(card.nextAction.detail, /as they land/);
});
