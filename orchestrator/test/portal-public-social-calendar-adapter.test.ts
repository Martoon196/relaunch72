import assert from 'node:assert/strict';
import test from 'node:test';
import type { SocialNetwork } from '../src/providers/contracts.js';
import type {
  SocialCampaignCalendarProjection,
  SocialPlanningCalendarProjection,
} from '../src/social-campaign-pg/types.js';
import {
  createPropertyPredatorContentCalendarFixture,
  PROPERTY_PREDATOR_CONTENT_CALENDAR_AS_OF,
} from '../src/portal/content-calendar-fixtures.js';
import { presentContentCalendar } from '../src/portal/content-calendar-presenter.js';
import { renderContentCalendarBody } from '../src/portal/content-calendar-view.js';
import {
  adaptPublicSocialCalendar,
  PublicSocialCalendarAdapterError,
} from '../src/portal/public-social-calendar-adapter.js';

const NETWORKS = Object.freeze([
  'facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube',
  'google_business_profile', 'threads', 'pinterest',
] as const satisfies readonly SocialNetwork[]);

const IDS = Object.freeze({
  campaign: '11111111-1111-4111-8111-111111111111',
  revision: '22222222-2222-4222-8222-222222222222',
  post: '33333333-3333-4333-8333-333333333333',
});

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function firstCatalogItem() {
  const item = createPropertyPredatorContentCalendarFixture().catalog.items[0];
  if (!item) throw new Error('Calendar fixture item missing');
  return item;
}

function projection(
  index = 1,
  overrides: Partial<SocialCampaignCalendarProjection> = {},
): SocialCampaignCalendarProjection {
  const item = firstCatalogItem();
  return Object.freeze({
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    revisionNumber: 4,
    campaignTitle: 'Opportunity Autopsy TEST campaign',
    postId: IDS.post,
    contentItemId: item.contentItemId,
    contentVersionId: item.contentVersionId,
    contentSha256: item.contentSha256,
    planSha256: 'd'.repeat(64),
    scheduledFor: `2026-08-28T${String(8 + index).padStart(2, '0')}:00:00.000Z`,
    operationId: uuid(100 + index),
    targetId: uuid(200 + index),
    network: 'facebook',
    targetLabel: 'Facebook TEST rail',
    state: 'waiting_for_test_time',
    simulationAttemptCount: 0,
    maxSimulationAttempts: 3,
    reconciliationAttemptCount: 0,
    maxReconciliationAttempts: 3,
    updatedAt: '2026-08-27T12:00:00.000Z',
    environment: 'test',
    providerEffects: 'none',
    ...overrides,
  });
}

function planningProjection(
  index = 1,
  overrides: Partial<SocialPlanningCalendarProjection> = {},
): SocialPlanningCalendarProjection {
  const item = firstCatalogItem();
  return Object.freeze({
    intentId: uuid(700 + index),
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    revisionNumber: 4,
    campaignTitle: 'Opportunity Autopsy TEST campaign',
    desiredFor: `2026-08-28T${String(8 + index).padStart(2, '0')}:00:00.000Z`,
    contentItemId: item.contentItemId,
    contentVersionId: item.contentVersionId,
    contentSha256: item.contentSha256,
    intentSha256: 'e'.repeat(64),
    targetId: uuid(800 + index),
    network: 'facebook',
    targetLabel: 'Facebook TEST rail',
    planningState: 'awaiting_revalidation',
    materializedPostId: null,
    materializedOperationId: null,
    operationState: null,
    revalidationState: 'waiting_for_window',
    nextRevalidationAt: '2026-08-28T08:30:00.000Z',
    lastErrorCode: null,
    updatedAt: '2026-08-27T12:00:00.000Z',
    environment: 'test',
    providerEffects: 'none',
    ...overrides,
  });
}

function present(projections: readonly SocialCampaignCalendarProjection[]) {
  const fixture = createPropertyPredatorContentCalendarFixture();
  return presentContentCalendar(adaptPublicSocialCalendar(projections, fixture.catalog, false), {
    workspaceName: 'Property Predator Growth HQ',
    timezone: 'Europe/London',
    asOf: PROPERTY_PREDATOR_CONTENT_CALENDAR_AS_OF,
  });
}

test('public-social calendar adapter preserves every safe identity, exact hash and all nine networks', () => {
  const fixture = createPropertyPredatorContentCalendarFixture();
  const item = firstCatalogItem();
  const projections = NETWORKS.map((network, index) => projection(index + 1, {
    network,
    operationId: uuid(300 + index),
    targetId: uuid(400 + index),
    targetLabel: `${network} TEST rail`,
  }));
  const snapshot = adaptPublicSocialCalendar(projections, fixture.catalog, false);

  assert.equal(snapshot.catalog, fixture.catalog);
  assert.equal(snapshot.slots.length, 9);
  assert.deepEqual(snapshot.slots.map((slot) => slot.channel), NETWORKS);
  for (const [index, slot] of snapshot.slots.entries()) {
    const source = projections[index];
    assert.ok(source);
    assert.equal(slot.slotId, source.operationId);
    assert.equal(slot.contentItemId, item.contentItemId);
    assert.equal(slot.contentVersionId, item.contentVersionId);
    assert.equal(slot.contentSha256, item.contentSha256);
    assert.equal(slot.executionMode, 'simulated');
    assert.equal(slot.publicSocial?.campaignId, IDS.campaign);
    assert.equal(slot.publicSocial?.revisionId, IDS.revision);
    assert.equal(slot.publicSocial?.postId, IDS.post);
    assert.equal(slot.publicSocial?.operationId, source.operationId);
    assert.equal(slot.publicSocial?.targetId, source.targetId);
    assert.equal(slot.publicSocial?.network, source.network);
    assert.equal(slot.publicSocial?.planSha256, source.planSha256);
    assert.equal(slot.publicSocial?.environment, 'test');
    assert.equal(slot.publicSocial?.providerEffects, 'none');
    assert.equal(Object.isFrozen(slot), true);
    assert.equal(Object.isFrozen(slot.publicSocial), true);
  }
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.slots), true);
  assert.doesNotMatch(JSON.stringify(snapshot), /"(?:body|testAccountRef|storageKey|connectionId|credential|secret|token)"/i);
});

test('adapter carries database-proven continuation into a qualified calendar view', () => {
  const fixture = createPropertyPredatorContentCalendarFixture();
  const snapshot = adaptPublicSocialCalendar([projection()], fixture.catalog, true);
  const view = presentContentCalendar(snapshot, {
    workspaceName: 'Property Predator Growth HQ',
    timezone: 'Europe/London',
    asOf: PROPERTY_PREDATOR_CONTENT_CALENDAR_AS_OF,
    filters: { mode: 'week', date: '2026-08-28' },
  });
  assert.equal(snapshot.sourceTruncated, true);
  assert.equal(view.sourceTruncated, true);
  assert.equal(view.inputTruncated, true);
  const html = renderContentCalendarBody(view);
  assert.match(html, /data-source-truncated="true"/);
  assert.match(html, /database proved that additional complete public-social post aggregates exist/i);
  assert.match(html, /Loaded draft placements/);
});

test('durable TEST state is separate, visible and fails attention operations closed', () => {
  const succeeded = projection(1, {
    operationId: uuid(501), targetId: uuid(601), network: 'threads',
    targetLabel: 'Threads TEST rail', state: 'simulated_succeeded', simulationAttemptCount: 1,
  });
  const failed = projection(2, {
    operationId: uuid(502), targetId: uuid(602), network: 'pinterest',
    targetLabel: 'Pinterest TEST rail', state: 'reconciliation_required',
    simulationAttemptCount: 1, reconciliationAttemptCount: 1,
  });
  const view = present([succeeded, failed]);
  const slots = view.days.flatMap((day) => day.slots);
  const succeededView = slots.find((slot) => slot.slotId === succeeded.operationId);
  const failedView = slots.find((slot) => slot.slotId === failed.operationId);
  assert.ok(succeededView?.publicSocial);
  assert.equal(succeededView.publicSocial.stateLabel, 'Simulation complete');
  assert.equal(succeededView.publicSocial.stateTone, 'complete');
  assert.equal(succeededView.publicSocial.attention, false);
  assert.equal(succeededView.simulationEligible, true);
  assert.ok(failedView?.publicSocial);
  assert.equal(failedView.publicSocial.stateLabel, 'Reconciliation required');
  assert.equal(failedView.publicSocial.stateTone, 'attention');
  assert.equal(failedView.publicSocial.attention, true);
  assert.equal(failedView.simulationEligible, false);
  assert.equal(failedView.gateLabel, 'Locked');
  assert.match(failedView.gateDetail, /requires safe reconciliation/);

  const html = renderContentCalendarBody(view);
  assert.match(html, /Durable public-social TEST provenance/);
  assert.match(html, /Simulation complete/);
  assert.match(html, /Reconciliation required/);
  assert.match(html, /class="ccal-slot locked attention"/);
  assert.match(html, /Opportunity Autopsy TEST campaign · r4/);
  assert.match(html, /Environment test · provider effects none · identity proof exact/);
  assert.match(html, />TikTok<|>X<|>YouTube<|>Google Business Profile<|>Threads<|>Pinterest</);
  assert.doesNotMatch(html, /test-account:|storageKey|connectionId|body text/i);
});

test('adapter rejects duplicate operation ids and conflicting operations for one post target', () => {
  const fixture = createPropertyPredatorContentCalendarFixture();
  const first = projection(1);
  assert.throws(
    () => adaptPublicSocialCalendar([first, first], fixture.catalog, false),
    (error: unknown) => error instanceof PublicSocialCalendarAdapterError
      && /duplicate operation/.test(error.message),
  );
  assert.throws(
    () => adaptPublicSocialCalendar([
      first,
      projection(2, {
        operationId: uuid(999), targetId: first.targetId,
        scheduledFor: '2026-08-28T11:00:00.000Z',
      }),
    ], fixture.catalog, false),
    (error: unknown) => error instanceof PublicSocialCalendarAdapterError
      && /conflicting operations/.test(error.message),
  );
});

test('adapter rejects unsafe projection extensions and contradictory TEST boundaries', () => {
  const fixture = createPropertyPredatorContentCalendarFixture();
  const unsafe = {
    ...projection(),
    body: 'must never cross the adapter',
    testAccountRef: 'test-account:facebook:private',
    storageKey: 'private/blob/path',
  } as unknown as SocialCampaignCalendarProjection;
  assert.throws(
    () => adaptPublicSocialCalendar([unsafe], fixture.catalog, false),
    /unsupported field (?:body|testAccountRef|storageKey)/,
  );
  assert.throws(
    () => adaptPublicSocialCalendar([projection(1, {
      providerEffects: 'live' as never,
    })], fixture.catalog, false),
    /zero-effect TEST projection/,
  );
  assert.throws(
    () => adaptPublicSocialCalendar([projection(1, {
      network: 'mastodon' as SocialNetwork,
    })], fixture.catalog, false),
    /supported public-social taxonomy/,
  );
  assert.throws(
    () => adaptPublicSocialCalendar([projection(1, {
      campaignTitle: 'Trusted campaign\u202egnp.exe',
    })], fixture.catalog, false),
    /campaignTitle is invalid/,
  );
  assert.throws(
    () => adaptPublicSocialCalendar([projection(1, {
      targetLabel: 'Facebook rail\u2066spoof',
    })], fixture.catalog, false),
    /targetLabel is invalid/,
  );
});

test('catalogue mismatch keeps the projection hash exact and lets the presenter fail closed', () => {
  const fixture = createPropertyPredatorContentCalendarFixture();
  const mismatched = projection(1, { contentSha256: 'f'.repeat(64) });
  const snapshot = adaptPublicSocialCalendar([mismatched], fixture.catalog, false);
  assert.equal(snapshot.slots[0]?.contentSha256, 'f'.repeat(64));
  const view = presentContentCalendar(snapshot, {
    workspaceName: 'Property Predator Growth HQ',
    timezone: 'Europe/London',
    asOf: PROPERTY_PREDATOR_CONTENT_CALENDAR_AS_OF,
  });
  const slot = view.days.flatMap((day) => day.slots)[0];
  assert.equal(slot?.immutableVersionMatches, false);
  assert.equal(slot?.gateLabel, 'Locked');
  assert.match(slot?.gateDetail ?? '', /does not match the latest immutable version/);
});

test('0040 desired-time intents become durable cards before materialisation', () => {
  const fixture = createPropertyPredatorContentCalendarFixture();
  const planned = planningProjection();
  const snapshot = adaptPublicSocialCalendar([], fixture.catalog, false, [planned], false);
  assert.equal(snapshot.slots.length, 1);
  const slot = snapshot.slots[0];
  assert.ok(slot);
  assert.equal(slot.slotId, `${planned.intentId}:${planned.targetId}`);
  assert.equal(slot.scheduledFor, planned.desiredFor);
  assert.equal(slot.publicSocial, undefined);
  assert.deepEqual(slot.planning, {
    intentId: planned.intentId,
    intentSha256: planned.intentSha256,
    targetId: planned.targetId,
    desiredFor: planned.desiredFor,
    planningState: 'awaiting_revalidation',
    revalidationState: 'waiting_for_window',
    nextRevalidationAt: planned.nextRevalidationAt,
    updatedAt: planned.updatedAt,
    environment: 'test',
    providerEffects: 'none',
  });
  const view = presentContentCalendar(snapshot, {
    workspaceName: 'Property Predator Growth HQ',
    timezone: 'Europe/London',
    asOf: PROPERTY_PREDATOR_CONTENT_CALENDAR_AS_OF,
    filters: { mode: 'week', date: '2026-08-28' },
  });
  const rendered = view.days.flatMap((day) => day.slots)[0];
  assert.equal(rendered?.planning?.identityProofValid, true);
  assert.equal(rendered?.planning?.statusLabel, 'JIT proof waiting');
  assert.equal(rendered?.planning?.statusTone, 'due');
  assert.doesNotMatch(JSON.stringify(snapshot), /body|connectionId|testAccountRef|storageKey/i);
});

test('materialised planning proof enriches one operation card without duplicating it', () => {
  const fixture = createPropertyPredatorContentCalendarFixture();
  const operation = projection(1);
  const planned = planningProjection(1, {
    targetId: operation.targetId,
    desiredFor: operation.scheduledFor,
    planningState: 'materialized',
    materializedPostId: operation.postId,
    materializedOperationId: operation.operationId,
    operationState: operation.state,
    revalidationState: 'materialized',
    nextRevalidationAt: null,
  });
  const snapshot = adaptPublicSocialCalendar(
    [operation], fixture.catalog, false, [planned], false,
  );
  assert.equal(snapshot.slots.length, 1);
  assert.equal(snapshot.slots[0]?.slotId, operation.operationId);
  assert.equal(snapshot.slots[0]?.publicSocial?.operationId, operation.operationId);
  assert.equal(snapshot.slots[0]?.planning?.intentId, planned.intentId);
  assert.equal(snapshot.slots[0]?.planning?.planningState, 'materialized');
});

test('planning adapter rejects unsafe fields, duplicate targets and contradictory materialisation', () => {
  const fixture = createPropertyPredatorContentCalendarFixture();
  const planned = planningProjection();
  assert.throws(
    () => adaptPublicSocialCalendar([], fixture.catalog, false, [{
      ...planned, body: 'browser must never receive this',
    } as unknown as SocialPlanningCalendarProjection]),
    /unsupported field body/,
  );
  assert.throws(
    () => adaptPublicSocialCalendar([], fixture.catalog, false, [planned, planned]),
    /duplicate planning target/,
  );
  const operation = projection(1);
  assert.throws(
    () => adaptPublicSocialCalendar([operation], fixture.catalog, false, [planningProjection(1, {
      targetId: operation.targetId,
      desiredFor: operation.scheduledFor,
      materializedPostId: operation.postId,
      materializedOperationId: operation.operationId,
      operationState: operation.state,
      revalidationState: 'materialized',
      contentSha256: 'f'.repeat(64),
    })]),
    /materialized planning proof contradicts operation/,
  );
});
