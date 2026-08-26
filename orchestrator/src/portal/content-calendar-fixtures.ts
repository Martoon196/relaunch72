import { createPropertyPredatorContentCatalogFixture } from './content-control-room-fixtures.js';
import type {
  ContentCalendarSlotSnapshot,
  ContentCalendarSnapshot,
} from './content-calendar-presenter.js';

export const PROPERTY_PREDATOR_CONTENT_CALENDAR_AS_OF = '2026-08-26T08:42:00.000Z';

function slot(input: Omit<ContentCalendarSlotSnapshot, 'executionMode'>): ContentCalendarSlotSnapshot {
  return Object.freeze({ ...input, executionMode: 'simulated' });
}

/**
 * Fictional planner facts around the existing company-content preview catalogue.
 * Every slot is a draft/simulated presentation and is structurally incapable of
 * containing provider credentials or invoking a delivery adapter.
 */
export function createPropertyPredatorContentCalendarFixture(): ContentCalendarSnapshot {
  const catalog = createPropertyPredatorContentCatalogFixture();
  const approved = catalog.items[0];
  const pending = catalog.items[1];
  const stale = catalog.items[2];
  const webinar = catalog.items[3];
  if (!approved || !pending || !stale || !webinar) {
    throw new Error('Property Predator company-content fixture is incomplete');
  }

  return Object.freeze({
    catalog,
    slots: Object.freeze([
      slot({
        slotId: '91000000-0000-4000-8000-000000000001',
        contentItemId: approved.contentItemId,
        contentVersionId: approved.contentVersionId,
        contentSha256: approved.contentSha256,
        scheduledFor: '2026-08-26T09:15:00.000Z',
        channel: 'linkedin',
        variantLabel: 'Founder insight · text-led placement',
        objectiveLabel: 'Turn evidence curiosity into briefing visits',
        ownerLabel: 'Growth HQ test desk',
        plannerState: 'simulated_preview',
      }),
      slot({
        slotId: '91000000-0000-4000-8000-000000000002',
        contentItemId: approved.contentItemId,
        contentVersionId: approved.contentVersionId,
        contentSha256: approved.contentSha256,
        scheduledFor: '2026-08-27T13:30:00.000Z',
        channel: 'instagram',
        variantLabel: 'Caption placement · owned evidence artwork',
        objectiveLabel: 'Build recognition around evidence-led sourcing',
        ownerLabel: 'Growth HQ test desk',
        plannerState: 'draft',
      }),
      slot({
        slotId: '91000000-0000-4000-8000-000000000003',
        contentItemId: approved.contentItemId,
        contentVersionId: approved.contentVersionId,
        contentSha256: approved.contentSha256,
        scheduledFor: '2026-08-28T10:00:00.000Z',
        channel: 'facebook',
        variantLabel: 'Feed placement · approved copy unchanged',
        objectiveLabel: 'Route developer audiences to the briefing',
        ownerLabel: 'Growth HQ test desk',
        plannerState: 'draft',
      }),
      slot({
        slotId: '91000000-0000-4000-8000-000000000004',
        contentItemId: pending.contentItemId,
        contentVersionId: pending.contentVersionId,
        contentSha256: pending.contentSha256,
        scheduledFor: '2026-08-27T08:00:00.000Z',
        channel: 'email',
        variantLabel: 'Agency nurture · segment preview',
        objectiveLabel: 'Continue the mixed-use briefing conversation',
        ownerLabel: 'Lifecycle test desk',
        plannerState: 'draft',
      }),
      slot({
        slotId: '91000000-0000-4000-8000-000000000005',
        contentItemId: stale.contentItemId,
        contentVersionId: stale.contentVersionId,
        contentSha256: stale.contentSha256,
        scheduledFor: '2026-08-29T11:45:00.000Z',
        channel: 'instagram',
        variantLabel: 'Artwork placement · exact v4 candidate',
        objectiveLabel: 'Explain the development-appraisal proof',
        ownerLabel: 'Creative test desk',
        plannerState: 'draft',
      }),
      slot({
        slotId: '91000000-0000-4000-8000-000000000006',
        contentItemId: webinar.contentItemId,
        contentVersionId: webinar.contentVersionId,
        contentSha256: webinar.contentSha256,
        scheduledFor: '2026-08-30T17:00:00.000Z',
        channel: 'webinar',
        variantLabel: 'Replay room · simulated registration window',
        objectiveLabel: 'Convert replay engagement into demo intent',
        ownerLabel: 'Events test desk',
        plannerState: 'draft',
      }),
    ]),
  });
}
