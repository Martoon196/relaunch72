import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { imageCommandFromSource, imageIntentSha, type ImageSourceReceipt } from '../src/seo-blog/image-intent.js';
import { prepareImageGenerationRequest } from '../src/seo-blog/image-generation.js';
import type { ArticleVersion, BrandProfile, KnowledgeDocument } from '../src/seo-blog/types.js';

const BRAND = randomUUID(), ARTICLE = randomUUID(), OWNER = randomUUID(), VERSION = randomUUID();
const AT = '2026-11-03T12:00:00.000Z', SHA = 'a'.repeat(64);
function fixture() {
  const doc: KnowledgeDocument = { id: randomUUID(), brandId: BRAND, version: 1, category: 'visual_guidance', title: 'Visual direction', filename: 'visual.txt', format: 'txt', mime: 'text/plain', sizeBytes: 100,
    sha256: 'b'.repeat(64), blobId: randomUUID(), status: 'extracted', statusDetail: 'Read', text: 'Electric blue #3557ff and warm paper. Reference https://harbour.example/brand is guidance only.', pagesRead: 1, pagesTotal: 1, active: true, createdAt: AT };
  const profile: BrandProfile = { brandId: BRAND, version: 4, knowledge: [], summary: 'A practical property research brand.', audiences: ['Investors'], positioning: 'Considered decisions', offers: [], conversionPages: [],
    voice: { tone: ['Calm'], do: ['Use plain English'], dont: ['Invent results'], examples: [] }, approvedClaims: [], exclusions: [], conflicts: [], missingFacts: [], factsSha: SHA, source: 'owner_edited', confirmedAt: AT, confirmedBy: OWNER, createdAt: AT, generation: null };
  const version: ArticleVersion = { id: VERSION, articleId: ARTICLE, brandId: BRAND, number: 1, parentVersionId: null, change: 'generated', changedSectionId: null, createdAt: AT, createdBy: 'system',
    body: { title: 'A considered property decision', seoTitle: 'Property decisions', metaDescription: 'A practical way to consider the evidence before making a decision.', excerpt: 'Start with the question and examine the evidence.', slug: 'decisions', intro: 'Begin with a clear question.', sections: [{ id: randomUUID(), heading: 'Check the source', body: 'Look for the evidence.' }], conclusion: 'Take time to check.', cta: null, faqs: [], citations: [], image: { kind: 'none', url: null, alt: 'Editorial illustration of a considered decision', provenance: 'No image selected', width: null, height: null }, author: null },
    profileVersion: profile.version, factsSha: SHA, knowledge: [], briefId: randomUUID(), planId: randomUUID(), generation: null, contentSha: SHA };
  const source: ImageSourceReceipt = { recipe: 'seo-image-source-v1', workspaceId: BRAND, articleId: ARTICLE, articleVersionId: VERSION, articleContentSha256: SHA,
    sourceSha256: 'c'.repeat(64), profileSha256: 'd'.repeat(64), visualSha256: 'e'.repeat(64), snapshot: { brandName: 'Harbour', profile: structuredClone(profile), articleBody: structuredClone(version.body), knowledge: [{ id: doc.id, title: doc.title, version: doc.version, category: doc.category, sha256: doc.sha256, blobId: doc.blobId, status: doc.status, hasText: true, textSha256: createHash('sha256').update(doc.text!).digest('hex') }] } };
  return { source, version, profile, knowledge: [doc], sponsorUserId: OWNER };
}

test('image prompt binds actual article/profile/visual data, with text-only links and false documentary claims excluded', () => {
  const f = fixture(); const command = imageCommandFromSource(f);
  assert.equal(command.brandId, BRAND); assert.equal(command.actorId, OWNER);
  assert.match(command.prompt, /#3557ff/); assert.match(command.prompt, /Check the source/); assert.match(command.prompt, /Harbour/);
  assert.match(command.prompt, /clearly illustrative/); assert.match(command.prompt, /source DATA/);
  assert.doesNotMatch(command.prompt, /https?:\/\/|www\./u);
  const prepared = prepareImageGenerationRequest(command);
  f.knowledge[0] = { ...f.knowledge[0]!, text: 'Changed after preparation' };
  assert.equal(prepareImageGenerationRequest(command).requestSha256, prepared.requestSha256, 'already frozen command is not a mutable guidance reference');
});

test('changed text, profile, document set or article identity cannot be paired with an earlier SQL source receipt', () => {
  const f = fixture();
  assert.throws(() => imageCommandFromSource({ ...f, profile: { ...f.profile, summary: 'A changed claim' } }), /guidance changed/);
  assert.throws(() => imageCommandFromSource({ ...f, knowledge: [{ ...f.knowledge[0]!, text: 'Changed text without matching receipt' }] }), /guidance changed/);
  assert.throws(() => imageCommandFromSource({ ...f, knowledge: [{ ...f.knowledge[0]!, title: 'Changed visual title' }] }), /guidance changed/);
  assert.throws(() => imageCommandFromSource({ ...f, version: { ...f.version, body: { ...f.version.body, title: 'Different body under a claimed same SHA' } } }), /guidance changed/);
  assert.throws(() => imageCommandFromSource({ ...f, knowledge: [] }), /guidance changed/);
  assert.throws(() => imageCommandFromSource({ ...f, version: { ...f.version, id: randomUUID() } }), /guidance changed/);
  assert.throws(() => imageCommandFromSource({ ...f, source: { ...f.source, workspaceId: randomUUID() } }), /guidance changed/);
});

test('prompt uses only latest active guidance versions, matching the SQL recipe rather than resurrecting history', () => {
  const f = fixture(), doc = f.knowledge[0]!;
  const old = { ...doc, version: 0, text: 'OLD RETIRED VISUAL WORDS' };
  assert.doesNotMatch(imageCommandFromSource({ ...f, knowledge: [old, doc] }).prompt, /OLD RETIRED/);
  const retired = { ...doc, version: 2, active: false };
  const source = { ...f.source, snapshot: { ...f.source.snapshot, knowledge: [] } };
  const command = imageCommandFromSource({ ...f, source, knowledge: [old, doc, retired] });
  assert.doesNotMatch(command.prompt, /#3557ff|OLD RETIRED/); assert.match(command.prompt, /No text visual guidance/);
});

test('logical image intent binds policy/source/wire and distinct paid intent acknowledgement, without rehashing the SQL recipe', () => {
  const f = fixture(); const request = prepareImageGenerationRequest(imageCommandFromSource(f));
  const input = { commandId: randomUUID(), origin: 'owner' as const, sponsorUserId: OWNER, source: f.source, requestSha256: request.requestSha256, policyVersion: 1, policySha256: 'f'.repeat(64), confirmedNewIntent: false, replacesIntentId: null };
  const first = imageIntentSha(input);
  assert.equal(first, imageIntentSha(input));
  assert.notEqual(first, imageIntentSha({ ...input, policyVersion: 2 }));
  assert.notEqual(first, imageIntentSha({ ...input, source: { ...f.source, visualSha256: '1'.repeat(64) } }));
  assert.notEqual(first, imageIntentSha({ ...input, confirmedNewIntent: true, replacesIntentId: randomUUID() }));
  assert.notEqual(first, imageIntentSha({ ...input, commandId: randomUUID() }));
});
