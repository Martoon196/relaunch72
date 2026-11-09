/** Milestone 3: storyboards (plans) and playback-verified videos in the creative library. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import jpeg from 'jpeg-js';
import { CreativeStudioService, draftScenes, endorsementIssues, setView, validateScenes } from '../src/creative-studio/service.js';
import { MemoryCreativeLibraryStore } from '../src/creative-studio/store.js';
import { ChromiumArtworkRenderer, findCreativeChromium, type ArtworkInput, type ArtworkRenderer, type ContactSheetFrame, type RenderedArtwork, type RenderedVideo, type VideoInput } from '../src/creative-studio/renderer.js';
import { verifyCreativeImage } from '../src/creative-studio/image-input.js';
import { PLACEMENTS } from '../src/creative-studio/placements.js';
import type { ConceptComponents } from '../src/creative-studio/types.js';
import { remuxFragmentedMp4 } from '../src/creative-studio/mp4-remux.js';
import { harness, OWNER } from './seo-blog-fixtures.js';
import { creativeBrand, HEARTH, syntheticLandscapeJpeg, syntheticLogoPng } from './creative-studio-fixtures.js';

const tiny = (seed: string) => { const h = createHash('sha256').update(seed).digest(); const d = Buffer.alloc(16 * 4); for (let i = 0; i < 16; i++) d.set([h[i]!, h[i + 1]!, h[i + 2]!, 255], i * 4); return Buffer.from(jpeg.encode({ data: d, width: 4, height: 4 }, 90).data); };
const withBytes = <T extends object>(o: T, key: string, b: Buffer) => { Object.defineProperty(o, key, { enumerable: false, get: () => Buffer.from(b) }); return o; };

/** Labelled stub: real tiny bytes that depend on exact inputs; playback outcome is configurable. */
class MotionStub implements ArtworkRenderer {
  readonly version = 'test-motion-stub'; frames = 0; videos = 0; playable = true; lastVideo: VideoInput | null = null;
  available() { return true; }
  async renderBatch(inputs: readonly ArtworkInput[]): Promise<RenderedArtwork[]> {
    return inputs.map((i) => { this.frames++; const b = tiny(JSON.stringify([i.placement.id, i.headline, i.body, i.cta, i.palette]));
      const o = withBytes({ mime: 'image/jpeg' as const, sha256: createHash('sha256').update(b).digest('hex'), width: i.placement.width, height: i.placement.height, contrast: { headline: 9 }, scrimAlpha: 0.42, headlineSize: 80, issues: [] }, 'bytes', b);
      return (i.captureOverlay ? withBytes(o, 'overlay', Buffer.from('png-overlay-' + i.headline)) : o) as unknown as RenderedArtwork; });
  }
  async renderContactSheet(frames: readonly ContactSheetFrame[], title: string) { const b = tiny(title + frames.map((f) => f.caption + f.script).join('|')); return { bytes: b, sha256: createHash('sha256').update(b).digest('hex'), width: 1600, height: 900 }; }
  async renderVideo(input: VideoInput): Promise<RenderedVideo> {
    this.videos++; this.lastVideo = input;
    const b = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from(JSON.stringify(input.scenes.map((s) => [s.durationMs, s.motion, s.overlay.toString()])))]);
    const ms = input.scenes.reduce((n, s) => n + s.durationMs, 0);
    return withBytes({ mime: 'video/mp4' as const, codec: 'video/mp4;codecs=avc1.640028', container: 'progressive' as const, sha256: createHash('sha256').update(b).digest('hex'), width: input.width, height: input.height,
      durationMs: ms, measuredDurationMs: this.playable ? ms - 40 : null, playable: this.playable, byteLength: b.length }, 'bytes', b) as unknown as RenderedVideo;
  }
}

async function studioWithSet(background: 'neutral' | 'upload' = 'neutral') {
  const h = harness(); const hearth = await creativeBrand(h, HEARTH);
  const library = new MemoryCreativeLibraryStore(), renderer = new MotionStub();
  const studio = new CreativeStudioService({ library, brands: h.store, renderer });
  const set = await studio.draft(OWNER.userId, hearth.brand.id, randomUUID(), { purpose: 'advert', source_kind: 'offer', offer: HEARTH.offers[0]!.name, audience: '', destination: HEARTH.pages[0]!.url, placements: ['vertical', 'square'], concepts: '2' },
    background === 'upload' ? { kind: 'upload', bytes: syntheticLandscapeJpeg(600, 400) } : { kind: 'neutral' });
  return { h, hearth, library, renderer, studio, setId: set.setId, brandId: hearth.brand.id };
}
const view = async (s: Awaited<ReturnType<typeof studioWithSet>>) => setView((await s.library.getSet(s.brandId, s.setId))!, (await s.studio.context(OWNER.userId, s.brandId)).context);

test('scenes are drafted only from the concept’s own copy, with bounded timing and an end card', () => {
  const concept: ConceptComponents = { angle: 'Offer-led', hook: 'For homeowners', headline: 'Annual boiler service — £89', body: 'A yearly safety check. By a registered engineer.', cta: 'Book a service',
    background: { kind: 'neutral' }, illustrativeTag: false, cards: [] };
  const scenes = draftScenes(concept);
  assert.deepEqual(scenes.map((s) => s.headline), ['Annual boiler service — £89', 'A yearly safety check.', 'Book a service']);
  assert.equal(scenes.at(-1)!.showCta, true); assert.ok(scenes.reduce((n, s) => n + s.durationMs, 0) <= 30_000);
  const cards = draftScenes({ ...concept, cards: [{ headline: 'One', body: '' }, { headline: 'Two', body: 'b' }, { headline: 'Book a service', body: '' }] });
  assert.deepEqual(cards.map((s) => [s.headline, s.showCta]), [['One', false], ['Two', false], ['Book a service', true]]);
  assert.throws(() => validateScenes([scenes[0]!], concept), /2 to 8 scenes/);
  assert.throws(() => validateScenes(Array.from({ length: 5 }, () => ({ ...scenes[0]!, durationMs: 8000 })), concept), /30 seconds/);
  assert.throws(() => validateScenes([{ ...scenes[0]!, motion: 'spin' as never }, scenes[1]!], concept), /motion/);
  assert.throws(() => validateScenes([{ ...scenes[0]!, showCta: true }, scenes[1]!], { ...concept, cta: '' }), /no call to action/);
  for (const bad of ['“Brilliant service, fixed in an hour” — Sarah, Leeds', '★★★★★ from our customers', 'Read our customer reviews', 'Rated 4.9 stars'])
    assert.equal(endorsementIssues([bad])[0]?.code, 'fictional_endorsement', bad);
  assert.deepEqual(endorsementIssues(['A yearly safety check by a registered engineer.']), []);
});

test('storyboard → scene edit → video: exact lineage, never approvable as a storyboard, approvable as a verified video', async () => {
  const s = await studioWithSet();
  const c1 = (await view(s)).concepts[0]!;
  await s.studio.createStoryboard(OWNER.userId, s.brandId, s.setId, 'c1', 'vertical', randomUUID(), false);
  let v = (await view(s)).concepts[0]!;
  const sb = v.storyboards[0]!.version;
  assert.equal(sb.media, 'storyboard'); assert.equal(sb.render.mime, 'image/jpeg'); assert.equal(v.videos.length, 0);
  assert.deepEqual(v.variants.map((x) => x.version.id).sort(), c1.variants.map((x) => x.version.id).sort(), 'image versions untouched');
  await assert.rejects(s.studio.approve(OWNER.userId, s.brandId, sb.id, randomUUID(), sb.render.sha256, false), /storyboard is a plan/);
  // Scene-level revision.
  const scenes = sb.variant.storyboard!.scenes.map((x) => ({ ...x }));
  scenes[1] = { ...scenes[1]!, headline: 'Checked by a registered engineer', durationMs: 4500 };
  const edit = await s.studio.editStoryboard(OWNER.userId, s.brandId, sb.id, randomUUID(), scenes);
  assert.deepEqual(edit.changed, ['scene 2 headline', 'scene 2 duration']);
  v = (await view(s)).concepts[0]!;
  const sb2 = v.storyboards[0]!.version;
  assert.equal(sb2.number, 2); assert.equal(sb2.parentVersionId, sb.id);
  assert.deepEqual(sb2.variant.storyboard!.scenes[0], sb.variant.storyboard!.scenes[0], 'unchanged scenes keep their exact content');
  // Old storyboard cannot be rendered; the current one can.
  await assert.rejects(s.studio.renderVideo(OWNER.userId, s.brandId, sb.id, randomUUID()), /newer storyboard/);
  const cmd = randomUUID();
  assert.equal((await s.studio.renderVideo(OWNER.userId, s.brandId, sb2.id, cmd)).playable, true);
  assert.equal(s.renderer.videos, 1);
  assert.equal((await s.studio.renderVideo(OWNER.userId, s.brandId, sb2.id, cmd)).replayed, true); assert.equal(s.renderer.videos, 1, 'replay never re-renders');
  assert.deepEqual(s.renderer.lastVideo!.scenes.map((x) => x.durationMs), sb2.variant.storyboard!.scenes.map((x) => x.durationMs));
  assert.ok(s.renderer.lastVideo!.scenes.every((x) => x.overlay.toString().startsWith('png-overlay-')), 'video uses the measured overlay layers');
  v = (await view(s)).concepts[0]!;
  const video = v.videos[0]!.version;
  assert.equal(video.media, 'video'); assert.equal(video.render.mime, 'video/mp4'); assert.equal(video.variant.storyboard!.sourceStoryboardVersionId, sb2.id);
  assert.equal(video.variant.storyboard!.sourceStoryboardSpecSha256, sb2.specSha256);
  await s.studio.approve(OWNER.userId, s.brandId, video.id, randomUUID(), video.render.sha256, false);
  const dl = await s.studio.artwork(OWNER.userId, s.brandId, video.id, video.render.sha256);
  assert.equal(dl.approved, true); assert.equal(createHash('sha256').update(dl.bytes).digest('hex'), video.render.sha256);
  // Editing concept copy re-renders images only and leaves the video and its approval intact.
  await s.studio.editConcept(OWNER.userId, s.brandId, s.setId, 'c1', randomUUID(), v.variants.map((x) => x.version.id), { headline: 'A calmer boiler service' }, { kind: 'keep' });
  const after = (await view(s)).concepts[0]!;
  assert.equal(after.videos[0]!.version.id, video.id); assert.equal(after.videos[0]!.state, 'approved');
  assert.ok(after.variants.every((x) => x.version.number === 2));
});

test('unplayable output, endorsement copy, stale brand context and missing likeness permission are all refused', async () => {
  const s = await studioWithSet();
  await s.studio.createStoryboard(OWNER.userId, s.brandId, s.setId, 'c1', 'square', randomUUID(), false);
  let sb = (await view(s)).concepts[0]!.storyboards[0]!.version;
  s.renderer.playable = false;
  assert.equal((await s.studio.renderVideo(OWNER.userId, s.brandId, sb.id, randomUUID())).playable, false);
  let video = (await view(s)).concepts[0]!.videos[0]!.version;
  assert.ok(video.issues.some((i) => i.code === 'not_playable' && i.blocking));
  await assert.rejects(s.studio.approve(OWNER.userId, s.brandId, video.id, randomUUID(), video.render.sha256, false), /blocking/);
  s.renderer.playable = true;
  // A fabricated testimonial scene blocks rendering.
  const scenes = sb.variant.storyboard!.scenes.map((x) => ({ ...x }));
  scenes[0] = { ...scenes[0]!, headline: '“Best boiler service ever” — Sarah' };
  await s.studio.editStoryboard(OWNER.userId, s.brandId, sb.id, randomUUID(), scenes);
  sb = (await view(s)).concepts[0]!.storyboards[0]!.version;
  assert.ok(sb.issues.some((i) => i.code === 'fictional_endorsement'));
  await assert.rejects(s.studio.renderVideo(OWNER.userId, s.brandId, sb.id, randomUUID()), /blocking issues/);
  // A kit change makes the storyboard stale for rendering and the earlier video stale for approval.
  await s.studio.saveKit(OWNER.userId, s.brandId, randomUUID(), { palette: { primary: '#0f766e', accent: '#fbbf24', dark: '#0b2421', light: '#ffffff' }, disclosure: '', restricted: '', logo: { kind: 'keep' }, expectedVersion: 0 });
  scenes[0] = { ...scenes[0]!, headline: 'Is your boiler ready?' };
  const fresh = (await view(s)).concepts[0]!;
  assert.equal(fresh.videos[0]!.staleContext, true);
  await assert.rejects(s.studio.editStoryboard(OWNER.userId, s.brandId, sb.id, randomUUID(), scenes).then(async () => {
    const latest = (await view(s)).concepts[0]!.storyboards[0]!.version; return s.studio.renderVideo(OWNER.userId, s.brandId, sb.id, randomUUID()).then(() => latest); }), /newer storyboard/);
  const up = await studioWithSet('upload');
  await assert.rejects(up.studio.createStoryboard(OWNER.userId, up.brandId, up.setId, 'c1', 'vertical', randomUUID(), false), /permission for any identifiable person/);
  await up.studio.createStoryboard(OWNER.userId, up.brandId, up.setId, 'c1', 'vertical', randomUUID(), true);
  assert.equal((await view(up)).concepts[0]!.storyboards[0]!.version.variant.storyboard!.likenessPermission, true);
  video = (await view(s)).concepts[0]!.videos[0]!.version;
  assert.equal(video.variant.storyboard!.sourceStoryboardVersionId !== undefined, true);
});

test('library refuses a video that does not come from an exact storyboard of the same concept and format', async () => {
  const s = await studioWithSet();
  await s.studio.createStoryboard(OWNER.userId, s.brandId, s.setId, 'c1', 'vertical', randomUUID(), false);
  await s.studio.renderVideo(OWNER.userId, s.brandId, (await view(s)).concepts[0]!.storyboards[0]!.version.id, randomUUID());
  const video = (await view(s)).concepts[0]!.videos[0]!.version;
  const forged = { ...video, id: randomUUID(), number: 2, parentVersionId: video.id, variant: { ...video.variant, storyboard: { ...video.variant.storyboard!, sourceStoryboardSpecSha256: 'f'.repeat(64) } } };
  await assert.rejects(s.library.appendVersions(s.brandId, randomUUID(), 'a'.repeat(64), s.setId, [forged], video.context), /exact storyboard/);
});

test('real Chromium records a playable MP4/WebM of the exact scenes and the playback check measures it', { skip: findCreativeChromium() ? false : 'Chromium not installed here' }, async () => {
  const r = new ChromiumArtworkRenderer();
  const bg = verifyCreativeImage(syntheticLandscapeJpeg()), logo = verifyCreativeImage(syntheticLogoPng([255, 255, 255]));
  const palette = { primary: '#0f766e', accent: '#fbbf24', dark: '#0b2421', light: '#ffffff' };
  const base = { placement: PLACEMENTS.square, palette, brandName: 'Hearth', logo, background: bg, focal: { x: 0.5, y: 0.5 }, hook: null, body: null, cta: null, disclosure: 'Fictional demonstration brand.', illustrativeTag: true, card: null, captureOverlay: true };
  const frames = await r.renderBatch([{ ...base, headline: 'Is your boiler ready for winter?' }, { ...base, background: null, headline: 'Book a service', cta: 'Book a service' }]);
  assert.ok(frames.every((f) => f.overlay && f.overlay.subarray(1, 4).toString() === 'PNG'));
  const v = await r.renderVideo({ width: 1080, height: 1080, palette, scenes: [{ background: bg, focal: { x: 0.5, y: 0.5 }, overlay: frames[0]!.overlay!, durationMs: 2000, motion: 'zoom_in' }, { background: null, focal: { x: 0.5, y: 0.5 }, overlay: frames[1]!.overlay!, durationMs: 2000, motion: 'none' }] });
  assert.equal(v.playable, true); assert.equal(v.width, 1080); assert.equal(v.height, 1080); assert.equal(v.durationMs, 4000);
  assert.ok(v.measuredDurationMs !== null && Math.abs(v.measuredDurationMs - 4000) <= 1000, `measured ${v.measuredDurationMs}`);
  const head = v.bytes.subarray(0, 12);
  assert.ok(v.mime === 'video/mp4' ? head.subarray(4, 8).toString() === 'ftyp' : head.readUInt32BE(0) === 0x1a45dfa3, 'real container signature');
  assert.equal(createHash('sha256').update(v.bytes).digest('hex'), v.sha256);
  if (v.mime === 'video/mp4') {
    assert.equal(v.container, 'progressive', 'recorder output is rewritten as a standard index-first MP4');
    const order: string[] = []; for (let o = 0; o < v.bytes.length;) { const n = v.bytes.readUInt32BE(o); order.push(v.bytes.toString('latin1', o + 4, o + 8)); o += n; }
    assert.deepEqual(order, ['ftyp', 'moov', 'mdat']);
    assert.equal(remuxFragmentedMp4(v.bytes), null, 'an already-progressive file is never rewritten again');
  }
  const sheet = await r.renderContactSheet(frames.map((f, i) => ({ image: f.bytes, caption: `2.0 s · scene ${i + 1}`, script: null })), 'Fixture');
  assert.equal(jpeg.decode(sheet.bytes).width, 1600);
});

test('a storyboard made before a brand-kit change cannot be rendered until it is saved again under the current kit', async () => {
  const s = await studioWithSet();
  await s.studio.createStoryboard(OWNER.userId, s.brandId, s.setId, 'c2', 'vertical', randomUUID(), false);
  const sb = (await view(s)).concepts[1]!.storyboards[0]!.version;
  await s.studio.saveKit(OWNER.userId, s.brandId, randomUUID(), { palette: { primary: '#1e3a8a', accent: '#fb7185', dark: '#0b1430', light: '#ffffff' }, disclosure: '', restricted: '', logo: { kind: 'keep' }, expectedVersion: 0 });
  await assert.rejects(s.studio.renderVideo(OWNER.userId, s.brandId, sb.id, randomUUID()), /changed since this storyboard was made/);
  assert.equal(s.renderer.videos, 0);
  const scenes = sb.variant.storyboard!.scenes.map((x) => ({ ...x, durationMs: x.durationMs + 500 }));
  await s.studio.editStoryboard(OWNER.userId, s.brandId, sb.id, randomUUID(), scenes);
  const sb2 = (await view(s)).concepts[1]!.storyboards[0]!.version;
  assert.equal(sb2.context.kitVersion, 1);
  assert.equal((await s.studio.renderVideo(OWNER.userId, s.brandId, sb2.id, randomUUID())).playable, true);
});

test('MP4 remux refuses anything outside the supported recorder shape instead of guessing', () => {
  assert.equal(remuxFragmentedMp4(Buffer.from('not a video at all')), null);
  assert.equal(remuxFragmentedMp4(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])), null, 'WebM');
  const box = (t: string, body: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(t, 4, 'latin1'); return Buffer.concat([h, body]); };
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isom'));
  assert.equal(remuxFragmentedMp4(Buffer.concat([ftyp, box('moov', Buffer.alloc(0)), box('mdat', Buffer.alloc(16))])), null, 'no fragments');
  assert.equal(remuxFragmentedMp4(Buffer.concat([ftyp, box('moov', Buffer.alloc(0)), box('moof', Buffer.alloc(0))]).subarray(0, 30)), null, 'truncated');
});
