import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DataForSeoLabsProvider, configuredKeywordResearchProvider, marketForLocale, requestDomain, requestPhrase,
  latestMonth, supplierTime,
} from '../src/keyword/dataforseo-labs.js';

// Fixtures are the supplier documentation's own example responses; each file names its page in `_fixture_source`.
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/dataforseo-labs/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;

type Call = { url: string; method: string; body: unknown; auth: string | null };
function transport(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = { url: String(url), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.get('authorization') };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const UK = marketForLocale('en-GB');

test('UK market is location 2826 and language en; unknown locales fall back to the UK', () => {
  assert.deepEqual(UK, { locationCode: 2826, languageCode: 'en' });
  assert.deepEqual(marketForLocale('en-US'), { locationCode: 2840, languageCode: 'en' });
  assert.deepEqual(marketForLocale('xx-YY'), { locationCode: 2826, languageCode: 'xx' });
});

test('every request body is exactly the documented shape, one task per POST, sent to the documented path', async () => {
  const { calls, fetchImpl } = transport(() => json({ status_code: 20000, cost: 0.012, tasks: [{ id: 'task-12345678', status_code: 20000, cost: 0.012, result: [{ items: [] }] }] }));
  const p = new DataForSeoLabsProvider('fixture-login', 'fixture-password', fetchImpl);
  await p.keywordIdeas(['Letting Agent', 'letting agent', ' landlord  advice '], UK);
  await p.keywordSuggestions('Letting agent fees', UK, { limit: 50 });
  await p.relatedKeywords('letting agent fees', UK);
  await p.keywordsForSite('https://www.example.co.uk/about', UK);
  await p.rankedKeywords('example.co.uk', UK);
  await p.rankedKeywords('www.rival.co.uk', UK, { competitor: true, limit: 150 });
  await p.competitorDomains('example.co.uk', UK);
  await p.keywordOverview(['letting agent fees', 'LETTING AGENT FEES', 'hmo licence'], UK);
  await p.bulkKeywordDifficulty(['letting agent fees'], UK);
  await p.searchIntent(['letting agent fees'], UK);
  const base = 'https://api.dataforseo.com/v3/dataforseo_labs/google/';
  assert.deepEqual(calls.map((c) => [c.method, c.url.replace(base, '')]), [
    ['POST', 'keyword_ideas/live'], ['POST', 'keyword_suggestions/live'], ['POST', 'related_keywords/live'],
    ['POST', 'keywords_for_site/live'], ['POST', 'ranked_keywords/live'], ['POST', 'ranked_keywords/live'],
    ['POST', 'competitors_domain/live'], ['POST', 'keyword_overview/live'], ['POST', 'bulk_keyword_difficulty/live'], ['POST', 'search_intent/live'],
  ]);
  const loc = { location_code: 2826, language_code: 'en' };
  assert.deepEqual(calls.map((c) => c.body), [
    [{ keywords: ['letting agent', 'landlord advice'], ...loc, limit: 300 }],
    [{ keyword: 'letting agent fees', ...loc, include_seed_keyword: true, limit: 50 }],
    [{ keyword: 'letting agent fees', ...loc, depth: 1, limit: 100 }],
    [{ target: 'example.co.uk', ...loc, limit: 200 }],
    [{ target: 'example.co.uk', ...loc, item_types: ['organic'], limit: 200, order_by: ['keyword_data.keyword_info.search_volume,desc'] }],
    [{ target: 'rival.co.uk', ...loc, item_types: ['organic'], limit: 150, order_by: ['keyword_data.keyword_info.search_volume,desc'] }],
    [{ target: 'example.co.uk', ...loc, exclude_top_domains: true, limit: 10 }],
    [{ keywords: ['letting agent fees', 'hmo licence'], ...loc }],
    [{ keywords: ['letting agent fees'], ...loc }],
    [{ keywords: ['letting agent fees'] }],
  ]);
  assert.ok(calls.every((c) => c.auth === `Basic ${Buffer.from('fixture-login:fixture-password').toString('base64')}`));
});

test('documented limits are enforced before sending: 200 seeds, 700 overview phrases, 1000 rows, 80 chars / 10 words', async () => {
  const { calls, fetchImpl } = transport(() => json({ status_code: 20000, tasks: [{ id: 'task-12345678', status_code: 20000, result: [{ items: [] }] }] }));
  const p = new DataForSeoLabsProvider('l', 'p', fetchImpl);
  await p.keywordIdeas(Array.from({ length: 250 }, (_, i) => `seed ${i}`), UK, { limit: 5000 });
  await p.keywordOverview(Array.from({ length: 800 }, (_, i) => `phrase ${i}`), UK);
  assert.equal((calls[0]!.body as { keywords: string[] }[])[0]!.keywords.length, 200);
  assert.equal((calls[0]!.body as { limit: number }[])[0]!.limit, 1000);
  assert.equal((calls[1]!.body as { keywords: string[] }[])[0]!.keywords.length, 700);
  assert.equal(requestPhrase('x'.repeat(81)), null);
  assert.equal(requestPhrase('one two three four five six seven eight nine ten eleven'), null);
  assert.equal(requestPhrase('<b>Letting</b>\u0000 agent‮'), 'letting agent');
  assert.equal(requestPhrase('   '), null);
});

test('nothing usable to send makes no request and spends nothing', async () => {
  const { calls, fetchImpl } = transport(() => { throw new Error('must not be called'); });
  const p = new DataForSeoLabsProvider('l', 'p', fetchImpl);
  for (const r of [await p.keywordIdeas(['', '<>', '\u0000'], UK), await p.keywordSuggestions('  ', UK), await p.keywordsForSite('not a domain', UK), await p.rankedKeywords('http://', UK), await p.keywordOverview([], UK)]) {
    assert.equal(r.status, 'no_data'); assert.equal(r.providerReportedCost, 0); assert.equal(r.rows.length, 0); assert.equal(r.diagnostic, null);
  }
  assert.equal(calls.length, 0);
  assert.equal(requestDomain('HTTPS://WWW.Example.co.uk/path?q=1'), 'example.co.uk');
  assert.equal(requestDomain('shop.example.com'), 'shop.example.com');
  assert.equal(requestDomain('javascript:alert(1)'), null);
});

test('keyword ideas fixture: ranking difficulty comes from keyword_properties, never from ad competition; intent and month are inline', async () => {
  const { fetchImpl } = transport(() => json(fixture('keyword_ideas')));
  const r = await new DataForSeoLabsProvider('l', 'p', fetchImpl).keywordIdeas(['phone', 'watch'], UK);
  assert.equal(r.status, 'ok'); assert.equal(r.providerReportedCost, 0.0103); assert.equal(r.taskId, '08221822-1535-0400-0000-8fccf5eb0f23');
  assert.equal(r.totalCount, 533763); assert.equal(r.skippedRows, 0);
  const phone = r.rows.find((x) => x.phrase === 'phone')!;
  assert.equal(phone.searches, 368000);
  assert.equal(phone.rankingDifficulty, 83);
  assert.equal(phone.adCompetition, 1);
  assert.equal(phone.intent, 'navigational'); assert.deepEqual(phone.secondaryIntents, ['commercial']);
  assert.equal(phone.measuredMonth, '2024-07'); assert.equal(phone.dataUpdatedAt, '2024-08-11T13:24:34.000Z');
  assert.equal(phone.cpc, 5.98); assert.equal(phone.source, 'ideas'); assert.equal(phone.locationCode, 2840);
  assert.notEqual(phone.rankingDifficulty, Math.round(phone.adCompetition! * 100), 'difficulty is not the 0-1 ad competition rescaled');
});

test('suggestions, related, site, ranked, overview, difficulty, intent and competitors fixtures are read from their documented nesting', async () => {
  const read = async (name: string, call: (p: DataForSeoLabsProvider) => Promise<{ status: string; rows: readonly unknown[]; providerReportedCost: number | null }>) => {
    const { fetchImpl } = transport(() => json(fixture(name)));
    const r = await call(new DataForSeoLabsProvider('l', 'p', fetchImpl));
    assert.equal(r.status, 'ok', name);
    return r;
  };
  const sug = await read('keyword_suggestions', (p) => p.keywordSuggestions('phone', UK));
  const sugRows = sug.rows as { phrase: string; parent: string | null; searches: number | null; rankingDifficulty: number | null }[];
  assert.deepEqual(sugRows.map((x) => [x.phrase, x.parent]), [['phone', null], ['boost cell phone', 'phone']]);
  assert.equal(sugRows[0]!.searches, 368000);

  const rel = await read('related_keywords', (p) => p.relatedKeywords('phone', UK));
  const relRows = rel.rows as { phrase: string; parent: string | null; rankingDifficulty: number | null; source: string }[];
  assert.equal(relRows[0]!.phrase, 'phone'); assert.equal(relRows[0]!.rankingDifficulty, 83);
  assert.ok(relRows.every((x) => x.parent === 'phone' && x.source === 'related'));

  const site = await read('keywords_for_site', (p) => p.keywordsForSite('apple.com', UK));
  assert.ok((site.rows as { source: string }[]).every((x) => x.source === 'site_keywords'));

  const ranked = await read('ranked_keywords', (p) => p.rankedKeywords('dataforseo.com', UK));
  const rk = ranked.rows as { phrase: string; ranking: { position: number; url: string | null } | null; rankingDifficulty: number | null; source: string }[];
  const first = rk.find((x) => x.phrase === '1000 keywords')!;
  assert.deepEqual(first.ranking, { position: 1, url: 'https://dataforseo.com/free-seo-stats/top-1000-keywords' });
  assert.equal(first.rankingDifficulty, 7); assert.equal(first.source, 'own_ranked');
  const rival = await read('ranked_keywords', (p) => p.rankedKeywords('dataforseo.com', UK, { competitor: true }));
  assert.ok((rival.rows as { source: string; competitorDomain?: string | null }[]).every((x) => x.source === 'competitor_ranked' && x.competitorDomain === 'dataforseo.com'));

  const ov = await read('keyword_overview', (p) => p.keywordOverview(['iphone'], UK));
  const iphone = (ov.rows as { phrase: string; searches: number | null; rankingDifficulty: number | null; intent: string | null; source: string }[])[0]!;
  assert.equal(iphone.phrase, 'iphone'); assert.equal(typeof iphone.searches, 'number'); assert.equal(iphone.source, 'overview');
  assert.equal(ov.providerReportedCost, 0.0201);

  const kd = await read('bulk_keyword_difficulty', (p) => p.bulkKeywordDifficulty(['dentist new york'], UK));
  assert.ok((kd.rows as { rankingDifficulty: number | null }[]).every((x) => x.rankingDifficulty === null || (x.rankingDifficulty >= 0 && x.rankingDifficulty <= 100)));

  const intent = await read('search_intent', (p) => p.searchIntent(['login page'], UK));
  const login = (intent.rows as { phrase: string; intent: string | null; probability: number | null }[]).find((x) => x.phrase === 'login page')!;
  assert.equal(login.intent, 'navigational'); assert.equal(typeof login.probability, 'number');
  assert.equal(intent.providerReportedCost, 0.01248);

  const comp = await read('competitors_domain', (p) => p.competitorDomains('newmouth.com', UK));
  const domains = comp.rows as { domain: string; averagePosition: number | null; sharedKeywords: number | null }[];
  assert.ok(domains.length > 0 && domains.every((d) => d.domain !== 'newmouth.com' && !d.domain.startsWith('www.')));
});

test('null and missing fields stay null (never zero); unreadable rows are skipped and counted', async () => {
  const body = {
    status_code: 20000, cost: 0.01212,
    tasks: [{ id: 'task-12345678', status_code: 20000, cost: 0.01212, result: [{ total_count: 3, items: [
      { keyword: 'quiet phrase', keyword_info: null, keyword_properties: null, search_intent_info: null },
      { keyword: 'odd types', keyword_info: { search_volume: 'many', competition: 7, cpc: -1, monthly_searches: [{ year: 'x' }] }, keyword_properties: { keyword_difficulty: 140 }, search_intent_info: { main_intent: 'shopping' } },
      { keyword_info: { search_volume: 10 } },
      'not an object',
    ] }] }],
  };
  const { fetchImpl } = transport(() => json(body));
  const r = await new DataForSeoLabsProvider('l', 'p', fetchImpl).keywordIdeas(['x'], UK);
  assert.equal(r.status, 'ok'); assert.equal(r.skippedRows, 2); assert.equal(r.rows.length, 2);
  for (const row of r.rows) {
    assert.equal(row.searches, null); assert.equal(row.rankingDifficulty, null); assert.equal(row.intent, null);
    assert.equal(row.measuredMonth, null); assert.equal(row.adCompetition, null); assert.equal(row.cpc, null);
  }
  assert.equal(latestMonth([{ year: 2026, month: 9 }, { year: 2026, month: 10 }, { year: 2025, month: 12 }]), '2026-10');
  assert.equal(supplierTime('not a time'), null);
});

test('empty answers are "no data", not failures: empty items, null items, null result and the no-results code', async () => {
  const cases: unknown[] = [
    { status_code: 20000, cost: 0.012, tasks: [{ id: 'task-12345678', status_code: 20000, cost: 0.012, result: [{ total_count: 0, items: [] }] }] },
    { status_code: 20000, cost: 0.012, tasks: [{ id: 'task-12345678', status_code: 20000, cost: 0.012, result: [{ items: null }] }] },
    { status_code: 20000, cost: 0.012, tasks: [{ id: 'task-12345678', status_code: 20000, cost: 0.012, result: null }] },
    { status_code: 20000, cost: 0.012, tasks: [{ id: 'task-12345678', status_code: 40102, cost: 0.012, result: null }] },
  ];
  for (const body of cases) {
    const { fetchImpl } = transport(() => json(body));
    const r = await new DataForSeoLabsProvider('l', 'p', fetchImpl).keywordsForSite('example.co.uk', UK);
    assert.equal(r.status, 'no_data'); assert.equal(r.diagnostic, null); assert.equal(r.rows.length, 0);
    assert.equal(r.providerReportedCost, 0.012, 'a paid "no data" answer still records its cost');
  }
});

test('supplier codes map to the shared research diagnostic categories; only 40101 is retryable; nothing is retried here', async () => {
  const expected: [number, string, boolean][] = [
    [40101, 'transient', true], [40103, 'task_failed', false], [40100, 'credentials', false], [40104, 'verification', false],
    [40200, 'payment', false], [40203, 'daily_limit', false], [40204, 'entitlement', false], [40501, 'unknown', false], [50000, 'unknown', false],
  ];
  for (const [code, category, retryable] of expected) {
    for (const level of ['task', 'envelope'] as const) {
      let calls = 0;
      const body = level === 'task'
        ? { status_code: 20000, cost: 0.012, tasks: [{ id: 'task-12345678', status_code: code, status_message: 'SECRET_PROVIDER_TEXT fixture-password', cost: 0.012 }] }
        : { status_code: code, status_message: 'SECRET_PROVIDER_TEXT', cost: 0, tasks: [{ id: 'task-12345678', status_code: code, cost: 0 }] };
      const p = new DataForSeoLabsProvider('fixture-login', 'fixture-password', (async () => { calls++; return json(body); }) as typeof fetch);
      const r = await p.keywordIdeas(['letting agent'], UK);
      assert.equal(r.status, 'failed'); assert.equal(r.diagnostic!.category, category, `${level} ${code}`);
      assert.equal(r.diagnostic!.retryable, retryable); assert.equal(r.diagnostic!.supplierCode, code);
      assert.equal(r.taskId, 'task-12345678'); assert.equal(calls, 1, 'the transport never retries itself');
      assert.doesNotMatch(JSON.stringify(r), /SECRET_PROVIDER_TEXT|fixture-password|fixture-login/);
    }
  }
  for (const [status, category] of [[401, 'credentials'], [403, 'credentials'], [429, 'unknown'], [500, 'unknown']] as const) {
    const p = new DataForSeoLabsProvider('l', 'p', (async () => new Response('private provider body', { status })) as typeof fetch);
    const r = await p.keywordOverview(['a phrase'], UK);
    assert.equal(r.status, 'failed'); assert.equal(r.diagnostic!.category, category); assert.equal(r.diagnostic!.httpStatus, status);
    assert.doesNotMatch(JSON.stringify(r), /private provider body/);
  }
});

test('partial failure: a malformed acknowledgement or a missing task is a failed call with uncertain outcome', async () => {
  for (const body of [{ status_code: 20000, cost: 0.012 }, { status_code: 20000, tasks: [] }, 'not json at all']) {
    const p = new DataForSeoLabsProvider('l', 'p', (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body))) as typeof fetch);
    const r = await p.relatedKeywords('letting agent', UK);
    assert.equal(r.status, 'failed'); assert.equal(r.diagnostic!.category, 'unknown'); assert.equal(r.diagnostic!.retryable, false);
  }
  const top = new DataForSeoLabsProvider('l', 'p', (async () => json({ status_code: 20000, cost: 0.5, tasks: [{ id: 'task-12345678', status_code: 20000, result: [{ items: [] }] }] })) as typeof fetch);
  assert.equal((await top.keywordIdeas(['x'], UK)).providerReportedCost, 0.5, 'falls back to the envelope cost when the task has none');
  for (const cost of [-1, Number.NaN, '0.1', 2_000_000]) {
    const p = new DataForSeoLabsProvider('l', 'p', (async () => json({ status_code: 20000, tasks: [{ id: 'task-12345678', status_code: 20000, cost, result: [{ items: [] }] }] })) as typeof fetch);
    assert.equal((await p.keywordIdeas(['x'], UK)).providerReportedCost, null);
  }
});

test('a timeout or network failure is reported as uncertain, never retried, and keeps no credentials', async () => {
  let calls = 0;
  const hang = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
  }) as typeof fetch;
  const started = Date.now();
  const keepAlive = setTimeout(() => undefined, 10_000); // AbortSignal.timeout's timer does not hold the event loop open
  const r = await new DataForSeoLabsProvider('fixture-login', 'fixture-password', hang, 25).keywordIdeas(['letting agent'], UK);
  clearTimeout(keepAlive);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(r.status, 'failed'); assert.equal(r.diagnostic!.category, 'unknown'); assert.equal(r.diagnostic!.retryable, false);
  assert.equal(r.providerReportedCost, null); assert.equal(calls, 1);
  assert.match(r.diagnostic!.remedy, /uncertain/);
  const down = await new DataForSeoLabsProvider('l', 'p', (async () => { throw new TypeError('fetch failed fixture-password'); }) as typeof fetch).keywordIdeas(['x'], UK);
  assert.equal(down.status, 'failed'); assert.doesNotMatch(JSON.stringify(down), /fixture-password/);
});

test('questions people ask: a FREE read of an already-posted results task in advanced form', async () => {
  const doc = fixture('serp_task_get_advanced');
  const taskId = (doc.tasks as { id: string }[])[0]!.id;
  const { calls, fetchImpl } = transport(() => json(doc));
  const r = await new DataForSeoLabsProvider('l', 'p', fetchImpl).readSerpObservations(taskId);
  assert.equal(calls[0]!.method, 'GET'); assert.equal(calls[0]!.body, null);
  assert.equal(calls[0]!.url, `https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/${taskId}`);
  assert.equal(r.status, 'ok'); assert.equal(r.providerReportedCost, 0, 'the GET echoes the posting cost; reading is free, so nothing is double counted');
  const obs = r.rows[0]!;
  assert.ok(obs.questions.includes('What are the symptoms of HIDS disease?'));
  assert.ok(obs.relatedSearches.includes('iphone xr'));
  assert.ok(obs.organic.length > 0 && obs.organic.every((o) => o.position > 0 && /^https?:/.test(o.url)));
  for (const status_code of [40601, 40602]) {
    const pending = await new DataForSeoLabsProvider('l', 'p', (async () => json({ status_code: 20000, tasks: [{ id: taskId, status_code, cost: 0.0006 }] })) as typeof fetch).readSerpObservations(taskId);
    assert.equal(pending.status, 'pending'); assert.equal(pending.providerReportedCost, 0);
  }
  const mismatch = await new DataForSeoLabsProvider('l', 'p', (async () => json({ status_code: 20000, tasks: [{ id: 'another-12345678', status_code: 20000, result: [{}] }] })) as typeof fetch).readSerpObservations(taskId);
  assert.equal(mismatch.status, 'failed');
  const { calls: none, fetchImpl: never } = transport(() => json({}));
  assert.equal((await new DataForSeoLabsProvider('l', 'p', never).readSerpObservations('../../etc/passwd')).status, 'failed');
  assert.equal(none.length, 0, 'an unsafe task id is never put into a URL');
});

test('credential resolution matches research: prefixed names first, then plain; none means not configured', () => {
  assert.equal(configuredKeywordResearchProvider({}), null);
  assert.equal(configuredKeywordResearchProvider({ DATAFORSEO_LOGIN: 'l' }), null);
  assert.equal(configuredKeywordResearchProvider({ SEO_BLOG_DATAFORSEO_LOGIN: 'l', SEO_BLOG_DATAFORSEO_PASSWORD: 'p', SEO_BLOG_RESEARCH_PROVIDER: 'none' }), null);
  assert.ok(configuredKeywordResearchProvider({ SEO_BLOG_DATAFORSEO_LOGIN: 'l', SEO_BLOG_DATAFORSEO_PASSWORD: 'p' }) instanceof DataForSeoLabsProvider);
  assert.ok(configuredKeywordResearchProvider({ DATAFORSEO_LOGIN: 'l', DATAFORSEO_PASSWORD: 'p' }) instanceof DataForSeoLabsProvider);
  assert.throws(() => new DataForSeoLabsProvider('', 'p'), (e: unknown) => !String(e).includes('p@'));
  const p = new DataForSeoLabsProvider('fixture-login', 'fixture-password');
  assert.doesNotMatch(JSON.stringify(p) + String(Object.keys(p)), /fixture-login|fixture-password|Zml4dHVyZS1sb2dpbjpmaXh0dXJlLXBhc3N3b3Jk/);
});
