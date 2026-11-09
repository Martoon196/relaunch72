/** Creative Studio: brand resolution, honest drafting, deterministic artwork, versioning, approvals, isolation and routes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import jpeg from 'jpeg-js';
import { resolveCreativeContext, essentialGaps, NEUTRAL_PALETTE } from '../src/creative-studio/brand-context.js';
import { copyIssues, draftConcepts, factsCorpus, figures } from '../src/creative-studio/concepts.js';
import { verifyCreativeImage } from '../src/creative-studio/image-input.js';
import { PLACEMENTS } from '../src/creative-studio/placements.js';
import { artworkHtml, ChromiumArtworkRenderer, contrastRatio, findCreativeChromium, luminance, parseHex, type ArtworkInput, type ArtworkRenderer, type RenderedArtwork } from '../src/creative-studio/renderer.js';
import { CreativeStudioService, setView, type SavedImagePort } from '../src/creative-studio/service.js';
import { MemoryCreativeLibraryStore } from '../src/creative-studio/store.js';
import type { CreativeRequest } from '../src/creative-studio/types.js';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';
import { portalCsrfToken } from '../src/portal/session.js';
import { harness, OWNER, STRANGER } from './seo-blog-fixtures.js';
import { creativeBrand, HEARTH, QUEUE, syntheticLandscapeJpeg, syntheticLogoPng } from './creative-studio-fixtures.js';

const chromium = findCreativeChromium();
const SECRET = 's'.repeat(48);

/** Labelled stub renderer: real tiny JPEG bytes that depend on the exact copy. */
class StubRenderer implements ArtworkRenderer {
  readonly version = 'test-stub-renderer'; calls = 0; inputs: ArtworkInput[] = [];
  available() { return true; }
  async renderBatch(inputs: readonly ArtworkInput[]): Promise<RenderedArtwork[]> {
    return inputs.map((input) => {
      this.calls++; this.inputs.push(input);
      const seed = createHash('sha256').update(JSON.stringify({ ...input, logo: input.logo?.sha256, background: input.background?.sha256, placement: input.placement.id })).digest();
      const data = Buffer.alloc(8 * 8 * 4); for (let i = 0; i < 64; i++) { data.set([seed[i % 32]!, seed[(i + 3) % 32]!, seed[(i + 9) % 32]!, 255], i * 4); }
      const bytes = Buffer.from(jpeg.encode({ data, width: 8, height: 8 }, 90).data);
      const out = { mime: 'image/jpeg' as const, sha256: createHash('sha256').update(bytes).digest('hex'), width: input.placement.width, height: input.placement.height, contrast: { headline: 8 }, scrimAlpha: 0.42, headlineSize: 80, issues: [] };
      Object.defineProperty(out, 'bytes', { enumerable: false, get: () => Buffer.from(bytes) });
      return out as unknown as RenderedArtwork;
    });
  }
}

async function twoBrands() {
  const h = harness();
  const hearth = await creativeBrand(h, HEARTH);
  const queue = await creativeBrand(h, { ...QUEUE, owner: STRANGER });
  const library = new MemoryCreativeLibraryStore();
  const renderer = new StubRenderer();
  const saved: SavedImagePort = { list: async () => [], load: async () => { throw new Error('unused'); } };
  const studio = new CreativeStudioService({ library, brands: h.store, renderer, savedImages: saved });
  return { h, hearth, queue, library, renderer, studio };
}
const offerForm = (offer: string, destination: string, extra: Record<string, string | string[]> = {}) => ({ purpose: 'advert', source_kind: 'offer', offer, audience: '', destination, placements: ['square', 'portrait', 'vertical'], concepts: '3', ...extra });

test('image inputs: JPEG and PNG are verified structurally; SVG, truncated and oversized inputs are refused', () => {
  const jpg = verifyCreativeImage(syntheticLandscapeJpeg(320, 200));
  assert.equal(jpg.mime, 'image/jpeg'); assert.equal(jpg.width, 320); assert.equal(jpg.height, 200);
  assert.ok(!Object.keys(jpg).includes('bytes'), 'bytes are never enumerable metadata');
  const png = verifyCreativeImage(syntheticLogoPng([1, 2, 3]));
  assert.equal(png.mime, 'image/png'); assert.equal(png.width, 360);
  assert.throws(() => verifyCreativeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), /SVG and other formats/);
  const logo = syntheticLogoPng([1, 2, 3]);
  assert.throws(() => verifyCreativeImage(logo.subarray(0, logo.length - 6)), /PNG/);
  const tampered = Buffer.from(logo); tampered[40]! ^= 0xff;
  assert.throws(() => verifyCreativeImage(tampered), /integrity|malformed/);
  assert.throws(() => verifyCreativeImage(Buffer.alloc(9 * 1024 * 1024, 1)), /8 MB/);
});

test('brand context resolves each brand from its own rows, labels fallbacks and never applies guidance colours unconfirmed', async () => {
  const { h, hearth, queue } = await twoBrands();
  const a = resolveCreativeContext({ brand: hearth.brand, profile: await h.store.latestProfile(hearth.brand.id), knowledge: await h.store.listKnowledge(hearth.brand.id), kit: null });
  const b = resolveCreativeContext({ brand: queue.brand, profile: await h.store.latestProfile(queue.brand.id), knowledge: await h.store.listKnowledge(queue.brand.id), kit: null });
  assert.equal(a.confirmed, true); assert.equal(b.confirmed, true);
  assert.equal(a.offers[0]!.name, 'Annual boiler service'); assert.equal(b.offers[0]!.name, 'Scheduling demonstration');
  assert.ok(!JSON.stringify(b).includes('boiler') && !JSON.stringify(a).includes('clinic'), 'no cross-brand facts');
  assert.ok(!/property predator/iu.test(JSON.stringify(a) + JSON.stringify(b)), 'no Property Predator defaults leak into other brands');
  assert.deepEqual(a.palette, NEUTRAL_PALETTE); assert.equal(a.paletteSource, 'neutral_fallback');
  assert.deepEqual(a.suggestedColours, ['#0f766e', '#fbbf24'], 'guidance colours are suggestions only');
  assert.ok(a.decorativeGaps.some((g) => g.field === 'logo'));
  assert.notEqual(a.contextSha256, b.contextSha256);
  assert.throws(() => resolveCreativeContext({ brand: hearth.brand, profile: await_(h, queue.brand.id), knowledge: [], kit: null }), /another brand/);
  // An advert needs an approved destination; a link outside the approved pages is refused, never invented.
  assert.ok(essentialGaps(a, 'advert', { kind: 'offer', name: 'Annual boiler service' }, null).some((g) => g.field === 'destination'));
  assert.ok(essentialGaps(a, 'advert', { kind: 'offer', name: 'Annual boiler service' }, { url: 'https://evil.example' }).some((g) => g.field === 'destination'));
  assert.ok(essentialGaps(a, 'advert', { kind: 'offer', name: 'An offer that does not exist' }, { url: HEARTH.pages[0]!.url }).some((g) => g.field === 'offer'));
  assert.equal(essentialGaps(a, 'organic_social', { kind: 'offer', name: 'Annual boiler service' }, null).length, 0);
  // A document changed after confirmation: the profile is no longer usable for creative work.
  await h.engine.uploadKnowledge(OWNER, hearth.brand.id, { category: 'approved_claims', title: 'New claim', pastedText: 'A new claim that was never confirmed.' });
  const changed = resolveCreativeContext({ brand: hearth.brand, profile: await h.store.latestProfile(hearth.brand.id), knowledge: await h.store.listKnowledge(hearth.brand.id), kit: null });
  assert.equal(changed.confirmed, false);
});
function await_(_h: unknown, _id: string): never { throw new Error('Profile belongs to another brand.'); }

test('concepts are drafted only from approved facts: distinct angles, exact price, no invented figures, honest shortfall', async () => {
  const { h, hearth, queue } = await twoBrands();
  const ctx = resolveCreativeContext({ brand: hearth.brand, profile: await h.store.latestProfile(hearth.brand.id), knowledge: await h.store.listKnowledge(hearth.brand.id), kit: null });
  const request: CreativeRequest = { purpose: 'advert', source: { kind: 'offer', name: 'Annual boiler service' }, audience: 'Homeowners in Leeds', destination: HEARTH.pages[0]!, placements: ['square'], conceptCount: 3, cardCount: 0 };
  const { concepts, note } = draftConcepts({ context: ctx, request, article: null, background: { kind: 'neutral' } });
  assert.equal(concepts.length, 3); assert.equal(note, null);
  assert.equal(new Set(concepts.map((c) => c.headline)).size, 3, 'distinct headlines');
  assert.equal(concepts[0]!.headline, 'Annual boiler service — £89', 'the exact stored price, never a computed one');
  const corpus = factsCorpus(ctx, null);
  for (const c of concepts) { assert.deepEqual(copyIssues(c, ctx, corpus).filter((i) => i.code === 'unsupported_figure'), []); assert.equal(c.cta, 'Book a service'); }
  // Organic posts never add the price to the headline.
  assert.equal(draftConcepts({ context: ctx, request: { ...request, purpose: 'organic_social' }, article: null, background: { kind: 'neutral' } }).concepts[0]!.headline, 'Annual boiler service');
  // The second brand has no price: nothing is invented, and fewer facts give fewer concepts with an explanation.
  const qctx = resolveCreativeContext({ brand: queue.brand, profile: await h.store.latestProfile(queue.brand.id), knowledge: await h.store.listKnowledge(queue.brand.id), kit: null });
  const q = draftConcepts({ context: qctx, request: { ...request, source: { kind: 'offer', name: 'Scheduling demonstration' }, destination: QUEUE.pages[0]!, conceptCount: 3 }, article: null, background: { kind: 'neutral' } });
  assert.ok(q.concepts.every((c) => !/[£$€]/u.test(c.headline + c.body)));
  assert.ok(q.concepts.length >= 1);
  // Owner-typed figures are flagged; restricted phrases block.
  const edited = { ...concepts[0]!, headline: 'Save 40% with guaranteed savings' };
  const issues = copyIssues(edited, ctx, corpus);
  assert.ok(issues.some((i) => i.code === 'unsupported_figure' && !i.blocking && i.detail.includes('40%')));
  assert.ok(issues.some((i) => i.code === 'restricted_phrase' && i.blocking));
  assert.deepEqual(figures('From £89 a year, 2-hour windows'), ['£89', '2']);
  // Carousel: coordinated cards, the last carries the call to action.
  const carousel = draftConcepts({ context: ctx, request: { ...request, purpose: 'carousel', cardCount: 4, conceptCount: 1 }, article: null, background: { kind: 'neutral' } }).concepts[0]!;
  assert.equal(carousel.cards.length, 4); assert.equal(carousel.cards.at(-1)!.headline, 'Book a service');
});

test('studio service: idempotent drafts, component edits preserve other work, exact approvals and stale invalidation', async () => {
  const { h, hearth, studio, renderer, library } = await twoBrands();
  const id = hearth.brand.id, actor = OWNER.userId, command = randomUUID();
  const first = await studio.draft(actor, id, command, offerForm('Annual boiler service', HEARTH.pages[0]!.url), { kind: 'neutral' });
  const rendered = renderer.calls;
  assert.equal(rendered, 9, 'three concepts × three formats');
  const replay = await studio.draft(actor, id, command, offerForm('Annual boiler service', HEARTH.pages[0]!.url), { kind: 'neutral' });
  assert.equal(replay.replayed, true); assert.equal(replay.setId, first.setId); assert.equal(renderer.calls, rendered, 'a repeated command never re-renders');
  await assert.rejects(studio.draft(actor, id, command, offerForm('Annual boiler service', HEARTH.pages[0]!.url, { concepts: '1' }), { kind: 'neutral' }), /already used/);
  assert.deepEqual(studio.estimate((await library.getSet(id, first.setId))!.set.request, 'neutral'), { renders: 9, providerAttempts: 0, providerCostMinor: 0, note: 'Uses a neutral brand-colour background. No provider call.' });

  let got = await studio.getSet(actor, id, first.setId);
  const c2 = got.view.concepts[1]!.variants[0]!.version;
  await studio.approve(actor, id, c2.id, randomUUID(), c2.render.sha256, false);
  await assert.rejects(studio.approve(actor, id, c2.id, randomUUID(), 'f'.repeat(64), false), /changed since you reviewed|already approved/);
  const c1 = got.view.concepts[0]!;
  const edit = await studio.editConcept(actor, id, first.setId, 'c1', randomUUID(), c1.variants.map((v) => v.version.id), { headline: 'Your boiler, serviced calmly' }, { kind: 'keep' });
  assert.deepEqual(edit.changed, ['headline']);
  assert.equal(renderer.calls, rendered + 3, 'only the edited concept re-renders');
  got = await studio.getSet(actor, id, first.setId);
  assert.ok(got.view.concepts[0]!.variants.every((v) => v.version.number === 2 && v.version.parentVersionId && v.state === 'unapproved'));
  assert.equal(got.view.concepts[0]!.variants[0]!.version.componentShas.body, c1.variants[0]!.version.componentShas.body);
  assert.equal(got.view.concepts[1]!.variants[0]!.state, 'approved', 'the other concept keeps its approval');
  // A stale head list is refused rather than silently overwriting a newer version.
  await assert.rejects(studio.editConcept(actor, id, first.setId, 'c1', randomUUID(), c1.variants.map((v) => v.version.id), { headline: 'Late edit' }, { kind: 'keep' }), /changed while you were editing/);
  // Placement-level edit touches one format only.
  const vertical = got.view.concepts[2]!.variants.find((v) => v.version.placement === 'vertical')!.version;
  await studio.editFocal(actor, id, vertical.id, randomUUID(), { x: 0.25, y: 0.75 });
  got = await studio.getSet(actor, id, first.setId);
  assert.deepEqual(got.view.concepts[2]!.variants.map((v) => v.version.number).sort(), [1, 1, 2]);

  // Brand kit change → existing approvals become stale; the stale version cannot download as approved or be handed off.
  await studio.saveKit(actor, id, randomUUID(), { palette: { primary: '#0f766e', accent: '#fbbf24', dark: '#0b1f1d', light: '#ffffff' }, disclosure: 'Fictional fixture brand.', restricted: 'cheapest in town', logo: { kind: 'upload', bytes: syntheticLogoPng([255, 255, 255]), label: 'Fixture logo' }, expectedVersion: 0 });
  got = await studio.getSet(actor, id, first.setId);
  const staleV = got.view.concepts[1]!.variants[0]!;
  assert.equal(staleV.state, 'stale');
  assert.equal((await studio.artwork(actor, id, staleV.version.id, staleV.version.render.sha256)).approved, false);
  const article = randomUUID();
  await assert.rejects(studio.handoff(actor, id, staleV.version.id, randomUUID(), { kind: 'article_campaign', articleId: article }), /not found|no longer|changed/);
  await assert.rejects(studio.approve(actor, id, got.view.concepts[0]!.variants[0]!.version.id, randomUUID(), got.view.concepts[0]!.variants[0]!.version.render.sha256, false), /changed since this version was made/);
  await studio.refreshConcept(actor, id, first.setId, 'c2', randomUUID(), got.view.concepts[1]!.variants.map((v) => v.version.id));
  got = await studio.getSet(actor, id, first.setId);
  const fresh = got.view.concepts[1]!.variants[0]!.version;
  assert.equal(fresh.context.kitVersion, 1);
  assert.equal(renderer.inputs.at(-1)!.logo?.sha256, verifyCreativeImage(syntheticLogoPng([255, 255, 255])).sha256, 'the exact approved logo bytes reach the renderer');
  assert.equal(renderer.inputs.at(-1)!.disclosure, 'Fictional fixture brand.');
  await studio.approve(actor, id, fresh.id, randomUUID(), fresh.render.sha256, false);
  const download = await studio.artwork(actor, id, fresh.id, fresh.render.sha256);
  assert.equal(download.approved, true);
  assert.equal(createHash('sha256').update(download.bytes).digest('hex'), fresh.render.sha256);
  assert.equal(h.web.requests?.length ?? 0, 0, 'no network effect');
});

test('studio service: brand isolation — another owner cannot read, render into or approve a brand they do not manage', async () => {
  const { hearth, queue, studio } = await twoBrands();
  const set = await studio.draft(OWNER.userId, hearth.brand.id, randomUUID(), offerForm('Annual boiler service', HEARTH.pages[0]!.url, { concepts: '1', placements: 'square' }), { kind: 'neutral' });
  for (const attempt of [
    () => studio.getSet(STRANGER.userId, hearth.brand.id, set.setId),
    () => studio.overview(STRANGER.userId, hearth.brand.id),
    () => studio.draft(STRANGER.userId, hearth.brand.id, randomUUID(), offerForm('Annual boiler service', HEARTH.pages[0]!.url), { kind: 'neutral' }),
    () => studio.saveKit(STRANGER.userId, hearth.brand.id, randomUUID(), { palette: NEUTRAL_PALETTE, disclosure: '', restricted: '', logo: { kind: 'keep' }, expectedVersion: 0 }),
  ]) await assert.rejects(attempt(), /do not manage/);
  // The second brand's owner sees only their own library, and the first brand's set id is not found under it.
  assert.deepEqual((await studio.overview(STRANGER.userId, queue.brand.id)).sets, []);
  await assert.rejects(studio.getSet(STRANGER.userId, queue.brand.id, set.setId), /not found/);
  const version = (await studio.getSet(OWNER.userId, hearth.brand.id, set.setId)).view.concepts[0]!.variants[0]!.version;
  await assert.rejects(studio.approve(STRANGER.userId, queue.brand.id, version.id, randomUUID(), version.render.sha256, false), /not found/);
  await assert.rejects(studio.artwork(STRANGER.userId, queue.brand.id, version.id, version.render.sha256), /not found/);
  // Another brand's offer name cannot be used.
  await assert.rejects(studio.draft(STRANGER.userId, queue.brand.id, randomUUID(), offerForm('Annual boiler service', QUEUE.pages[0]!.url), { kind: 'neutral' }), /offer/);
});

test('unsupported figures need explicit confirmation; blocking issues refuse approval', async () => {
  const { hearth, studio } = await twoBrands();
  const id = hearth.brand.id, actor = OWNER.userId;
  const set = await studio.draft(actor, id, randomUUID(), { ...offerForm('', HEARTH.pages[0]!.url, { concepts: '1', placements: 'square' }), purpose: 'organic_social', source_kind: 'brief', brief: 'Book before Friday and save 25% on your first service. Friendly engineers.' }, { kind: 'neutral' });
  const v = (await studio.getSet(actor, id, set.setId)).view.concepts[0]!.variants[0]!.version;
  assert.ok(v.issues.some((i) => i.code === 'unsupported_figure'));
  await assert.rejects(studio.approve(actor, id, v.id, randomUUID(), v.render.sha256, false), /Confirm the figures/);
  await studio.approve(actor, id, v.id, randomUUID(), v.render.sha256, true);
  const edited = await studio.editConcept(actor, id, set.setId, 'c1', randomUUID(), [v.id], { body: 'The cheapest in town.' }, { kind: 'keep' });
  assert.deepEqual(edited.changed, ['body']);
  // Restricted wording from the profile exclusions blocks approval.
  const withRestricted = await studio.editConcept(actor, id, set.setId, 'c1', randomUUID(), [], { body: 'Guaranteed savings on every visit.' }, { kind: 'keep' });
  assert.deepEqual(withRestricted.changed, ['body']);
  const head = (await studio.getSet(actor, id, set.setId)).view.concepts[0]!.variants[0]!.version;
  assert.ok(head.issues.some((i) => i.code === 'restricted_phrase' && i.blocking));
  await assert.rejects(studio.approve(actor, id, head.id, randomUUID(), head.render.sha256, true), /blocking/);
});

test('saved generated images are reused with provenance and integrity checks, without a new provider call', async () => {
  const h = harness(); const hearth = await creativeBrand(h, HEARTH);
  const bytes = syntheticLandscapeJpeg(400, 260); const sha = createHash('sha256').update(bytes).digest('hex');
  let loads = 0;
  const fixed = { assetId: randomUUID(), sha256: sha, articleId: randomUUID(), articleTitle: 'Boiler checklist', intentId: randomUUID(), attemptId: randomUUID(), preparedAt: '2026-11-01T00:00:00.000Z' };
  const saved: SavedImagePort = {
    list: async () => [fixed],
    load: async () => { loads++; return bytes; },
  };
  const renderer = new StubRenderer();
  const studio = new CreativeStudioService({ library: new MemoryCreativeLibraryStore(), brands: h.store, renderer, savedImages: saved });
  const [item] = await saved.list(OWNER.userId, hearth.brand.id);
  const set = await studio.draft(OWNER.userId, hearth.brand.id, randomUUID(), offerForm('Annual boiler service', HEARTH.pages[0]!.url, { concepts: '1', placements: 'square' }), { kind: 'saved', assetId: item!.assetId, sha256: sha });
  const v = (await studio.getSet(OWNER.userId, hearth.brand.id, set.setId)).view.concepts[0]!.variants[0]!.version;
  assert.equal(loads, 1);
  assert.equal(v.concept.background.kind, 'image');
  if (v.concept.background.kind === 'image') {
    assert.equal(v.concept.background.origin, 'generated_article_image');
    assert.equal(v.concept.background.provenance.attemptId, item!.attemptId, 'generation receipt reference preserved');
    assert.equal(v.concept.background.provenance.candidateSha256, sha);
  }
  assert.equal(v.concept.illustrativeTag, true, 'generated scenes are marked illustrative by default');
  await assert.rejects(studio.draft(OWNER.userId, hearth.brand.id, randomUUID(), offerForm('Annual boiler service', HEARTH.pages[0]!.url), { kind: 'saved', assetId: item!.assetId, sha256: 'a'.repeat(64) }), /not available/);
});

test('renderer markup keeps text exact and escaped, reaches only the private pseudo-origin, and colour maths is WCAG', () => {
  const html = artworkHtml({ placement: PLACEMENTS.square, palette: NEUTRAL_PALETTE, brandName: 'A & B <Brand>', logo: null, background: null, focal: { x: 0.5, y: 0.5 },
    hook: null, headline: '<img src=x onerror=alert(1)> Exact £89', body: null, cta: 'Go', disclosure: 'T&Cs apply.', illustrativeTag: false, card: null });
  assert.ok(html.includes('&#60;img src=x onerror=alert(1)&#62; Exact £89'));
  assert.ok(!/<script/iu.test(html));
  const urls = [...html.matchAll(/url\(([^)]+)\)|src="([^"]+)"/gu)].map((m) => m[1] ?? m[2]);
  assert.ok(urls.length > 0 && urls.every((u) => u!.startsWith('https://render.invalid/')));
  assert.equal(contrastRatio(luminance(parseHex('#ffffff')!), luminance(parseHex('#000000')!)).toFixed(0), '21');
});

test('real Chromium renders exact-size JPEG artwork with the real logo, measured contrast and honest layout issues', { skip: chromium ? false : 'Chromium not installed here' }, async () => {
  const renderer = new ChromiumArtworkRenderer(chromium);
  const bg = verifyCreativeImage(syntheticLandscapeJpeg());
  const logo = verifyCreativeImage(syntheticLogoPng([255, 0, 0]));
  const palette = { primary: '#0f766e', accent: '#fbbf24', dark: '#0b1f1d', light: '#ffffff' };
  const base = { palette, brandName: 'Fictional Hearth Maintenance', logo, background: bg, focal: { x: 0.5, y: 0.5 }, hook: 'For homeowners in Leeds', headline: 'Annual boiler service — £89',
    body: 'A yearly safety check and service of a domestic gas boiler by a registered engineer.', cta: 'Book a service', disclosure: 'Fictional fixture brand.', illustrativeTag: true, card: null };
  const [square, vertical, overflow, unreadable, headlineOnly] = await renderer.renderBatch([
    { ...base, placement: PLACEMENTS.square },
    { ...base, placement: PLACEMENTS.vertical },
    { ...base, placement: PLACEMENTS.landscape, headline: 'This headline is deliberately far too long to fit a landscape link image at any legible size because it keeps going and going and going without stopping at all', body: 'And a body that is also much too long for the space available on a small landscape link preview image, repeated twice. And a body that is also much too long.' },
    { ...base, placement: PLACEMENTS.square, background: null, palette: { primary: '#ffffff', accent: '#ffffff', dark: '#ffffff', light: '#f8f8f8' } },
    // Regression: a headline-only carousel card whose last glyph descender overhangs its line box is not an overflow.
    { ...base, placement: PLACEMENTS.portrait, background: null, hook: null, body: null, cta: null, disclosure: null, headline: 'Reminders are sent by email and text message.', card: { current: 2, total: 3 } },
  ]);
  assert.deepEqual(headlineOnly!.issues, []); assert.equal(headlineOnly!.headlineSize, PLACEMENTS.portrait.headline.max);
  for (const [r, p] of [[square!, PLACEMENTS.square], [vertical!, PLACEMENTS.vertical]] as const) {
    const decoded = jpeg.decode(r.bytes, { useTArray: true });
    assert.equal(decoded.width, p.width); assert.equal(decoded.height, p.height);
    assert.equal(createHash('sha256').update(r.bytes).digest('hex'), r.sha256);
    assert.deepEqual(r.issues, []);
    assert.ok(r.contrast.headline! >= 3 && r.contrast.body! >= 4.5 && r.contrast.disclosure! >= 4.5);
  }
  // The pure-red approved logo appears unchanged in the top-left safe area (never redrawn by a model).
  const d = jpeg.decode(square!.bytes, { useTArray: true });
  let red = 0;
  for (let y = 70; y < 200; y++) for (let x = 70; x < 460; x++) { const i = (y * d.width + x) * 4; if (d.data[i]! > 200 && d.data[i + 1]! < 60 && d.data[i + 2]! < 60) red++; }
  assert.ok(red > 2000, `logo pixels present (${red})`);
  assert.ok(overflow!.issues.some((i) => i.code === 'text_overflow' && i.blocking));
  assert.ok(unreadable!.issues.some((i) => i.code === 'low_contrast') && unreadable!.issues.some((i) => i.code === 'cta_contrast'));
});

// ─── Routes ─────────────────────────────────────────────────────────────────
function identity(userId: string): PortalSessionIdentity { return { sessionToken: `token-${userId}`, userId, workspaceId: '33333333-3333-4333-8333-333333333333', userEmail: 'owner@example.test' }; }
async function call(service: PortalSeoBlogService, who: PortalSessionIdentity | null, method: string, path: string, form?: Record<string, string | string[]>, extraHeaders: Record<string, string> = {}) {
  const body = form ? new URLSearchParams(Object.entries(form).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))).toString() : '';
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: path, headers: { host: 'portal.example', ...(form ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)), origin: 'https://portal.example' } : {}), ...extraHeaders } });
  (req as PassThrough).end(body);
  let status = 0; let headers: Record<string, string> = {}; let out: Buffer = Buffer.alloc(0);
  const res = { writeHead(s: number, h: Record<string, string>) { status = s; headers = h; return res; }, end(chunk?: string | Buffer) { if (chunk) out = Buffer.concat([out, Buffer.from(chunk)]); } } as unknown as ServerResponse;
  await handleSeoBlog(req, res, new URL(path, 'https://portal.example'), { service, identity: who, requestId: `r-${randomUUID()}`, sessionSecret: SECRET, vaultReady: true });
  return { status, headers, body: out.toString('utf8'), bytes: out };
}

test('routes: the Creative tab is off unless enabled; owner journey works; CSRF, cross-site and foreign brands are refused', async () => {
  const { h, hearth, queue, studio, renderer } = await twoBrands();
  const disabled: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => h.engine, socialCallback: async () => null };
  const owner = identity(OWNER.userId), csrf = portalCsrfToken(SECRET, owner.sessionToken), base = `/portal/seo-blog/b/${hearth.brand.id}/creative`;
  assert.equal((await call(disabled, owner, 'GET', base)).status, 404);
  assert.doesNotMatch((await call(disabled, owner, 'GET', `/portal/seo-blog/b/${hearth.brand.id}/overview`)).body, /Creative studio/);
  const service: PortalSeoBlogService = { ...disabled, creativeEnabled: true, creativeFor: () => studio, creativeSavedImages: async () => [] };
  const page = await call(service, owner, 'GET', base);
  assert.equal(page.status, 200);
  for (const text of ['Creative studio', 'Create images', 'Annual boiler service — £89', 'Book a service', 'Neutral fallback', 'no provider call and no image-generation charge']) assert.ok(page.body.includes(text), text);
  assert.ok(!page.body.includes('Scheduling demonstration'), 'no other brand facts on the page');
  const form = { ...offerForm('Annual boiler service', HEARTH.pages[0]!.url, { concepts: '2' }), commandId: randomUUID(), background: 'neutral' };
  for (const refused of [await call(service, owner, 'POST', `${base}/draft`, form), await call(service, owner, 'POST', `${base}/draft`, { ...form, _csrf: csrf }, { origin: 'https://evil.example' })]) {
    assert.equal(refused.status, 303, 'refused with an error message, as for every brand-scoped form');
    assert.ok(new URL(refused.headers.location!, 'https://x').searchParams.has('e'));
  }
  assert.equal(renderer.calls, 0);
  const created = await call(service, owner, 'POST', `${base}/draft`, { ...form, _csrf: csrf });
  assert.equal(created.status, 303);
  const location = new URL(created.headers.location!, 'https://portal.example');
  assert.match(location.pathname, new RegExp(`${base}/s/[0-9a-f-]{36}$`));
  const compare = await call(service, owner, 'GET', location.pathname);
  assert.equal(compare.status, 200);
  for (const text of ['Compare artwork', 'Approve this image', 'Download', 'does not approve a caption, campaign, schedule or paid advert', 'Vertical story']) assert.ok(compare.body.includes(text), text);
  const art = /src="([^"]+\/art\/[^"]+\.jpg)"/u.exec(compare.body)![1]!;
  const image = await call(service, owner, 'GET', art);
  assert.equal(image.status, 200); assert.equal(image.headers['content-type'], 'image/jpeg'); assert.equal(image.headers['x-content-type-options'], 'nosniff');
  assert.equal(createHash('sha256').update(image.bytes).digest('hex'), art.split('/').at(-1)!.replace('.jpg', ''));
  assert.equal((await call(service, owner, 'GET', art.replace(/\.jpg$/u, '.mp4'))).status, 404, 'the extension must match the stored media type');
  const dl = await call(service, owner, 'GET', `${art}?download=1`);
  assert.match(dl.headers['content-disposition']!, /attachment; filename=".*-draft\.jpg"/);
  // Approve via the route, then download is labelled approved.
  const versionId = art.split('/').at(-2)!, sha = art.split('/').at(-1)!.replace('.jpg', '');
  const approved = await call(service, owner, 'POST', `${base}/v/${versionId}/approve`, { _csrf: csrf, commandId: randomUUID(), sha });
  assert.equal(approved.status, 303); assert.ok(new URL(approved.headers.location!, 'https://x').searchParams.has('n'));
  assert.match((await call(service, owner, 'GET', `${art}?download=1`)).headers['content-disposition']!, /-approved\.jpg"/);
  // A stranger cannot open this brand's studio, artwork or commands.
  const stranger = identity(STRANGER.userId), scsrf = portalCsrfToken(SECRET, stranger.sessionToken);
  assert.notEqual((await call(service, stranger, 'GET', base)).status, 200);
  assert.notEqual((await call(service, stranger, 'GET', art)).status, 200);
  const foreignApprove = await call(service, stranger, 'POST', `${base}/v/${versionId}/approve`, { _csrf: scsrf, commandId: randomUUID(), sha });
  assert.ok(foreignApprove.status === 404 || new URL(foreignApprove.headers.location ?? '/?e=1', 'https://x').searchParams.has('e'));
  assert.equal((await call(service, stranger, 'GET', `/portal/seo-blog/b/${queue.brand.id}/creative`)).status, 200, 'the stranger has their own studio');
});

test('typed-brief generated images: previews and backgrounds come only from this brand’s recorded generations, digest-checked', async () => {
  const h = harness(); const hearth = await creativeBrand(h, HEARTH); const queue = await creativeBrand(h, QUEUE);
  const bytes = syntheticLandscapeJpeg(400, 260); const sha = createHash('sha256').update(bytes).digest('hex');
  const g = { id: randomUUID(), briefId: randomUUID(), briefVersion: 2, jobId: randomUUID(), intentId: randomUUID(), attemptId: randomUUID(), assetId: randomUUID(), sha256: sha,
    width: 400, height: 260, data: { model: 'gpt-image-2' }, createdAt: '2026-11-09T00:00:00.000Z' };
  let served = bytes;
  const studio = new CreativeStudioService({ library: new MemoryCreativeLibraryStore(), brands: h.store, renderer: new StubRenderer(),
    generatedImages: { find: async (_a, brandId, id) => (brandId === hearth.brand.id && id === g.id ? g : null), load: async () => served } });
  assert.deepEqual((await studio.generatedImage(OWNER.userId, hearth.brand.id, g.id)).sha256, sha);
  await assert.rejects(studio.generatedImage(OWNER.userId, queue.brand.id, g.id), /not available/u, 'another brand cannot read it');
  await assert.rejects(studio.generatedImage(STRANGER.userId, hearth.brand.id, g.id), (e: Error) => !/integrity/u.test(e.message), 'a non-manager is refused first');
  const set = await studio.draft(OWNER.userId, hearth.brand.id, randomUUID(), offerForm('Annual boiler service', HEARTH.pages[0]!.url, { concepts: '1', placements: 'square' }), { kind: 'generated', generationId: g.id });
  const bg = (await studio.getSet(OWNER.userId, hearth.brand.id, set.setId)).view.concepts[0]!.variants[0]!.version.concept.background;
  assert.equal(bg.kind, 'image');
  if (bg.kind === 'image') { assert.equal(bg.origin, 'generated_studio_image'); assert.equal(bg.provenance.attemptId, g.attemptId); assert.equal(bg.provenance.briefVersion, '2'); }
  served = syntheticLandscapeJpeg(400, 261);
  await assert.rejects(studio.generatedImage(OWNER.userId, hearth.brand.id, g.id), /integrity/u);
});
