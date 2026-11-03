import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalCompanyContentJson } from '../src/company-content-pg/validation.js';
import test from 'node:test';
import { appendCampaignRevision, CAMPAIGN_ANGLES, campaignDateProposal, campaignParentHold, campaignRevisionSha, campaignSource, createCampaignRevision, currentCampaignRevision, SEO_CAMPAIGN_SCHEMA, type ArticleCampaign, type CampaignMedia, type CampaignVariant } from '../src/seo-blog/campaign.js';
import type { CampaignRevision } from '../src/seo-blog/campaign.js';

const VERSION = randomUUID(), BRAND = randomUUID(), ARTICLE = randomUUID(), OWNER = randomUUID();
const CONTENT = 'a'.repeat(64), AT = '2026-11-03T12:00:00.000Z';
function media(): CampaignMedia {
  return { useId: randomUUID(), assetId: randomUUID(), assetSha256: 'b'.repeat(64), profile: 'instagram', alt: 'Illustration of a considered property decision',
    canonical: { contentItemId: randomUUID(), contentVersionId: randomUUID(), contentSha256: 'c'.repeat(64), approvalRequestId: randomUUID(), approvalDecisionId: randomUUID() } };
}
function variant(angle: typeof CAMPAIGN_ANGLES[number] = 'launch'): CampaignVariant {
  const id = randomUUID();
  const revision = createCampaignRevision({ variantId: id, articleVersionId: VERSION, articleContentSha: CONTENT, canonicalUrl: 'https://harbour.example/blog/decisions', network: 'instagram', angle,
    title: 'A considered decision', copy: `A different ${angle} perspective grounded in the article.`, artworkInstructions: 'Editorial illustration with calm tones and no fabricated evidence.', media: media(), createdAt: AT, createdBy: 'system' });
  return { id, network: 'instagram', angle, currentRevisionId: revision.id, revisions: [revision], omitted: false, pinnedSchedule: null, approval: { revisionId: revision.id, revisionSha256: revision.sha256, contentItemId: randomUUID(), contentVersionId: randomUUID(), contentSha256: 'd'.repeat(64), approvalRequestId: randomUUID(), approvalDecisionId: randomUUID() } };
}
function campaign(): ArticleCampaign { return { schema: SEO_CAMPAIGN_SCHEMA, articleVersionId: VERSION, articleContentSha: CONTENT, variants: CAMPAIGN_ANGLES.map(a => variant(a)) }; }

test('campaign Unicode/quote/newline canonical digest matches the fixed SQL interoperability fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/seo-campaign-revision-v1.json', import.meta.url), 'utf8')) as { revision: Omit<CampaignRevision, 'sha256'>; canonical: string; sha256: string };
  assert.equal(canonicalCompanyContentJson(fixture.revision), fixture.canonical);
  assert.equal(campaignRevisionSha(fixture.revision), fixture.sha256);
});

test('three angles on one channel have distinct stable source items and exact immutable source revisions', () => {
  const c = campaign();
  const sources = c.variants.map(v => campaignSource(BRAND, ARTICLE, currentCampaignRevision(v)));
  assert.equal(new Set(sources.map(s => s.itemId)).size, 3);
  assert.equal(new Set(sources.map(s => s.version)).size, 3);
  assert.ok(sources.every(s => s.system === 'relaunch72.seo-blog' && s.version.startsWith(`campaign:v1:${VERSION}:`)));
  assert.deepEqual(sources, c.variants.map(v => campaignSource(BRAND, ARTICLE, currentCampaignRevision(v))));
});

test('social-only edit appends one revision, clears only its approval and preserves other angles and owner pin', () => {
  const original = campaign(); const first = original.variants[0]!;
  const pin = { scheduledFor: '2026-11-05T14:00:00.000Z', localDate: '2026-11-05', localTime: '14:00', timezone: 'Europe/London', setBy: OWNER, setAt: AT };
  const c = { ...original, variants: original.variants.map(v => v.id === first.id ? { ...v, pinnedSchedule: pin } : v) };
  const previous = currentCampaignRevision(first); const { id: _id, sha256: _sha, recipe: _recipe, relativeDays: _days, ...input } = previous;
  const changed = createCampaignRevision({ ...input, copy: 'An owner-edited practical consideration from the exact source article.', media: { ...previous.media!, useId: randomUUID() }, createdBy: OWNER });
  const next = appendCampaignRevision(c, first.id, first.currentRevisionId, changed);
  assert.equal(next.articleVersionId, c.articleVersionId, 'blog body/version is unchanged');
  assert.equal(next.variants[0]!.revisions.length, 2); assert.equal(next.variants[0]!.revisions[0], previous);
  assert.equal(next.variants[0]!.approval, null); assert.equal(next.variants[0]!.pinnedSchedule, pin);
  assert.equal(next.variants[1], c.variants[1]); assert.equal(next.variants[2], c.variants[2]);
  assert.throws(() => appendCampaignRevision(next, first.id, first.currentRevisionId, changed), /changed/);
  const reusedUse = createCampaignRevision({ ...input, copy: 'Another exact edit that must require a fresh use authorization.' });
  assert.throws(() => appendCampaignRevision(c, first.id, first.currentRevisionId, reusedUse), /new image use/);
});

test('campaign digest binds text, crop, alt, recipe and audit, but does not depend on pins or Article rowVersion', () => {
  const v = variant(); const revision = currentCampaignRevision(v);
  const { sha256, ...value } = revision;
  assert.equal(campaignRevisionSha(value), sha256);
  assert.notEqual(campaignRevisionSha({ ...value, copy: `${value.copy} A new point.` }), sha256);
  assert.notEqual(campaignRevisionSha({ ...value, media: { ...value.media!, alt: 'A changed exact description' } }), sha256);
  assert.notEqual(campaignRevisionSha({ ...value, media: { ...value.media!, assetSha256: 'f'.repeat(64) } }), sha256);
  assert.throws(() => currentCampaignRevision({ ...v, revisions: [{ ...revision, copy: 'Mutated reviewed bytes without a new immutable identity.' }] }), /saved review/);
  assert.ok(Object.isFrozen(revision)); assert.ok(Object.isFrozen(revision.media)); assert.ok(Object.isFrozen(revision.media!.canonical));
});

test('late blog dates hold rather than burst; owner pins are never silently shifted', () => {
  const v = variant();
  assert.deepEqual(campaignDateProposal(v, AT, AT), { state: 'proposed', at: '2026-11-03T13:00:00.000Z', pinned: false });
  const past = campaignDateProposal(v, AT, '2026-11-04T13:00:00.000Z');
  assert.equal(past.state, 'held'); if (past.state === 'held') assert.equal(past.suggestedAt, null);
  const pinned = { ...v, pinnedSchedule: { scheduledFor: AT, localDate: '2026-11-03', localTime: '12:00', timezone: 'Europe/London', setBy: OWNER, setAt: AT } };
  const held = campaignDateProposal(pinned, '2026-11-10T12:00:00.000Z', '2026-11-04T12:00:00.000Z');
  assert.equal(held.state, 'held'); if (held.state === 'held') assert.equal(held.suggestedAt, null);
  assert.equal(pinned.pinnedSchedule.scheduledFor, AT);
});

test('relative campaign dates use local calendar days then an elapsed hour, preserving anchor precision across DST', () => {
  const v = variant('takeaway');
  for (const [anchor, expected] of [
    ['2026-03-26T10:20:35.123Z', '2026-03-29T10:20:35.123Z'],
    ['2026-10-22T09:20:35.123Z', '2026-10-25T11:20:35.123Z'],
  ]) assert.deepEqual(campaignDateProposal(v, anchor!, '2026-01-01T00:00:00.000Z', 'Europe/London'), { state: 'proposed', at: expected, pinned: false });
  for (const anchor of ['2026-10-22T00:30:00.000Z', '2026-03-26T01:30:00.000Z']) {
    const held = campaignDateProposal(v, anchor, '2026-01-01T00:00:00.000Z', 'Europe/London');
    assert.equal(held.state, 'held'); if (held.state === 'held') assert.match(held.reason, /clocks change/);
  }
  assert.deepEqual(campaignDateProposal(variant('launch'), '2026-10-25T00:30:35.123Z', '2026-01-01T00:00:00.000Z', 'Europe/London'), { state: 'proposed', at: '2026-10-25T01:30:35.123Z', pinned: false });
});

test('old parent, omitted variant and absent image/live proof hold fresh delivery independently', () => {
  const c = campaign(), v = c.variants[0]!, version = { id: VERSION, contentSha: CONTENT };
  const article = { currentVersionId: VERSION, delivery: 'published' as const, publishedVersionId: VERSION, publishedUrl: 'https://harbour.example/blog/decisions' };
  assert.equal(campaignParentHold(article, version, c, v, true), null);
  assert.match(campaignParentHold({ ...article, currentVersionId: randomUUID() }, version, c, v, true)!, /blog changed/);
  assert.match(campaignParentHold(article, version, c, { ...v, omitted: true }, true)!, /omitted/);
  assert.match(campaignParentHold({ ...article, delivery: 'none', publishedUrl: null }, version, c, v, true)!, /verified live/);
  assert.equal(campaignParentHold({ ...article, delivery: 'none', publishedUrl: null }, version, c, v, false), null, 'unpublished exact drafts can still be reviewed');
});
