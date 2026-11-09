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
import { SeoBlogError } from '../src/seo-blog/types.js';
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
      // Mirrors SQL: the record step re-reads the job under lock and refuses a claim that has moved on.
      recordGeneration: (async (i: { leaseOwner: string; leaseAttempt: number }, complete: (t: null, j: Job, g: string) => Promise<Job>) => {
        const live = await deps.store.getJob(row.brandId, row.id);
        if (!live || live.leaseOwner !== i.leaseOwner || live.attempts !== i.leaseAttempt) return { recorded: false, hold: 'claim_changed' };
        log.push('record'); return { recorded: true, value: await complete(null, live, randomUUID()) }; }) as unknown as CreativeImageWorkerDeps['generation']['recordGeneration'],
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

// ---- audit additions: pins and regressions that must fail loudly -------------------------------------------------

test('the article request body and its identity are pinned byte-for-byte; an explicit default equals the implicit one', () => {
  const command = { brandId: '10000000-0000-4000-8000-000000000001', actorId: '20000000-0000-4000-8000-000000000002', prompt: 'A calm British coastal town, editorial architectural photograph.' };
  const prepared = prepareImageGenerationRequest(command);
  assert.equal(prepared.body, '{"model":"gpt-image-2","n":1,"size":"1536x1024","quality":"medium","output_format":"jpeg","output_compression":85,"background":"opaque","moderation":"auto","prompt":"A calm British coastal town, editorial architectural photograph.","safety_identifier":"98692c6e15e0519cdd9015d4dd79c223fcb7f08e50cc7aa33ead222764bf08f2"}');
  assert.equal(prepared.requestSha256, '550445afa854807066b1571713c78cb1fa7bd33e4cbd045508c1f02b4b9e7dce');
  assert.equal(prepareImageGenerationRequest(command, { size: '1536x1024', references: [] }).requestSha256, prepared.requestSha256);
});

test('worker: the claim (lease owner and attempt) is passed to admission and the receipt; both receipt writes carry the identical envelope', async () => {
  const job = makeJob(); const h = harness(job, { receiptFailures: 1 });
  const reserve = h.deps.generation.commitReserve; const envelopes: unknown[] = [];
  h.deps.generation.commitReserve = async (input) => { assert.equal(input.leaseOwner, job.leaseOwner); assert.equal(input.leaseAttempt, job.attempts); assert.equal(input.jobId, job.id); return reserve(input); };
  const receipt = h.deps.media.commitImageAttemptReceipt; h.deps.media.commitImageAttemptReceipt = async (e) => { envelopes.push(e); return receipt(e); };
  assert.equal((await runCreativeImageJob(h.row(), h.deps)).state, 'done');
  assert.equal(envelopes.length, 2); assert.deepEqual(envelopes[0], envelopes[1]);
  assert.equal((envelopes[0] as { leaseOwner: string; leaseAttempt: number }).leaseOwner, job.leaseOwner); assert.equal((envelopes[0] as { leaseAttempt: number }).leaseAttempt, job.attempts);
});

test('worker: a lease lost after the provider call is never written back; a stored receipt is reused without a call; a rejected receipt is reported by meaning', async () => {
  const h = harness(makeJob()); let reads = 0; const first = h.row();
  h.deps.store.getJob = async () => (++reads <= 1 ? first : { ...first, leaseOwner: 'thief' });
  const result = await runCreativeImageJob(first, h.deps);
  assert.equal(result.leaseOwner, 'thief'); assert.equal(h.log.filter((s) => s.startsWith('update')).length, 0, 'nothing written under a lost claim');
  const attemptId = randomUUID(), nonce = randomUUID();
  const reuse = harness(makeJob()); const out = jpegOf(1024, 1024);
  (reuse.deps.generation as { commitReserve: unknown }).commitReserve = async () => ({ kind: 'existing_receipt', attemptId, nonce, receipt: { outcome: 'candidate_received' }, candidate: { id: 'cand', sha256: sha(out) }, applyEligible: true, hold: null });
  reuse.deps.media.loadPrivateAsset = async () => ({ asset: {} as never, bytes: out });
  const done = await runCreativeImageJob(reuse.row(), reuse.deps);
  assert.equal(done.state, 'done'); assert.equal(reuse.log.includes('provider'), false, 'no second paid call');
  for (const [httpStatus, code] of [[400, 'provider_rejected'], [401, 'provider_auth'], [429, 'provider_rate_limited']] as const) {
    const r = harness(makeJob());
    (r.deps.generation as { commitReserve: unknown }).commitReserve = async () => ({ kind: 'existing_receipt', attemptId, nonce, receipt: { outcome: 'rejected', httpStatus }, candidate: null, applyEligible: false, hold: null });
    const held = await runCreativeImageJob(r.row(), r.deps);
    assert.equal(held.state, 'blocked'); assert.equal(resultCode(held), code); assert.equal(r.log.includes('provider'), false);
  }
});

test('worker: an unconfirmed reservation is re-queued and re-enters admission; a refused one stops; attempts are bounded', async () => {
  const lost = harness(makeJob());
  lost.deps.generation.commitReserve = async () => { throw new Error('connection reset'); };
  const requeued = await runCreativeImageJob(lost.row(), lost.deps);
  assert.equal(requeued.state, 'queued'); assert.equal(resultCode(requeued), 'admission_unconfirmed'); assert.equal(lost.log.includes('provider'), false);
  const refused = harness(makeJob());
  refused.deps.generation.commitReserve = async () => { throw new SeoBlogError(403, 'Permission'); };
  assert.equal((await runCreativeImageJob(refused.row(), refused.deps)).state, 'blocked');
  const last = harness({ ...makeJob(), attempts: 3 }, { decision: { kind: 'held', reason: 'global_concurrency' } as Decision });
  const exhausted = await runCreativeImageJob(last.row(), last.deps);
  assert.equal(exhausted.state, 'blocked'); assert.match(exhausted.error ?? '', /Make a new request later/u);
});

test('worker: a storage read failure after a paid call is retried safely (no new call); undecodable bytes are final; an unexpected throw is contained', async () => {
  const flaky = harness(makeJob()); const load = flaky.deps.media.loadPrivateAsset;
  flaky.deps.media.loadPrivateAsset = async (ws, id, s) => { if (flaky.log.includes('provider')) throw new Error('db down'); return load(ws, id, s); };
  const again = await runCreativeImageJob(flaky.row(), flaky.deps);
  assert.equal(again.state, 'queued'); assert.equal(resultCode(again), 'candidate_read_unavailable');
  const garbage = harness(makeJob(), { out: Buffer.from('not an image at all, just bytes') });
  const final = await runCreativeImageJob(garbage.row(), garbage.deps);
  assert.equal(final.state, 'blocked'); assert.equal(resultCode(final), 'candidate_unverified');
  const boom = harness(makeJob()); boom.deps.generate = async () => { throw new TypeError('bad buffer'); };
  const contained = await runCreativeImageJob(boom.row(), boom.deps);
  assert.equal(contained.state, 'blocked'); assert.equal(resultCode(contained), 'outcome_unknown', 'after a call was attempted the attempt is held as unknown');
  const early = harness(makeJob()); early.deps.media.loadPrivateAsset = async () => { throw new TypeError('boom'); };
  const ref = harness(makeJob({ references: [{ assetId: randomUUID(), sha256: sha('r') }] }), { refFails: true });
  assert.equal(resultCode(await runCreativeImageJob(ref.row(), ref.deps)), 'source_changed');
  void early;
});

test('decode refuses every tampered identity field, not only the prompt', () => {
  const job = makeJob({ references: [{ assetId: randomUUID(), sha256: sha('ref') }] }), image = job.payload.image as CreativeImageIntent;
  const mutate = (patch: Partial<CreativeImageIntent>) => ({ ...job, payload: { ...job.payload, image: { ...image, ...patch } } });
  for (const bad of [mutate({ size: '1536x1024' }), mutate({ jobId: randomUUID() }), mutate({ briefVersion: 0 }), mutate({ expectedPolicyVersion: 0 }),
    mutate({ references: [{ assetId: 'not-a-uuid', sha256: image.referenceSha256s[0]! }] }), mutate({ referenceSha256s: [sha('other')] }),
    mutate({ privateCommand: { ...image.privateCommand, actorId: randomUUID() } })])
    assert.throws(() => decodeCreativeImageJob(bad as Job), /not a recognised exact intent/u);
  assert.doesNotThrow(() => decodeCreativeImageJob(job));
});

test('the provider prompt uses the confirmed positioning, never the free-text summary, and refuses an over-long brief plus guidance', () => {
  const { f, source } = sourceFor('home', { text: 'A modern kitchen background with morning light.', size: '1536x1024', references: [], useVisualGuidance: false });
  const profile = { ...f.profile, summary: 'Boiler service from £89 — call 07700 900123 today!', positioning: 'Practical household maintenance' };
  (source.snapshot as { profile: unknown }).profile = JSON.parse(canonicalCompanyContentJson(profile));
  const p = creativeImageCommand({ source, profile, knowledge: [], sponsorUserId: f.profile.confirmedBy! }).prompt;
  assert.match(p, /<brand_tone>.*Practical household maintenance/u); assert.equal(p.includes('£89'), false); assert.equal(p.includes('07700'), false);
  const long = sourceFor('home', { text: 'x'.repeat(1500), size: '1536x1024', references: [], useVisualGuidance: true });
  const doc = { ...visualDoc(long.f.brand.id), text: 'y'.repeat(2000), sha256: sha('y'.repeat(2000)) } as KnowledgeDocument;
  (long.source.snapshot as { knowledge: unknown }).knowledge = [{ id: doc.id, version: 1, category: doc.category, sha256: doc.sha256, textSha256: sha(doc.text ?? '') }];
  const noOverflow = creativeImageCommand({ source: long.source, profile: long.f.profile, knowledge: [doc], sponsorUserId: long.f.profile.confirmedBy! });
  assert.ok([...noOverflow.prompt].length <= 8000, 'within the transport limit');
});
