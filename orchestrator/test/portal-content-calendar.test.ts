import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CompanyContentCatalogItem,
  CompanyContentCatalogPage,
} from '../src/company-content-pg/types.js';
import {
  createPropertyPredatorContentCalendarFixture,
  PROPERTY_PREDATOR_CONTENT_CALENDAR_AS_OF,
} from '../src/portal/content-calendar-fixtures.js';
import {
  CONTENT_CALENDAR_CLIENT_ROUTE,
  CONTENT_CALENDAR_CLIENT_SCRIPT,
  CONTENT_CALENDAR_CLIENT_SOURCE,
} from '../src/portal/content-calendar-client.js';
import {
  CONTENT_CALENDAR_MAX_CATALOG_ITEMS,
  CONTENT_CALENDAR_MAX_SLOTS,
  normaliseContentCalendarFilters,
  presentContentCalendar,
  type ContentCalendarSlotSnapshot,
  type ContentCalendarSnapshot,
} from '../src/portal/content-calendar-presenter.js';
import { renderContentCalendarBody } from '../src/portal/content-calendar-view.js';

const OPTIONS = Object.freeze({
  workspaceName: 'Property Predator Growth HQ',
  timezone: 'Europe/London',
  asOf: PROPERTY_PREDATOR_CONTENT_CALENDAR_AS_OF,
});

function present(
  snapshot: Omit<ContentCalendarSnapshot, 'sourceTruncated'>
    & Partial<Pick<ContentCalendarSnapshot, 'sourceTruncated'>>
    = createPropertyPredatorContentCalendarFixture(),
  filters: Readonly<{ mode?: unknown; view?: unknown; date?: unknown; channel?: unknown }> = {},
) {
  return presentContentCalendar({ ...snapshot, sourceTruncated: snapshot.sourceTruncated ?? false }, {
    ...OPTIONS,
    filters,
  });
}

function firstCatalogItem(): CompanyContentCatalogItem {
  const item = createPropertyPredatorContentCalendarFixture().catalog.items[0];
  if (!item) throw new Error('Fixture item missing');
  return item;
}

function page(items: readonly CompanyContentCatalogItem[]): CompanyContentCatalogPage {
  return Object.freeze({ items: Object.freeze(items), nextCursor: null });
}

function slot(item: CompanyContentCatalogItem, overrides: Partial<ContentCalendarSlotSnapshot> = {}): ContentCalendarSlotSnapshot {
  return Object.freeze({
    slotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    contentItemId: item.contentItemId,
    contentVersionId: item.contentVersionId,
    contentSha256: item.contentSha256,
    scheduledFor: '2026-08-26T09:00:00.000Z',
    channel: 'linkedin',
    variantLabel: 'Founder text placement',
    objectiveLabel: 'Test objective',
    ownerLabel: 'Test owner',
    plannerState: 'draft',
    executionMode: 'simulated',
    ...overrides,
  });
}

test('Content Calendar presents a seven-day campaign rhythm with channel variants around one immutable version', () => {
  const view = present();
  assert.equal(view.filters.mode, 'week');
  assert.equal(view.days.length, 7);
  assert.equal(view.days[0]?.date, '2026-08-24');
  assert.equal(view.days[6]?.date, '2026-08-30');
  assert.equal(view.periodLabel, '24 Aug – 30 Aug 2026');
  assert.deepEqual(view.metrics, {
    plannedSlots: 6,
    simulationReady: 3,
    blocked: 3,
    activeChannels: 5,
  });

  const slots = view.days.flatMap((day) => day.slots);
  const approvedVariants = slots.filter((entry) => entry.contentVersionId === slots[0]?.contentVersionId);
  assert.equal(approvedVariants.length, 3);
  assert.deepEqual(approvedVariants.map((entry) => entry.channel), [
    'linkedin', 'instagram', 'facebook',
  ]);
  assert.ok(approvedVariants.every((entry) => entry.versionNumber === 3));
  assert.ok(approvedVariants.every((entry) => entry.exactApproval));
  assert.ok(approvedVariants.every((entry) => entry.sourceFresh));
  assert.ok(approvedVariants.every((entry) => entry.simulationEligible));
});

test('Content Calendar month mode uses a complete Monday-to-Sunday grid and preserves channel filters', () => {
  const month = present(undefined, { mode: 'month', date: '2026-08-12' });
  assert.equal(month.days.length, 42);
  assert.equal(month.days[0]?.date, '2026-07-27');
  assert.equal(month.days[41]?.date, '2026-09-06');
  assert.equal(month.periodLabel, 'August 2026');
  assert.equal(month.previousDate, '2026-07-01');
  assert.equal(month.nextDate, '2026-09-01');
  assert.equal(month.days.filter((day) => day.inPrimaryPeriod).length, 31);

  const instagram = present(undefined, {
    mode: 'month', date: '2026-08-12', channel: 'instagram',
  });
  assert.equal(instagram.visibleSlotCount, 2);
  assert.deepEqual(instagram.metrics, {
    plannedSlots: 2,
    simulationReady: 1,
    blocked: 1,
    activeChannels: 1,
  });
  assert.ok(instagram.days.flatMap((day) => day.slots).every((entry) => entry.channel === 'instagram'));
});

test('Content Calendar groups and labels instants in the declared planning timezone across DST', () => {
  const item = firstCatalogItem();
  const view = presentContentCalendar({
    catalog: page([item]),
    slots: [slot(item, { scheduledFor: '2026-03-29T23:30:00.000Z' })],
    sourceTruncated: false,
  }, {
    ...OPTIONS,
    asOf: '2026-03-30T08:00:00.000Z',
    filters: { mode: 'week', date: '2026-03-30' },
  });
  const localDay = view.days.find((day) => day.date === '2026-03-30');
  assert.equal(view.timezone, 'Europe/London');
  assert.equal(localDay?.slots.length, 1);
  assert.equal(localDay?.slots[0]?.timeLabel, '00:30');
  assert.equal(view.days.find((day) => day.date === '2026-03-29')?.slots.length, undefined);
});

test('Content Calendar independently fails contradictory approval, freshness and immutable-version claims closed', () => {
  const approved = firstCatalogItem();
  const pending: CompanyContentCatalogItem = {
    ...approved,
    approvalDecisionId: null,
    approvalStatus: 'pending',
    publishable: true,
  };
  const expired: CompanyContentCatalogItem = {
    ...approved,
    contentItemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    contentVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    sourceExpiresAt: '2026-08-26T08:40:00.000Z',
    sourceFresh: true,
    publishable: true,
  };
  const snapshot: ContentCalendarSnapshot = {
    catalog: page([pending, expired]),
    sourceTruncated: false,
    slots: [
      slot(pending),
      slot(expired, {
        slotId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        contentItemId: expired.contentItemId,
        contentVersionId: expired.contentVersionId,
        contentSha256: expired.contentSha256,
      }),
      slot(pending, {
        slotId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        contentSha256: 'f'.repeat(64),
      }),
    ],
  };
  const view = present(snapshot);
  const slots = view.days.flatMap((day) => day.slots);
  assert.equal(view.metrics.simulationReady, 0);
  assert.equal(view.metrics.blocked, 3);
  assert.match(slots[0]?.gateDetail ?? '', /needs an exact current approval/);
  assert.match(slots[1]?.gateDetail ?? '', /source proof is missing, expired or not yet valid/);
  assert.match(slots[2]?.gateDetail ?? '', /does not match the latest immutable version/);
  assert.equal(view.hasUnknownVersion, true);
  assert.ok(slots.every((entry) => entry.gateLabel === 'Locked'));
});

test('Content Calendar rejects unknown versions and never substitutes another catalogue item', () => {
  const approved = firstCatalogItem();
  const unknown = slot(approved, {
    contentVersionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  });
  const view = present({ catalog: page([approved]), slots: [unknown] });
  const entry = view.days.flatMap((day) => day.slots)[0];
  assert.equal(entry?.title, 'Version unavailable');
  assert.equal(entry?.versionNumber, null);
  assert.equal(entry?.simulationEligible, false);
  assert.match(entry?.gateDetail ?? '', /not in the loaded company catalogue/);
  assert.equal(view.hasUnknownVersion, true);
});

test('Content Calendar renders a premium accessible planner while every content control stays TEST-only and disabled', () => {
  const html = renderContentCalendarBody(present());
  assert.match(html, /<nav class="pp-content-nav" aria-label="Content operations">/);
  assert.doesNotMatch(html, /href="\/portal\/content\/compose"/);
  assert.match(html, /href="\/portal\/content\/calendar" aria-current="page">Calendar/);
  assert.match(html, /<article class="ccal" aria-labelledby="ccal-title" data-provider-effects="none" data-content-calendar data-calendar-mode="week" data-calendar-timezone="Europe\/London" data-source-truncated="false" data-preview-dirty="false">/);
  assert.match(html, /Own the week\. <em>Control the signal\.<\/em>/);
  assert.match(html, /TEST planner · zero delivery/);
  assert.match(html, /A slot is not a scheduled provider job/);
  assert.match(html, /aria-label="Calendar view"/);
  assert.match(html, /aria-label="Filter planner by channel"/);
  assert.match(html, /aria-label="Scrollable week content calendar"/);
  assert.match(html, /<details><summary>Planning proof<\/summary>/);
  assert.match(html, /\+ New TEST draft slot · disabled/);
  assert.match(html, /Create TEST draft slot · simulator only/);
  assert.match(html, /data-calendar-move-handle/);
  assert.match(html, /Choose date &amp; time/);
  assert.match(html, /Move TEST plan/);
  assert.match(html, /Browser-only movement/);
  assert.match(html, /Nothing is saved; reloading restores this exact snapshot/);
  assert.match(html, /data-calendar-live role="status" aria-live="polite"/);
  assert.match(html, /disabled aria-disabled="true"/);
  assert.match(html, /No provider calls/);
  assert.match(html, /min-height:44px/);
  assert.match(html, /href="\/portal\/campaigns\?campaign=a1000000-0000-4000-8000-000000000001&amp;calendar_mode=week&amp;calendar_date=2026-08-26&amp;calendar_channel=all"/);
  assert.match(html, /aria-label="Open exact campaign Property Predator Signal Sprint for LinkedIn TEST rail"/);
  assert.equal((html.match(/>Open exact campaign →<\/a>/g) ?? []).length, 1);
  assert.match(html, /@media\(max-width:800px\)/);
  assert.match(html, /@media\(max-width:520px\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.match(html, new RegExp(`<script src="${CONTENT_CALENDAR_CLIENT_ROUTE.replaceAll('/', '\\/')}" defer><\\/script>$`));
  assert.equal((html.match(/<script\b/g) ?? []).length, 1);
  assert.doesNotMatch(html, /method="post"|Publish now|Schedule now|Connect provider/i);
  assert.equal((html.match(/executionMode|providerToken|accessToken|apiKey/g) ?? []).length, 0);
});

test('Content Calendar escapes hostile catalogue and planning labels', () => {
  const approved = firstCatalogItem();
  const hostile: CompanyContentCatalogItem = {
    ...approved,
    title: '<img src=x onerror=alert(1)> A&B',
    contentVersionId: 'version"><script>alert(2)</script>',
  };
  const hostileSlot = slot(hostile, {
    contentVersionId: hostile.contentVersionId,
    variantLabel: '"><script>alert(3)</script>',
    objectiveLabel: '<img src=x onerror=alert(4)>',
    ownerLabel: '<Owner & Co>',
  });
  const view = presentContentCalendar({
    catalog: page([hostile]), slots: [hostileSlot], sourceTruncated: false,
  }, {
    ...OPTIONS,
    workspaceName: '<script>alert(5)</script>',
  });
  const html = renderContentCalendarBody(view);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; A&amp;B/);
  assert.match(html, /&quot;&gt;&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.match(html, /&lt;Owner &amp; Co&gt;/);
  assert.match(html, /&lt;script&gt;alert\(5\)&lt;\/script&gt;/);
  assert.doesNotMatch(html.replace(/<script src="\/portal\/assets\/content-calendar\.js" defer><\/script>/, ''), /<(?:script|img)\b/i);
});

test('Content Calendar locks visually spoofed public-social labels instead of rendering them as trusted proof', () => {
  const snapshot = createPropertyPredatorContentCalendarFixture();
  const first = snapshot.slots[0];
  assert.ok(first?.publicSocial);
  const hostile: ContentCalendarSnapshot = {
    catalog: snapshot.catalog,
    sourceTruncated: false,
    slots: [{
      ...first,
      publicSocial: {
        ...first.publicSocial,
        campaignTitle: 'Trusted campaign\u202egnp.exe',
      },
    }],
  };
  const entry = present(hostile).days.flatMap((day) => day.slots)[0];
  assert.equal(entry?.publicSocial?.identityProofValid, false);
  assert.equal(entry?.publicSocial?.stateLabel, 'Provenance locked');
  assert.equal(entry?.gateLabel, 'Locked');
});

test('Content Calendar canonicalises legacy view filters and emits stable mode round-trip links', () => {
  assert.deepEqual(normaliseContentCalendarFilters({
    view: 'month', date: '2026-08-12', channel: 'facebook',
  }, PROPERTY_PREDATOR_CONTENT_CALENDAR_AS_OF), {
    mode: 'month', date: '2026-08-12', channel: 'facebook',
  });
  const html = renderContentCalendarBody(present(undefined, {
    mode: 'month', date: '2026-08-12', channel: 'instagram',
  }));
  assert.match(html, /\/portal\/content\/calendar\?mode=week&amp;date=2026-08-12&amp;channel=instagram/);
  assert.match(html, /\/portal\/content\/calendar\?mode=month&amp;date=2026-07-01&amp;channel=instagram/);
  assert.doesNotMatch(html, /\/portal\/content\/calendar\?view=/);
});

test('Content Calendar client is dependency-free DOM-only movement and composer preview enhancement', () => {
  assert.equal(CONTENT_CALENDAR_CLIENT_SOURCE, CONTENT_CALENDAR_CLIENT_SCRIPT);
  assert.doesNotThrow(() => new Function(CONTENT_CALENDAR_CLIENT_SCRIPT));
  assert.match(CONTENT_CALENDAR_CLIENT_SCRIPT, /addEventListener\('pointerdown'/);
  assert.match(CONTENT_CALENDAR_CLIENT_SCRIPT, /event\.key === 'ArrowRight'/);
  assert.match(CONTENT_CALENDAR_CLIENT_SCRIPT, /event\.key === 'ArrowUp'/);
  assert.match(CONTENT_CALENDAR_CLIENT_SCRIPT, /data-calendar-move-sheet/);
  assert.match(CONTENT_CALENDAR_CLIENT_SCRIPT, /if \(lifted\) finishLift\(\)/);
  assert.match(CONTENT_CALENDAR_CLIENT_SCRIPT, /!element\.hasAttribute\('data-calendar-live'\)/);
  assert.match(CONTENT_CALENDAR_CLIENT_SCRIPT, /browser preview only/);
  assert.match(CONTENT_CALENDAR_CLIENT_SCRIPT, /data-composer-preview/);
  assert.match(CONTENT_CALENDAR_CLIENT_SCRIPT, /reload discards these changes/);
  assert.match(CONTENT_CALENDAR_CLIENT_SCRIPT, /const wallTime = date \+ 'T' \+ label/);
  assert.match(CONTENT_CALENDAR_CLIENT_SCRIPT, /workspace wall time/);
  assert.doesNotMatch(CONTENT_CALENDAR_CLIENT_SCRIPT, /getUTCHours|getUTCMinutes|:00\.000Z/);
  assert.doesNotMatch(CONTENT_CALENDAR_CLIENT_SCRIPT, /\bfetch\s*\(|requestSubmit|XMLHttpRequest|sendBeacon|WebSocket/);
});

test('Content Calendar bounds untrusted inputs and invalid navigation fails to deterministic defaults', () => {
  const filters = normaliseContentCalendarFilters({
    mode: 'agenda<script>', date: '2026-02-31', channel: 'tiktok<script>',
  }, PROPERTY_PREDATOR_CONTENT_CALENDAR_AS_OF);
  assert.deepEqual(filters, { mode: 'week', date: '2026-08-26', channel: 'all' });

  const approved = firstCatalogItem();
  const catalog = Array.from({ length: CONTENT_CALENDAR_MAX_CATALOG_ITEMS + 30 }, (_, index) => ({
    ...approved,
    contentItemId: `item-${index}`,
    contentVersionId: `version-${index}`,
  }));
  const slots = Array.from({ length: CONTENT_CALENDAR_MAX_SLOTS + 30 }, (_, index) => slot(catalog[index % catalog.length]!, {
    slotId: `slot-${index}`,
    scheduledFor: `2026-08-26T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
  }));
  const view = present({ catalog: page(catalog), slots });
  assert.equal(view.catalogCount, CONTENT_CALENDAR_MAX_CATALOG_ITEMS);
  assert.equal(view.visibleSlotCount, CONTENT_CALENDAR_MAX_SLOTS);
  assert.equal(view.inputTruncated, true);
  assert.match(renderContentCalendarBody(view), /Bounded safety limits were applied/);

  const paged = present({
    catalog: Object.freeze({
      items: Object.freeze([approved]),
      nextCursor: Object.freeze({
        beforeCreatedAt: approved.createdAt,
        beforeVersionId: approved.contentVersionId,
      }),
    }),
    slots: [],
  });
  assert.equal(paged.inputTruncated, true);
});
