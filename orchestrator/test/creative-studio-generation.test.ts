/**
 * Typed-brief generation: brief rules, provider prompt boundaries, the reference (edits) transport and the worker's
 * safety order. All provider traffic here is an injected fake: nothing is sent, nothing is charged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import jpeg from 'jpeg-js';
import { canonicalCompanyContentJson } from '../src/company-content-pg/validation.js';
import {
  CREATIVE_BRIEF_RECIPE, CREATIVE_IMAGE_MODEL, CREATIVE_IMAGE_QUALITY, CREATIVE_IMAGE_SCHEMA, creativeImageCommand, decodeCreativeImageJob, holdMessage, validateBrief,
  type CreativeBriefSource, type CreativeImageIntent,
} from '../src/creative-studio/generation.js';
import { runCreativeImageJob, type CreativeImageWorkerDeps } from '../src/creative-studio/generation-worker.js';
import { generateImageCandidate, ImageGenerationInputError, prepareImageGenerationRequest, SEO_IMAGE_EDIT_ENDPOINT, SEO_IMAGE_REQUEST, type ImageGenerationReceipt } from '../src/seo-blog/image-generation.js';
import type { Job, KnowledgeDocument } from '../src/seo-blog/types.js';
import { fixtureBrand } from './rl72-method-fixtures.js';

const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const apiKey = 'image-test-key-for-injected-transport-only';
const jpegOf = (width: number, height: number) => Buffer.from(jpeg.encode({ width, height, data: Buffer.alloc(width * height * 4, 200) }, 70).data);
const okResponse = (bytes: Buffer) => new Response(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }), { headers: { 'content-type': 'application/json' } });

function visualDoc(brandId: string): KnowledgeDocument {
  const text = 'Natural daylight, muted sage and oak tones, uncluttered rooms. Call 0161 496 0000 or see https://hearth.example/style.';
  return { id: randomUUID(), brandId, version: 1, category: 'visual_guidance', title: 'Photo style', filename: null, format: null, mime: null, sizeBytes: text.length,
    sha256: sha(text), blobId: null, status: 'ready', statusDetail: 'Fixture.', text, active: true } as unknown as KnowledgeDocument;
}
function sourceFor(kind: 'home' | 'b2b', brief: Record<string, unknown>, docs: KnowledgeDocument[] = []) {
  const f = fixtureBrand(kind);
  const snapshot = { recipe: CREATIVE_BRIEF_RECIPE, brandName: f.brand.name, profile: JSON.parse(canonicalCompanyContentJson(f.profile)), briefId: randomUUID(), briefVersion: 1, brief,
    knowledge: docs.map((d) => ({ id: d.id, version: d.version, category: d.category, sha256: d.sha256, textSha256: sha(d.text ?? '') })) };
  const source: CreativeBriefSource = { recipe: CREATIVE_BRIEF_RECIPE, workspaceId: f.brand.id, briefId: snapshot.briefId, briefVersion: 1,
    sourceSha256: sha('source'), profileSha256: sha('profile'), visualSha256: sha('visual'), snapshot };
  return { f, source };
}

test('a brief describes a picture only: normalised, bounded, no links or contacts, documented sizes, up to three own references', () => {
  const ok = validateBrief({ text: '  A bright   modern kitchen\r\nin morning light ', size: '1024x1536', references: [] });
  assert.equal(ok.text, 'A bright modern kitchen\nin morning light'); assert.equal(ok.title, ok.text.slice(0, 60)); assert.equal(ok.useVisualGuidance, false);
  for (const bad of [{ text: 'too short', size: '1024x1024' }, { text: 'Kitchen photo from https://example.com', size: '1024x1024' }, { text: 'Email me at owner@example.com please', size: '1024x1024' },
    { text: 'A bright modern kitchen interior', size: '2048x2048' }, { text: 'A bright modern kitchen interior', size: '1024x1024', references: [{ assetId: 'x', sha256: 'y' }] },
    { text: 'A bright modern kitchen interior', size: '1024x1024', references: Array.from({ length: 4 }, () => ({ assetId: randomUUID(), sha256: sha(randomUUID()) })) }])
    assert.throws(() => validateBrief(bad), /characters|links|size|references/u);
  const ref = { assetId: randomUUID(), sha256: sha('r') };
  assert.equal(validateBrief({ text: 'A bright modern kitchen interior', size: '1024x1024', references: [ref, ref] }).references.length, 1, 'duplicate references collapse');
});

test('the provider prompt carries the picture brief and brand tone, never offers, prices, claims, contacts or pages; text in the picture is forbidden', () => {
  const doc = visualDoc('00000000-0000-4000-8000-000000000000');
  const { f, source } = sourceFor('home', { text: 'A modern kitchen background with morning light. Phone 07700 900123 for details.', size: '1536x1024', references: [], useVisualGuidance: true });
  const d = { ...doc, brandId: f.brand.id } as KnowledgeDocument;
  (source.snapshot as { knowledge: unknown }).knowledge = [{ id: d.id, version: 1, category: d.category, sha256: d.sha256, textSha256: sha(d.text ?? '') }];
  const command = creativeImageCommand({ source, profile: f.profile, knowledge: [d], sponsorUserId: f.profile.confirmedBy! });
  const p = command.prompt;
  assert.match(p, /<image_brief>.*modern kitchen background/u);
  assert.match(p, /Do not draw any words, letters, numbers, prices, logos/u);
  assert.match(p, /testimonials, reviews, ratings/u);
  assert.match(p, /<visual_data>.*muted sage/u, 'chosen visual guidance is included');
  for (const leaked of ['07700 900123', '0161 496 0000', 'https://hearth.example', f.profile.offers[0]!.name, f.profile.approvedClaims[0]!, f.profile.conversionPages[0]!.label, f.profile.audiences[0]!])
    assert.equal(p.includes(leaked), false, `prompt must not include ${leaked}`);
  assert.equal(command.brandId, f.brand.id); assert.equal(command.actorId, f.profile.confirmedBy);

  const plain = sourceFor('home', { text: 'A modern kitchen background with morning light.', size: '1536x1024', references: [], useVisualGuidance: false });
  assert.equal(creativeImageCommand({ source: plain.source, profile: plain.f.profile, knowledge: [], sponsorUserId: plain.f.profile.confirmedBy! }).prompt.includes('<visual_data>'), false);
  // A profile that is not the exact snapshot (changed facts, other brand) is refused before any request is formed.
  assert.throws(() => creativeImageCommand({ source: plain.source, profile: { ...plain.f.profile, summary: 'Edited later' }, knowledge: [], sponsorUserId: plain.f.profile.confirmedBy! }), /changed/u);
  assert.throws(() => creativeImageCommand({ source: plain.source, profile: fixtureBrand('b2b').profile, knowledge: [], sponsorUserId: plain.f.profile.confirmedBy! }), /changed/u);
  // A visual document that changed after the source snapshot is refused.
  assert.throws(() => creativeImageCommand({ source, profile: f.profile, knowledge: [{ ...d, version: 2 } as KnowledgeDocument], sponsorUserId: f.profile.confirmedBy! }), /changed/u);
});

test('transport: the article body is unchanged; a size option and reference images use the documented parameters and the edits endpoint', async () => {
  const command = { brandId: randomUUID(), actorId: randomUUID(), prompt: 'A calm kitchen scene, editorial photograph.' };
  const article = prepareImageGenerationRequest(command);
  const { endpoint: _e, ...params } = SEO_IMAGE_REQUEST;
  assert.deepEqual(JSON.parse(article.body), { ...params, prompt: command.prompt, safety_identifier: sha(`${command.brandId}:${command.actorId}`) }, 'article request byte-compatible');
  assert.equal(prepareImageGenerationRequest(command, {}).requestSha256, article.requestSha256);
  const portrait = prepareImageGenerationRequest(command, { size: '1024x1536' });
  assert.equal(JSON.parse(portrait.body).size, '1024x1536'); assert.notEqual(portrait.requestSha256, article.requestSha256);

  const ref = jpegOf(16, 16), refSha = sha(ref);
  const identity = prepareImageGenerationRequest(command, { size: '1024x1024', referenceDigests: [refSha] });
  assert.equal(identity.endpoint, SEO_IMAGE_EDIT_ENDPOINT);
  let seen: { url: string; contentType: string | null; parts: [string, unknown][] } | null = null;
  const out = jpegOf(32, 32);
  const receipt = await generateImageCandidate(command, { apiKey, fetchImpl: (async (url: string, init: RequestInit) => {
    seen = { url, contentType: new Headers(init.headers).get('content-type'), parts: [...(init.body as FormData).entries()] };
    return okResponse(out);
  }) as unknown as typeof fetch }, { size: '1024x1024', references: [{ sha256: refSha, mimeType: 'image/jpeg', bytes: ref }] });
  assert.equal(receipt.outcome, 'candidate_received');
  assert.equal(receipt.requestSha256, identity.requestSha256, 'owner-time identity (digests) equals worker-time identity (bytes)');
  assert.equal(seen!.url, SEO_IMAGE_EDIT_ENDPOINT); assert.equal(seen!.contentType, null, 'fetch sets the multipart boundary');
  const fields = Object.fromEntries(seen!.parts.filter(([k]) => k !== 'image[]').map(([k, v]) => [k, String(v)]));
  assert.deepEqual(fields, { model: CREATIVE_IMAGE_MODEL, prompt: command.prompt, n: '1', size: '1024x1024', quality: CREATIVE_IMAGE_QUALITY, output_format: 'jpeg', output_compression: '85', background: 'opaque' });
  const images = seen!.parts.filter(([k]) => k === 'image[]');
  assert.equal(images.length, 1);
  assert.equal(sha(Buffer.from(await (images[0]![1] as Blob).arrayBuffer())), refSha, 'the exact authorised bytes');

  let calls = 0;
  await assert.rejects(generateImageCandidate(command, { apiKey, fetchImpl: (async () => { calls++; return okResponse(out); }) as unknown as typeof fetch },
    { references: [{ sha256: sha('different'), mimeType: 'image/jpeg', bytes: ref }] }), ImageGenerationInputError);
  assert.throws(() => prepareImageGenerationRequest(command, { referenceDigests: Array.from({ length: 4 }, (_, i) => sha(String(i))) }), ImageGenerationInputError);
  assert.equal(calls, 0, 'mismatched or excess references never reach the provider');
});

test('transport: a documented content-policy refusal is recognised only when asked, and its text is never kept', async () => {
  const command = { brandId: randomUUID(), actorId: randomUUID(), prompt: 'A calm kitchen scene, editorial photograph.' };
  const refuse = (async () => new Response(JSON.stringify({ error: { code: 'moderation_blocked', message: 'secret provider wording' } }), { status: 400, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const classified = await generateImageCandidate(command, { apiKey, fetchImpl: refuse }, { classifyRefusal: true });
  assert.equal(classified.outcome, 'rejected'); assert.equal(classified.refusal, 'moderation_blocked');
  assert.equal(JSON.stringify(classified).includes('secret provider wording'), false);
  const plain = await generateImageCandidate(command, { apiKey, fetchImpl: refuse });
  assert.equal(plain.outcome, 'rejected'); assert.equal(plain.refusal, undefined, 'article path behaviour unchanged');
});

// ---- worker coordinator with fakes -------------------------------------------------------------------------------

function makeJob(opts: { references?: { assetId: string; sha256: string }[]; size?: '1024x1024' | '1536x1024' } = {}): Job {
  const brandId = randomUUID(), sponsor = randomUUID(), id = randomUUID(), size = opts.size ?? '1024x1024', refs = opts.references ?? [];
  const privateCommand = { brandId, actorId: sponsor, prompt: 'Create one picture. <image_brief>{"brief":"A kitchen"}</image_brief>' };
  const prepared = prepareImageGenerationRequest(privateCommand, { size, referenceDigests: refs.map((r) => r.sha256) });
  const source: CreativeBriefSource = { recipe: CREATIVE_BRIEF_RECIPE, workspaceId: brandId, briefId: randomUUID(), briefVersion: 1, sourceSha256: sha('s'), profileSha256: sha('p'), visualSha256: sha('v'), snapshot: {} };
  const image: CreativeImageIntent = { schema: CREATIVE_IMAGE_SCHEMA, sourceSnapshotVersion: CREATIVE_BRIEF_RECIPE, commandId: id, jobId: id, intentId: id, intentSha256: sha('i'),
    requestSha256: prepared.requestSha256, sourceSha256: source.sourceSha256, profileSha256: source.profileSha256, visualSha256: source.visualSha256,
    briefId: source.briefId, briefVersion: 1, sponsorUserId: sponsor, size, referenceSha256s: refs.map((r) => r.sha256), references: refs, model: CREATIVE_IMAGE_MODEL, quality: CREATIVE_IMAGE_QUALITY,
    expectedPolicyVersion: 1, expectedPolicySha256: sha('policy'), confirmedNewIntent: false, replacesIntentId: null, source, privateCommand };
  const now = new Date().toISOString();
  return { id, brandId, kind: 'write', idempotencyKey: `creative-image:${id}`, payload: { stage: 'image', image }, state: 'running', attempts: 1, maxAttempts: 3,
    leaseOwner: 'w1', leaseExpiresAt: now, runAfter: now, progress: '', error: null, createdAt: now, updatedAt: now, rowVersion: 1 };
}
type Decision = Awaited<ReturnType<CreativeImageWorkerDeps['generation']['commitReserve']>>;
function harness(job: Job, o: { decision?: Decision; receiptFailures?: number; refFails?: boolean; out?: Buffer; outcome?: ImageGenerationReceipt['outcome'] } = {}) {
  let row = job; const log: string[] = []; let receiptFailures = o.receiptFailures ?? 0;
  const out = o.out ?? jpegOf(1024, 1024), asset = { id: randomUUID(), sha256: sha(out) };
  const deps: CreativeImageWorkerDeps = {
    store: { getJob: async () => row, updateJob: async (j: Job) => { row = { ...j, rowVersion: row.rowVersion + 1 }; log.push(`update:${j.state}`); return row; } } as unknown as CreativeImageWorkerDeps['store'],
    generation: {
      commitReserve: async () => { log.push('reserve'); return o.decision ?? ({ kind: 'admitted', attemptId: randomUUID(), nonce: randomUUID(), policy: {} } as unknown as Decision); },
      recordGeneration: (async (_i: unknown, complete: (t: null, j: Job, g: string) => Promise<Job>) => { log.push('record'); return { recorded: true, value: await complete(null, row, randomUUID()) }; }) as unknown as CreativeImageWorkerDeps['generation']['recordGeneration'],
    },
    media: {
      commitImageAttemptReceipt: async (e) => { log.push('receipt'); if (receiptFailures-- > 0) throw new Error('db down'); return { attemptId: e.attemptId, nonce: e.nonce, candidate: e.candidate ? { id: asset.id, sha256: asset.sha256 } : null, receipt: {}, applyEligible: false, hold: null } as never; },
      loadPrivateAsset: async (_ws, id) => { log.push(`load:${id === asset.id ? 'candidate' : 'reference'}`); if (o.refFails && id !== asset.id) throw new Error('withdrawn'); return { asset: {} as never, bytes: id === asset.id ? out : jpegOf(8, 8) }; },
    },
    providerConfigured: true,
    generate: async () => { log.push('provider'); const outcome = o.outcome ?? 'candidate_received';
      return { outcome, code: outcome === 'candidate_received' ? 'ok' : 'transport_interrupted', requestSha256: (job.payload.image as CreativeImageIntent).requestSha256, providerRequestIdSha256: null, httpStatus: 200,
        usage: null, candidate: outcome === 'candidate_received' ? Object.assign({ sha256: asset.sha256, mimeType: 'image/jpeg', byteLength: out.length, requestedSize: '1024x1024', validation: 'candidate_only' }, { bytes: out }) : null } as unknown as ImageGenerationReceipt; },
    now: () => new Date().toISOString(),
  };
  return { deps, log, row: () => row };
}
const resultCode = (j: Job) => ((j.payload.image as Record<string, unknown>).result as Record<string, unknown>).code;

test('worker: one admission, exactly one provider call, receipt before decode, record and done', async () => {
  const h = harness(makeJob());
  const done = await runCreativeImageJob(h.row(), h.deps);
  assert.equal(done.state, 'done', done.error ?? '');
  assert.deepEqual(h.log, ['reserve', 'provider', 'receipt', 'load:candidate', 'record', 'update:done']);
  assert.equal(((done.payload.image as Record<string, unknown>).result as Record<string, unknown>).transportCalls, 1);
});

test('worker: an unavailable reference stops before any reservation or charge', async () => {
  const ref = { assetId: randomUUID(), sha256: sha('ref') };
  const h = harness(makeJob({ references: [ref] }), { refFails: true });
  const held = await runCreativeImageJob(h.row(), h.deps);
  assert.equal(held.state, 'blocked'); assert.equal(resultCode(held), 'source_changed');
  assert.deepEqual(h.log, ['load:reference', 'update:blocked']);
});

test('worker: holds never call the provider; only the shared concurrency hold is retried later', async () => {
  for (const [reason, state] of [['global_concurrency', 'queued'], ['studio_image_allowance', 'blocked'], ['brand_image_allowance', 'blocked'], ['operator_policy_changed', 'blocked']] as const) {
    const h = harness(makeJob(), { decision: { kind: 'held', reason } as Decision });
    const r = await runCreativeImageJob(h.row(), h.deps);
    assert.equal(r.state, state, reason); assert.equal(resultCode(r), reason); assert.equal(h.log.includes('provider'), false);
    assert.equal(r.error === null, state === 'queued'); assert.match(r.progress, /Nothing (was|new)|charged/u);
  }
});

test('worker: an existing started attempt (unknown outcome) is held for reconciliation and never re-sent', async () => {
  const h = harness(makeJob(), { decision: { kind: 'existing_started', attemptId: randomUUID(), nonce: randomUUID(), reason: 'outcome_unknown' } as Decision });
  const r = await runCreativeImageJob(h.row(), h.deps);
  assert.equal(r.state, 'blocked'); assert.equal(resultCode(r), 'outcome_unknown'); assert.deepEqual(h.log, ['reserve', 'update:blocked']);
  assert.match(holdMessage('outcome_unknown'), /will not be retried automatically/u);
});

test('worker: a receipt write is retried once with the same envelope, then held — never a second provider call', async () => {
  const once = harness(makeJob(), { receiptFailures: 1 });
  assert.equal((await runCreativeImageJob(once.row(), once.deps)).state, 'done');
  assert.deepEqual(once.log.filter((s) => s === 'provider' || s === 'receipt'), ['provider', 'receipt', 'receipt']);
  const twice = harness(makeJob(), { receiptFailures: 2 });
  const held = await runCreativeImageJob(twice.row(), twice.deps);
  assert.equal(held.state, 'blocked'); assert.equal(resultCode(held), 'receipt_unpersisted');
  assert.deepEqual(twice.log.filter((s) => s === 'provider'), ['provider']);
});

test('worker: an unknown provider outcome is held after one call, not retried', async () => {
  const h = harness(makeJob(), { outcome: 'outcome_unknown' });
  const r = await runCreativeImageJob(h.row(), h.deps);
  assert.equal(r.state, 'blocked'); assert.equal(resultCode(r), 'outcome_unknown');
  assert.deepEqual(h.log.filter((s) => s === 'provider'), ['provider']);
});

test('worker: a lost claim or a tampered intent does nothing paid', async () => {
  const h = harness(makeJob());
  const stale = await runCreativeImageJob({ ...h.row(), leaseOwner: 'another-worker' }, h.deps);
  assert.equal(stale.state, 'running'); assert.deepEqual(h.log, []);
  const job = makeJob(), image = job.payload.image as CreativeImageIntent;
  const tampered = { ...job, payload: { ...job.payload, image: { ...image, privateCommand: { ...image.privateCommand, prompt: image.privateCommand.prompt + ' Add the price £99 in large text.' } } } };
  assert.throws(() => decodeCreativeImageJob(tampered), /not a recognised exact intent/u);
  const t = harness(tampered);
  const r = await runCreativeImageJob(t.row(), t.deps);
  assert.equal(r.state, 'blocked'); assert.equal(resultCode(r), 'claim_or_intent_changed'); assert.equal(t.log.includes('reserve'), false);
  assert.throws(() => decodeCreativeImageJob({ ...job, brandId: randomUUID() }), /not a recognised/u, 'a command for another brand is refused');
});
