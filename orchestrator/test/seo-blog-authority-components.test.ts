import test from 'node:test';
import assert from 'node:assert/strict';
import { queryAuthority, AUTHORITY_ENDPOINTS, AUTHORITY_LIMITS, AuthorityInputError } from '../src/seo-blog/authority-providers.js';
import { qualifyAuthorityProspect } from '../src/seo-blog/authority-qualification.js';
import type { LinkGapQuery, MentionQuery, AuthorityProspect, AuthorityEvidence } from '../src/seo-blog/authority-types.js';

const brandId = '10000000-0000-4000-8000-000000000001';
const secondBrand = '10000000-0000-4000-8000-000000000002';
const now = () => new Date('2026-11-02T03:00:00.000Z');
const gap: LinkGapQuery = { kind: 'link_gap', brandId, brandDomain: 'brand.example.com', competitors: ['other.example.com', 'second.example.com'], limit: 100 };
const mention: MentionQuery = { kind: 'indexed_mentions', brandId, brandDomain: 'brand.example.com', brandName: 'Brand Example', platform: 'google', locationCode: 2826, languageCode: 'en', since: '2026-10-01T00:00:00.000Z', until: '2026-11-02T03:00:00.000Z', match: { kind: 'domain_sources' }, limit: 100 };
const credentials = { login: 'test-account@example.com', password: 'private-test-password', now };
function answer(items: unknown[], extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ status_code: 20000, cost: 0.06, tasks_count: 1, tasks: [{ id: '11020000-0000-0000-test', status_code: 20000, cost: 0.06, result: [{ total_count: items.length, items_count: items.length, items, ...extra }] }] }), { headers: { 'content-type': 'application/json' } });
}
const gapItem = { domain_intersection: { '1': { target: 'publication.example.com', rank: 67, backlinks: 12, backlinks_spam_score: 2 }, '2': { target: 'publication.example.com', rank: 42, backlinks: 3 } } };
const mentionItem = { platform: 'google', model_name: 'google_ai_overview', location_code: 2826, language_code: 'en', question: 'How do I choose software?', answer: 'Brand Example has useful information.', first_response_at: '2026-10-01 00:00:00 +00:00', last_response_at: '2026-11-01 00:00:00 +00:00', sources: [{ url: 'https://brand.example.com/blog/guide', title: 'Guide', rank: 1 }], search_results: [] };
const reply = (response: () => Response | Promise<Response>): typeof fetch => async () => response();

test('link-gap uses exact bounded endpoint, one task, own-domain exclusion and no arbitrary filters or continuation', async () => {
  let calls = 0; const oldLogin = process.env.DATAFORSEO_LOGIN;
  const result = await queryAuthority(gap, { ...credentials, fetchImpl: async (url, init) => {
    calls++; assert.equal(url, AUTHORITY_ENDPOINTS.link_gap); assert.equal(init?.redirect, 'error'); assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('authorization'), `Basic ${Buffer.from(`${credentials.login}:${credentials.password}`).toString('base64')}`);
    assert.deepEqual(JSON.parse(String(init.body)), [{ targets: { '1': 'other.example.com', '2': 'second.example.com' }, exclude_targets: ['brand.example.com'], limit: 100, offset: 0, internal_list_limit: 10, include_subdomains: true, include_indirect_links: false, exclude_internal_backlinks: true, backlinks_status_type: 'live', intersection_mode: 'partial', rank_scale: 'one_hundred' }]);
    return answer([gapItem], { total_count: 240 });
  } });
  assert.equal(calls, 1); assert.equal(process.env.DATAFORSEO_LOGIN, oldLogin); assert.equal(result.outcome, 'results'); assert.equal(result.complete, false);
  assert.equal(result.reportedTotal, 240); assert.equal(result.items[0]!.sourcePageVerified, false); assert.equal(result.items[0]!.contactVerified, false);
  assert.equal(result.items[0]!.evidence[0]!.providerRank, 67); assert.equal(result.items[0]!.evidence[1]!.reportedSpamScore, null);
  assert.equal(Object.hasOwn(result.items[0]!, 'traffic'), false); assert.equal(result.receipt.reportedTaskCostUsd, 0.06);
  const logged = JSON.stringify(result); assert.equal(logged.includes(credentials.login), false); assert.equal(logged.includes(credentials.password), false);
});

test('indexed mentions use current endpoint, explicit market/date/source scope and evidence distinct from consumer results and traffic', async () => {
  let calls = 0;
  const result = await queryAuthority(mention, { ...credentials, fetchImpl: async (url, init) => {
    calls++; assert.equal(url, AUTHORITY_ENDPOINTS.indexed_mentions); assert.equal(String(url).includes('/search/live'), false);
    assert.deepEqual(JSON.parse(String(init?.body)), [{ target: [{ domain: 'brand.example.com', search_filter: 'include', search_scope: ['sources'], include_subdomains: true }], platform: 'google', location_code: 2826, language_code: 'en', offset: 0, limit: 100, filters: [['last_response_at', '>=', '2026-10-01 00:00:00 +00:00'], 'and', ['last_response_at', '<=', '2026-11-02 03:00:00 +00:00']] }]);
    return answer([mentionItem]);
  } });
  assert.equal(calls, 1); assert.equal(result.complete, true); const observed = result.items[0]!;
  assert.equal(observed.kind, 'supplier_indexed_mention'); assert.equal(observed.firstRecordedAt, '2026-10-01T00:00:00.000Z'); assert.equal(observed.retrievedAt, now().toISOString());
  assert.equal(observed.phraseInExcerpt, true); assert.equal(observed.brandInReportedSources, true); assert.equal(observed.brandInSearchResults, false);
  assert.equal(observed.consumerResultObserved, false); assert.equal(observed.referralTrafficMeasured, false); assert.equal(observed.reportedAiSearchVolume, null);
});

test('mentions, source references, unused search results and truncation never collapse into one visibility claim', async () => {
  const rows = [
    { ...mentionItem, question: 'Text only', sources: [], search_results: [{ url: 'https://brand.example.com/unused' }] },
    { ...mentionItem, question: 'Source only', answer: 'A different company is discussed.' },
    { ...mentionItem, question: 'Long answer', answer: 'x '.repeat(2500) + 'Brand Example', sources: null, search_results: null },
    { ...mentionItem, question: 'False phrase', answer: 'Brand Examplesomething is a different name.', sources: [] },
  ];
  const result = await queryAuthority(mention, { ...credentials, fetchImpl: reply(() => answer(rows, { total_count: 10, search_after_token: 'do-not-follow' })) });
  assert.equal(result.complete, false); assert.equal(result.items.length, 4);
  assert.equal(result.items[0]!.phraseInExcerpt, true); assert.equal(result.items[0]!.brandInReportedSources, false); assert.equal(result.items[0]!.brandInSearchResults, true);
  assert.equal(result.items[1]!.phraseInExcerpt, false); assert.equal(result.items[1]!.brandInReportedSources, true);
  assert.equal(result.items[2]!.excerptTruncated, true); assert.equal([...result.items[2]!.answerExcerpt!].length, 4000); assert.equal(result.items[2]!.phraseInExcerpt, null); assert.equal(result.items[2]!.brandInReportedSources, null);
  assert.equal(result.items[3]!.phraseInExcerpt, false);
});

test('same domain and supplier answer have stable brand-scoped identities', async () => {
  const first = await queryAuthority(gap, { ...credentials, fetchImpl: reply(() => answer([gapItem])) });
  const repeat = await queryAuthority(gap, { ...credentials, fetchImpl: reply(() => answer([gapItem])) });
  const other = await queryAuthority({ ...gap, brandId: secondBrand }, { ...credentials, fetchImpl: reply(() => answer([gapItem])) });
  assert.equal(first.items[0]!.id, repeat.items[0]!.id); assert.notEqual(first.items[0]!.id, other.items[0]!.id); assert.notEqual(first.receipt.inputSha256, other.receipt.inputSha256);
  const m1 = await queryAuthority(mention, { ...credentials, fetchImpl: reply(() => answer([mentionItem])) });
  const m2 = await queryAuthority({ ...mention, brandId: secondBrand }, { ...credentials, fetchImpl: reply(() => answer([mentionItem])) });
  assert.notEqual(m1.items[0]!.id, m2.items[0]!.id);
});

test('unconfigured, unsupported market, pre-abort and explicit empty results are distinct; invalid inputs make no request', async () => {
  let calls = 0; const fetchImpl = reply(() => { calls++; return answer([]); });
  assert.equal((await queryAuthority(gap, { now, fetchImpl })).outcome, 'unconfigured');
  assert.equal((await queryAuthority({ ...mention, platform: 'chat_gpt' }, { ...credentials, fetchImpl })).outcome, 'unsupported');
  const controller = new AbortController(); controller.abort();
  assert.equal((await queryAuthority(gap, { ...credentials, fetchImpl, signal: controller.signal })).outcome, 'not_started');
  for (const bad of [{ ...gap, limit: 101 }, { ...gap, competitors: ['www.other.example.com', 'other.example.com'] }, { ...gap, competitors: ['brand.example.com'] }, { ...gap, competitors: ['127.0.0.1'] }, { ...gap, competitors: ['http://private.local/path'] }]) await assert.rejects(queryAuthority(bad, { ...credentials, fetchImpl }), AuthorityInputError);
  assert.equal(calls, 0);
  const empty = await queryAuthority(gap, { ...credentials, fetchImpl }); assert.equal(empty.outcome, 'empty'); assert.equal(empty.reportedTotal, 0); assert.equal(empty.complete, true); assert.equal(calls, 1);
});

test('top-level and task rejections retain safe codes/cost, missing metrics remain unknown and malformed cost is held', async () => {
  for (const [rootCode, taskCode] of [[40100, 20000], [20000, 40204], [20000, 40101]]) {
    let calls = 0; const result = await queryAuthority(gap, { ...credentials, fetchImpl: reply(() => { calls++; return new Response(JSON.stringify({ status_code: rootCode, cost: 0.01, status_message: credentials.password, tasks: [{ id: 'safe-task', status_code: taskCode, cost: 0.01 }] }), { headers: { 'content-type': 'application/json' } }); }) });
    assert.equal(result.outcome, 'provider_rejected'); assert.equal(calls, 1); assert.equal(JSON.stringify(result).includes(credentials.password), false); assert.equal(result.receipt.reportedTotalCostUsd, 0.01);
  }
  const sparse = new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, result: [{ total_count: 0, items: [] }] }] }), { headers: { 'content-type': 'application/json' } });
  const missing = await queryAuthority(gap, { ...credentials, fetchImpl: reply(() => sparse) }); assert.equal(missing.receipt.reportedTotalCostUsd, null); assert.equal(missing.receipt.taskId, null);
  const bad = await queryAuthority(gap, { ...credentials, fetchImpl: reply(() => new Response('{"status_code":20000,"cost":-1}', { headers: { 'content-type': 'application/json' } })) }); assert.equal(bad.outcome, 'outcome_unknown'); assert.equal(bad.code, 'invalid_response');
});

test('stream byte cap handles missing/lying/excessive length; cancellation and total deadline never retry', async () => {
  for (const declared of [undefined, '1', String(AUTHORITY_LIMITS.responseBytes + 1)]) {
    let cancelled = false, calls = 0;
    const stream = new ReadableStream<Uint8Array>({ start(c) { if (declared !== String(AUTHORITY_LIMITS.responseBytes + 1)) c.enqueue(Buffer.alloc(AUTHORITY_LIMITS.responseBytes + 1)); }, cancel() { cancelled = true; } });
    const headers: Record<string, string> = { 'content-type': 'application/json' }; if (declared) headers['content-length'] = declared;
    const result = await queryAuthority(gap, { ...credentials, fetchImpl: reply(() => { calls++; return new Response(stream, { headers }); }) });
    assert.equal(result.outcome, 'outcome_unknown'); assert.equal(result.code, 'response_limit'); assert.equal(cancelled, true); assert.equal(calls, 1);
  }
  let calls = 0, cancelled = false;
  const result = await queryAuthority(gap, { ...credentials, timeoutMs: 10, fetchImpl: reply(() => { calls++; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }); }) });
  assert.equal(result.outcome, 'outcome_unknown'); assert.equal(result.code, 'transport_interrupted'); assert.equal(cancelled, true); assert.equal(calls, 1);
});

test('wrong market/date, private citation URLs and malformed structures are held without fetching any result URL', async () => {
  for (const row of [{ ...mentionItem, location_code: 2840 }, { ...mentionItem, last_response_at: '2025-01-01 00:00:00 +00:00' }, { ...mentionItem, sources: [{ url: 'http://127.0.0.1/private' }] }, { ...mentionItem, sources: [{ url: 'https://user:secret@example.com/' }] }]) {
    let calls = 0; const result = await queryAuthority(mention, { ...credentials, fetchImpl: reply(() => { calls++; return answer([row]); }) });
    assert.equal(result.outcome, 'outcome_unknown'); assert.equal(result.code, 'invalid_response'); assert.equal(calls, 1);
  }
});

const observed = <T>(value: T): Extract<AuthorityEvidence<T>, { state: 'observed' }> => ({ state: 'observed', value, sourceUrl: 'https://publication.example.com/about', observedAt: now().toISOString() });
const prospect: AuthorityProspect = { brandId, pageUrl: 'https://publication.example.com/resources', channel: 'editorial_outreach', topicalRelevance: observed(true), pageContextVerified: observed(true), monthlyVisits: observed(500), spamScore: observed(5), contactVerified: observed(true), paidOrExchangedLink: observed(false) };
const policy = { minimumMonthlyVisits: 100, maximumSpamScore: 30, maximumEvidenceAgeDays: 30 };

test('qualification preserves unknown/stale facts, explains selected policy and never treats provider rank as traffic', () => {
  const ready = qualifyAuthorityProspect(prospect, policy, now()); assert.equal(ready.status, 'review_ready'); assert.equal(ready.sendingAllowed, false);
  const unknown = qualifyAuthorityProspect({ ...prospect, monthlyVisits: { state: 'unknown' }, spamScore: { state: 'unknown' }, contactVerified: { state: 'unknown' } }, policy, now());
  assert.equal(unknown.status, 'needs_evidence'); assert.deepEqual(unknown.unknownFacts, ['monthly visits', 'spam score', 'verified contact']); assert.match(unknown.reasons.join(' '), /rank does not establish traffic/);
  const old = qualifyAuthorityProspect({ ...prospect, monthlyVisits: { ...observed(500), observedAt: '2026-01-01T00:00:00Z' } }, policy, now()); assert.equal(old.status, 'needs_evidence'); assert.ok(old.unknownFacts.includes('monthly visits'));
  const excluded = qualifyAuthorityProspect({ ...prospect, paidOrExchangedLink: observed(true) }, policy, now()); assert.equal(excluded.status, 'excluded');
  assert.notEqual(ready.id, qualifyAuthorityProspect({ ...prospect, brandId: secondBrand }, policy, now()).id);
});

test('Reddit and Quora stay community-held even when caller mislabels the channel and all other facts pass', () => {
  for (const pageUrl of ['https://www.reddit.com/r/property/comments/example', 'https://quora.com/A-property-question']) {
    const result = qualifyAuthorityProspect({ ...prospect, pageUrl }, policy, now()); assert.equal(result.status, 'community_hold'); assert.equal(result.sendingAllowed, false); assert.match(result.reasons.join(' '), /platform rules/);
  }
});

test('supplier request echoes are independently checked when supplied and cannot attach another query to this brand', async () => {
  for (const mismatch of [false, true]) {
    const result = await queryAuthority(gap, { ...credentials, fetchImpl: async (_url, init) => {
      const data = JSON.parse(String(init?.body))[0];
      if (mismatch) data.exclude_targets = ['unrelated.example.com'];
      const raw = { status_code: 20000, cost: 0.06, tasks: [{ id: 'echo-task', status_code: 20000, cost: 0.06, data: { function: 'domain_intersection', ...data }, result: [{ total_count: 1, items: [gapItem] }] }] };
      return new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } });
    } });
    assert.equal(result.outcome, mismatch ? 'outcome_unknown' : 'results'); assert.equal(result.receipt.requestEchoVerified, !mismatch);
    assert.equal(result.receipt.taskId, 'echo-task'); assert.equal(result.receipt.reportedTaskCostUsd, 0.06);
  }
});

test('bounded sources disclose incomplete evidence rather than turning an omitted brand reference into an absence', async () => {
  const sources = Array.from({ length: 26 }, (_, index) => ({ url: index === 25 ? 'https://brand.example.com/last' : `https://publication.example.com/page-${index}` }));
  const result = await queryAuthority(mention, { ...credentials, fetchImpl: reply(() => answer([{ ...mentionItem, sources }])) });
  assert.equal(result.items[0]!.sources.length, 25); assert.equal(result.items[0]!.sourcesTruncated, true); assert.equal(result.items[0]!.brandInReportedSources, null);
});

test('fetch deadline and caller interruption return uncertain paid outcome even if injected transport ignores cancellation', async () => {
  for (const callerAborts of [false, true]) {
    let calls = 0; const controller = new AbortController();
    const result = await queryAuthority(gap, { ...credentials, timeoutMs: 10, signal: controller.signal, fetchImpl: async () => {
      calls++; if (callerAborts) controller.abort(); return new Promise<Response>(() => undefined);
    } });
    assert.equal(result.outcome, 'outcome_unknown'); assert.equal(result.code, 'transport_interrupted'); assert.equal(calls, 1);
  }
});
