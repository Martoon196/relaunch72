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
} from '../src/portal/live-channels-presenter.js';
import { renderLiveChannelsBody } from '../src/portal/live-channels-view.js';
import type { PortalLiveChannelsSnapshot } from '../src/portal/live-channels-service.js';

type MutableSnapshot = {
  workspace: { workspaceId: string; workspaceName: string; snapshotAt: string };
  dataset: 'evidence' | 'illustrative_fixture';
  channels: Array<Record<string, any>>;
  receipts: Array<Record<string, any>>;
  handoff: Record<string, any>;
};

function mutable(): MutableSnapshot {
  return structuredClone(createPropertyPredatorLiveChannelsFixture()) as unknown as MutableSnapshot;
}

function snapshotOf(data: MutableSnapshot): PortalLiveChannelsSnapshot {
  return data as unknown as PortalLiveChannelsSnapshot;
}

/** Evidence snapshot where customer email is genuinely live inside its caps. */
function evidence(): MutableSnapshot {
  const data = mutable();
  data.dataset = 'evidence';
  data.channels[0]!.switches.emergencyPaused = false;
  return data;
}

const RENDER = {
  csrfToken: 'test-csrf-token',
  pauseCommandAvailable: false,
  pauseCommandKeys: {
    all: 'fa900000-0000-4000-8000-0000000000a1',
    customer_email_mailgun: 'fa900000-0000-4000-8000-0000000000a2',
    owned_public_social: 'fa900000-0000-4000-8000-0000000000a3',
    meta_whatsapp: 'fa900000-0000-4000-8000-0000000000a4',
  },
  railStatusAvailable: true,
} as const;

test('route constants live under /portal/channels', () => {
  assert.equal(LIVE_CHANNELS_ROUTE, '/portal/channels/live');
  assert.equal(LIVE_CHANNELS_PAUSE_ROUTE, '/portal/channels/live/emergency-pause');
});

test('fixture presents with derived postures and no deliverable channel', () => {
  const view = presentLiveChannels(createPropertyPredatorLiveChannelsFixture());
  assert.equal(view.illustrative, true);
  assert.equal(view.snapshotAt, PROPERTY_PREDATOR_LIVE_CHANNELS_AS_OF);
  assert.deepEqual(view.channels.map((channel) => channel.posture), ['paused', 'blocked', 'not_connected']);
  assert.equal(view.readyCount, 0);
  assert.equal(view.launchReadinessLabel, '0 of 3 channels live');
  assert.equal(view.allPaused, true);
  assert.equal(view.totalApprovalsPending, 3);
  assert.equal(view.totalUsedToday, 5);
  assert.equal(view.totalDailyCap, 12);
});

test('presenter derives ready and degraded only from proven evidence', () => {
  const live = presentLiveChannels(snapshotOf(evidence()));
  assert.equal(live.channels[0]!.posture, 'ready');
  assert.equal(live.readyCount, 1);
  assert.equal(live.allPaused, false);

  const attention = evidence();
  attention.channels[0]!.dispatch.needsAttentionCount = 2;
  assert.equal(presentLiveChannels(snapshotOf(attention)).channels[0]!.posture, 'degraded');
});

test('an illustrative fixture can never depict a deliverable channel', () => {
  const data = mutable();
  data.channels[0]!.switches.emergencyPaused = false;
  assert.throws(() => presentLiveChannels(snapshotOf(data)), /illustrative fixture can never depict a deliverable/);
});

test('caps must match the foundation hard caps exactly', () => {
  const data = mutable();
  data.channels[0]!.caps.dailyCap = 11;
  assert.throws(() => presentLiveChannels(snapshotOf(data)), /caps do not match the foundation hard caps/);
});

test('usage can never exceed a hard cap or its month', () => {
  const overCap = mutable();
  overCap.channels[0]!.caps.usedToday = 51;
  overCap.channels[0]!.caps.usedThisMonth = 51;
  assert.throws(() => presentLiveChannels(snapshotOf(overCap)), /usage exceeds its hard cap/);

  const inverted = mutable();
  inverted.channels[0]!.caps.usedToday = 10;
  inverted.channels[0]!.caps.usedThisMonth = 4;
  assert.throws(() => presentLiveChannels(snapshotOf(inverted)), /daily usage cannot exceed monthly usage/);
});

test('a channel cannot claim a foreign provider, mode or contract', () => {
  const provider = mutable();
  provider.channels[0]!.identity.providerId = 'ayrshare';
  assert.throws(() => presentLiveChannels(snapshotOf(provider)), /foreign provider/);

  const mode = mutable();
  mode.channels[0]!.switches.mode = 'owned_profile_live';
  assert.throws(() => presentLiveChannels(snapshotOf(mode)), /foreign execution mode/);

  const contract = mutable();
  contract.channels[0]!.identity.contract = 'propertypredator.meta-whatsapp-live/v1';
  assert.throws(() => presentLiveChannels(snapshotOf(contract)), /not bound to its foundation contract/);
});

test('receipts are validated against the channel contract and the snapshot instant', () => {
  const kind = mutable();
  kind.channels[1]!.latestReceipt = {
    eventKind: 'delivered',
    safeCode: 'ayrshare_published',
    occurredAt: '2026-08-26T18:20:00.000Z',
    recordedAt: '2026-08-26T18:20:30.000Z',
  };
  assert.throws(() => presentLiveChannels(snapshotOf(kind)), /outside the Owned social publishing contract/);

  const future = mutable();
  future.channels[0]!.latestReceipt.occurredAt = '2026-08-27T12:00:01.000Z';
  assert.throws(() => presentLiveChannels(snapshotOf(future)), /newer than its snapshot/);

  const order = mutable();
  const [first, second] = order.receipts;
  order.receipts[0] = second!;
  order.receipts[1] = first!;
  assert.throws(() => presentLiveChannels(snapshotOf(order)), /newest first/);
});

test('the exact channel set is required', () => {
  const missing = mutable();
  missing.channels.pop();
  assert.throws(() => presentLiveChannels(snapshotOf(missing)), /exact channel set/);

  const duplicated = mutable();
  duplicated.channels[2] = structuredClone(duplicated.channels[0]!);
  assert.throws(() => presentLiveChannels(snapshotOf(duplicated)), /incomplete or duplicated/);
});

test('switch and worker evidence must be proven booleans, never truthy stand-ins', () => {
  const effects = evidence();
  effects.channels[0]!.switches.providerEffectsEnabled = 'false';
  assert.throws(() => presentLiveChannels(snapshotOf(effects)), /proven boolean/);

  const delivery = evidence();
  delivery.channels[0]!.switches.deliveryEnabled = 'false';
  assert.throws(() => presentLiveChannels(snapshotOf(delivery)), /proven boolean/);

  const paused = mutable();
  paused.channels[0]!.switches.emergencyPaused = 1;
  assert.throws(() => presentLiveChannels(snapshotOf(paused)), /proven boolean/);

  const worker = mutable();
  worker.channels[0]!.dispatch.workerComposed = 'yes';
  assert.throws(() => presentLiveChannels(snapshotOf(worker)), /proven boolean/);
});

test('secret-shaped blocker messages and safe codes are refused', () => {
  const blocker = mutable();
  blocker.channels[1]!.blockers = [{
    code: 'PROVIDER_REJECTED',
    message: `Ayrshare rejected credential ${'a1b2c3d4'.repeat(8)} during publish.`,
  }];
  assert.throws(() => presentLiveChannels(snapshotOf(blocker)), /secret-shaped/);

  const code = mutable();
  code.channels[0]!.latestReceipt.safeCode = `k${'0123456789abcdef'.repeat(4)}`;
  assert.throws(() => presentLiveChannels(snapshotOf(code)), /secret-shaped/);
});

test('a timeline entry newer than its channel latest receipt is a contradiction', () => {
  const orphan = mutable();
  orphan.channels[2]!.latestReceipt = null;
  orphan.receipts.unshift({
    channel: 'meta_whatsapp',
    eventKind: 'accepted',
    safeCode: 'meta_whatsapp_accepted',
    occurredAt: '2026-08-27T11:00:00.000Z',
    recordedAt: '2026-08-27T11:00:10.000Z',
  });
  assert.throws(() => presentLiveChannels(snapshotOf(orphan)), /timeline contradicts its latest receipt/);

  const newer = mutable();
  newer.channels[0]!.latestReceipt.occurredAt = '2026-08-27T09:00:00.000Z';
  newer.channels[0]!.latestReceipt.eventKind = 'dispatch_accepted';
  assert.throws(() => presentLiveChannels(snapshotOf(newer)), /timeline contradicts its latest receipt/);
});

test('secret-shaped identity labels are refused', () => {
  const keyish = mutable();
  keyish.channels[0]!.identity.accountLabel = 'api_key mg.propertypredator.com';
  assert.throws(() => presentLiveChannels(snapshotOf(keyish)), /secret-shaped/);

  const opaque = mutable();
  opaque.channels[0]!.identity.connectionLabel = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  assert.throws(() => presentLiveChannels(snapshotOf(opaque)), /secret-shaped/);
});

test('contradictory operational evidence is refused', () => {
  const ghost = mutable();
  ghost.channels[2]!.dispatch.inFlightCount = 1;
  assert.throws(() => presentLiveChannels(snapshotOf(ghost)), /uncomposed worker cannot hold in-flight work/);

  const approvals = mutable();
  approvals.channels[2]!.approvals.oldestPendingAt = '2026-08-26T10:00:00.000Z';
  assert.throws(() => presentLiveChannels(snapshotOf(approvals)), /approval queue evidence is contradictory/);

  const blocker = mutable();
  blocker.channels[1]!.blockers = [{ code: 'bad code', message: 'Too-short.' }];
  assert.throws(() => presentLiveChannels(snapshotOf(blocker)), /blocker evidence is invalid/);
});

test('derived switch-gap blockers are appended and labelled', () => {
  const view = presentLiveChannels(createPropertyPredatorLiveChannelsFixture());
  const social = view.channels[1]!;
  assert.equal(social.whyBlocked[0]!.code, 'SOURCE_ATTESTATION_EXPIRED');
  assert.equal(social.whyBlocked[0]!.derived, false);
  assert.ok(social.whyBlocked.some((item) => item.code === 'PROVIDER_EFFECTS_OFF' && item.derived));
  const whatsapp = view.channels[2]!;
  assert.deepEqual(
    whatsapp.whyBlocked.map((item) => item.code),
    ['MODE_DISABLED', 'PROVIDER_EFFECTS_OFF', 'WORKER_NOT_COMPOSED', 'PERMISSION_NOT_GRANTED'],
  );
});

test('view renders the fixture truthfully with the illustrative boundary', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), RENDER);
  assert.match(html, /ILLUSTRATIVE TEST DATA/);
  assert.match(html, /NO PROVIDER WAS READ/);
  assert.match(html, /data-dataset="illustrative_fixture"/);
  assert.match(html, /0 of 3 channels live/);
  assert.doesNotMatch(html, /All channels live/);
  assert.match(html, /ALL RAILS PAUSED/);
  assert.match(html, /5 of 12 capped dispatches used/);
  assert.match(html, /4 \/ 10/);
  assert.match(html, /aria-current="page">Live Channels/);
  assert.match(html, /mg\.propertypredator\.com/);
  assert.match(html, /propertypredator\.customer-email-live\/v1/);
  assert.match(html, /PAUSE ENGAGED/);
  assert.doesNotMatch(html, /api[_-]?key|secret|bearer/i);
});

test('view renders evidence dataset with its own boundary copy', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(snapshotOf(evidence())), RENDER);
  assert.match(html, /OBSERVED EVIDENCE/);
  assert.match(html, /READ-ONLY EVIDENCE/);
  assert.doesNotMatch(html, /ILLUSTRATIVE TEST DATA/);
  assert.match(html, /Connected · ready/);
});

test('view escapes hostile persisted content', () => {
  const data = evidence();
  data.channels[0]!.identity.accountLabel = '<img src=x onerror=alert(1)>';
  data.channels[0]!.permission.detail = '<script>alert(1)</script> granted';
  data.workspace.workspaceName = '"><svg onload=alert(1)>';
  const html = renderLiveChannelsBody(presentLiveChannels(snapshotOf(data)), RENDER);
  assert.doesNotMatch(html, /<script>alert|<img src=x|<svg onload/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; granted/);
});

test('view carries accessible landmarks, focus and adaptive media rules', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), RENDER);
  assert.match(html, /<section class="plc" aria-labelledby="live-channels-title"/);
  assert.match(html, /aria-labelledby="live-customer-email-mailgun-title"/);
  assert.match(html, /<aside class="plc-boundary" role="status">/);
  assert.match(html, /aria-label="Launch readiness"/);
  assert.match(html, /aria-label="Execution and effect switches"/);
  assert.match(html, /aria-label="Caps and usage"/);
  assert.match(html, /focus-visible\{outline:3px solid var\(--plc-teal\)/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.match(html, /outline-color:Highlight/);
  assert.match(html, /@media\(max-width:1180px\)/);
  assert.match(html, /@media\(max-width:760px\)/);
  assert.match(html, /@media\(max-width:480px\)/);
  assert.match(html, /min-height:48px/);
  assert.match(html, /min-height:44px/);
  const gaugeBars = html.match(/class="plc-gauge-track" aria-hidden="true"/g) ?? [];
  assert.equal(gaugeBars.length, 6);
});

test('cap gauge percentages stay clamped and honest', () => {
  const view = presentLiveChannels(createPropertyPredatorLiveChannelsFixture());
  for (const channel of view.channels) {
    for (const gaugeView of channel.gauges) {
      assert.ok(gaugeView.percent >= 0 && gaugeView.percent <= 100);
      assert.ok(gaugeView.used <= gaugeView.cap);
    }
  }
  const social = view.channels[1]!;
  assert.equal(social.gauges[0]!.percent, 100);
  assert.equal(social.gauges[0]!.attention, true);
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

test('emergency controls are honest about the missing command seam', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(snapshotOf(evidence())), RENDER);
  assert.match(html, /command seam not composed/);
  assert.match(html, /disabled aria-disabled="true"/);
  assert.doesNotMatch(html, new RegExp(`<form method="post" action="${LIVE_CHANNELS_PAUSE_ROUTE}"`));
});

test('emergency controls demand deliberate confirmation when the seam exists', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(snapshotOf(evidence())), {
    ...RENDER,
    pauseCommandAvailable: true,
  });
  assert.match(html, new RegExp(`<form method="post" action="${LIVE_CHANNELS_PAUSE_ROUTE}"`));
  assert.match(html, /name="_csrf" value="test-csrf-token"/);
  assert.match(html, /name="scope" value="customer_email_mailgun"/);
  assert.match(html, /name="scope" value="all"/);
  assert.match(html, /type="checkbox" name="confirm_pause" value="ENGAGE" required/);
  // The fail-safe boundary: no control can ever release or resume a pause.
  assert.doesNotMatch(html, /name="confirm_resume"|name="confirm_release"|>Release pause|>Resume dispatch/i);
  assert.match(html, /deliberately no resume control here/);
  // A rail that is already paused never renders a pause form.
  const paused = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), {
    ...RENDER,
    pauseCommandAvailable: true,
  });
  assert.doesNotMatch(paused, /name="scope" value="customer_email_mailgun"/);
});

test('empty receipt timeline renders a truthful empty state', () => {
  const data = mutable();
  data.receipts = [];
  data.channels[0]!.latestReceipt = null;
  data.channels[1]!.latestReceipt = null;
  const html = renderLiveChannelsBody(presentLiveChannels(snapshotOf(data)), RENDER);
  assert.match(html, /No receipts recorded yet\./);
  assert.match(html, /Nothing is inferred; only recorded receipts are shown\./);
});

test('notices render with alert semantics for errors', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), {
    ...RENDER,
    notice: { kind: 'error', title: 'Pause command rejected', message: 'Nothing was changed.' },
  });
  assert.match(html, /class="plc-notice error" role="alert"/);
  const success = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), {
    ...RENDER,
    notice: { kind: 'success', title: 'Emergency pause engaged', message: 'Done.' },
  });
  assert.match(success, /class="plc-notice success" role="status"/);
});

test('cross-surface links land on real portal routes', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), RENDER);
  assert.match(html, /href="\/portal\/inbox\?channel=email"/);
  assert.match(html, /href="\/portal\/inbox\?channel=whatsapp"/);
  assert.match(html, /href="\/portal\/inbox\?queue=approval"/);
  assert.match(html, /href="\/portal\/inbox"/);
  assert.match(html, /href="\/portal\/campaigns"/);
  assert.match(html, /href="\/portal\/content\/calendar"/);
  assert.match(html, /href="\/portal\/providers\/readiness"/);
  assert.match(html, /href="\/portal\/crm\/contacts"/);
});

test('rail status links disappear when the readiness cockpit is not composed', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), {
    ...RENDER,
    railStatusAvailable: false,
  });
  assert.doesNotMatch(html, /href="\/portal\/providers\/readiness"/);
  // The safe-next-action copy survives even when its link is withheld.
  assert.match(html, /Clear the first blocker/);
});

test('each pause form carries its own scope-bound command key', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(snapshotOf(evidence())), {
    ...RENDER,
    pauseCommandAvailable: true,
  });
  assert.match(html, /name="command_key" value="fa900000-0000-4000-8000-0000000000a1"/);
  assert.match(html, /name="command_key" value="fa900000-0000-4000-8000-0000000000a2"/);
  const emailForm = /name="command_key" value="([^"]+)">\s*<input type="hidden" name="scope" value="customer_email_mailgun"/.exec(html);
  assert.ok(emailForm);
  assert.equal(emailForm![1], RENDER.pauseCommandKeys.customer_email_mailgun);
});
