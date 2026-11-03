/** Pure supplier adapter. Callers must durably reserve/start before invoking; no retries. */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import type { AuthorityQuery, AuthorityReceipt, AuthoritySample, IndexedMentionObservation, LinkGapCandidate, LinkGapQuery, MentionQuery, MentionSource } from './authority-types.js';

export const AUTHORITY_ENDPOINTS = Object.freeze({
  link_gap: 'https://api.dataforseo.com/v3/backlinks/domain_intersection/live',
  indexed_mentions: 'https://api.dataforseo.com/v3/ai_optimization/llm_mentions/search_mentions/live',
});
export const AUTHORITY_LIMITS = Object.freeze({ timeoutMs: 90_000, requestBytes: 32 * 1024, responseBytes: 8 * 1024 * 1024, results: 100, competitors: 5, sources: 25, excerptCharacters: 4000 });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export class AuthorityInputError extends Error {
  constructor() { super('Choose a bounded public-domain query, explicit market and valid date range.'); this.name = 'AuthorityInputError'; }
}
class InvalidResponse extends Error {
  constructor(readonly code: 'invalid_response' | 'response_limit' = 'invalid_response') { super(code); }
}
export function authorityDomain(value: string): string {
  if (typeof value !== 'string' || value.length > 253 || value !== value.trim() || /[:/?#@\s\\]/u.test(value)) throw new AuthorityInputError();
  const domain = domainToASCII(value).toLowerCase().replace(/^www\./u, '');
  if (!domain || isIP(domain) || !domain.includes('.') || domain.endsWith('.') || /\.(?:local|localhost|internal|lan|localdomain)$/u.test(domain)
      || domain.split('.').some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part)) || /^\d+$/u.test(domain.split('.').at(-1)!)) throw new AuthorityInputError();
  return domain;
}
export function authorityPageUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0020\u007f]/u.test(value)) throw new AuthorityInputError();
  let url: URL; try { url = new URL(value); } catch { throw new AuthorityInputError(); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new AuthorityInputError();
  authorityDomain(url.hostname); return url.href;
}
function text(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new InvalidResponse();
  return value;
}
function number(value: unknown, max = 1_000_000_000_000, integer = true): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isSafeInteger(value))) throw new InvalidResponse();
  return value;
}
function instant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 40) throw new InvalidResponse();
  const normalized = value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \+00:00$/u, '$1T$2Z');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(normalized) || !Number.isFinite(Date.parse(normalized))) throw new InvalidResponse();
  const result = new Date(normalized).toISOString();
  if (result.slice(0, 10) !== normalized.slice(0, 10)) throw new InvalidResponse(); return result;
}
function normalize(query: AuthorityQuery): AuthorityQuery {
  if (!uuid.test(query.brandId) || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > AUTHORITY_LIMITS.results) throw new AuthorityInputError();
  const common = { brandId: query.brandId.toLowerCase(), brandDomain: authorityDomain(query.brandDomain), limit: query.limit };
  if (query.kind === 'link_gap') {
    if (!Array.isArray(query.competitors) || query.competitors.length < 1 || query.competitors.length > AUTHORITY_LIMITS.competitors) throw new AuthorityInputError();
    const competitors = query.competitors.map(authorityDomain);
    if (new Set(competitors).size !== competitors.length || competitors.some((domain) => domain === common.brandDomain || domain.endsWith('.' + common.brandDomain) || common.brandDomain.endsWith('.' + domain))) throw new AuthorityInputError();
    return Object.freeze({ kind: 'link_gap', ...common, competitors: Object.freeze(competitors) });
  }
  if (query.kind !== 'indexed_mentions' || !['google', 'chat_gpt'].includes(query.platform) || !Number.isSafeInteger(query.locationCode) || query.locationCode < 1 || query.locationCode > 1_000_000
      || !/^[a-z]{2}$/u.test(query.languageCode) || common.brandDomain.length > 63 || typeof query.brandName !== 'string' || !query.brandName.trim() || query.brandName.length > 250
      || /[\u0000-\u001f\u007f]/u.test(query.brandName)) throw new AuthorityInputError();
  let since: string, until: string;
  try { since = instant(query.since)!; until = instant(query.until)!; } catch { throw new AuthorityInputError(); }
  if (!since || !until || since > until || Date.parse(until) - Date.parse(since) > 366 * 86_400_000) throw new AuthorityInputError();
  if (!query.match || !['domain_sources', 'answer_phrase'].includes(query.match.kind)) throw new AuthorityInputError();
  if (query.match.kind === 'answer_phrase' && (typeof query.match.phrase !== 'string' || !query.match.phrase.trim() || query.match.phrase.length > 250 || /[\u0000-\u001f\u007f]/u.test(query.match.phrase))) throw new AuthorityInputError();
  return Object.freeze({ kind: 'indexed_mentions', ...common, brandName: query.brandName.trim(), platform: query.platform, locationCode: query.locationCode,
    languageCode: query.languageCode, since, until, match: Object.freeze(query.match.kind === 'domain_sources' ? { kind: 'domain_sources' as const }
      : { kind: 'answer_phrase' as const, phrase: query.match.phrase.trim() }) });
}
function bodyFor(query: AuthorityQuery): string {
  if (query.kind === 'link_gap') return JSON.stringify([{ targets: Object.fromEntries(query.competitors.map((domain, index) => [String(index + 1), domain])),
    exclude_targets: [query.brandDomain], limit: query.limit, offset: 0, internal_list_limit: 10, include_subdomains: true,
    include_indirect_links: false, exclude_internal_backlinks: true, backlinks_status_type: 'live', intersection_mode: 'partial', rank_scale: 'one_hundred' }]);
  const format = (value: string) => value.slice(0, 19).replace('T', ' ') + ' +00:00';
  return JSON.stringify([{ target: query.match.kind === 'domain_sources'
    ? [{ domain: query.brandDomain, search_filter: 'include', search_scope: ['sources'], include_subdomains: true }]
    : [{ keyword: query.match.phrase, search_filter: 'include', search_scope: ['answer'], match_type: 'word_match' }],
    platform: query.platform, location_code: query.locationCode, language_code: query.languageCode, offset: 0, limit: query.limit,
    filters: [['last_response_at', '>=', format(query.since)], 'and', ['last_response_at', '<=', format(query.until)]] }]);
}
function gapItems(raw: readonly unknown[], query: LinkGapQuery): readonly LinkGapCandidate[] {
  return Object.freeze(raw.map((item) => {
    if (!record(item) || !record(item.domain_intersection)) throw new InvalidResponse();
    let domain: string | null = null;
    const entries = Object.entries(item.domain_intersection);
    if (!entries.length || entries.length > query.competitors.length) throw new InvalidResponse();
    const evidence: LinkGapCandidate['evidence'][number][] = [];
    for (const [key, value] of entries) {
      const index = Number(key) - 1;
      if (!Number.isSafeInteger(index) || String(index + 1) !== key || index < 0 || index >= query.competitors.length || !record(value) || typeof value.target !== 'string') throw new InvalidResponse();
      const observedDomain = authorityDomain(value.target);
      if (domain && domain !== observedDomain) throw new InvalidResponse(); domain = observedDomain;
      evidence.push(Object.freeze({ competitor: query.competitors[index]!, providerRank: number(value.rank, 100), reportedBacklinks: number(value.backlinks),
        reportedSpamScore: number(value.backlinks_spam_score, 100), firstSeenAt: instant(value.first_seen) }));
    }
    if (!domain || !evidence.length || evidence.length > query.competitors.length || domain === query.brandDomain || domain.endsWith('.' + query.brandDomain)) throw new InvalidResponse();
    return Object.freeze({ kind: 'supplier_link_gap_candidate' as const, brandId: query.brandId, id: sha(`${query.brandId}|link_gap|${domain}`),
      domain, evidence: Object.freeze(evidence), sourcePageVerified: false as const, contactVerified: false as const });
  }));
}
function sourceList(value: unknown): { sources: readonly MentionSource[]; truncated: boolean; known: boolean } {
  if (value === undefined || value === null) return { sources: Object.freeze([]), truncated: false, known: false };
  if (!Array.isArray(value)) throw new InvalidResponse();
  const sources = value.slice(0, AUTHORITY_LIMITS.sources).map((source) => {
    if (!record(source) || typeof source.url !== 'string') throw new InvalidResponse();
    return Object.freeze({ url: authorityPageUrl(source.url), title: text(source.title, 500), reportedPosition: number(source.rank, 1_000_000) });
  });
  return { sources: Object.freeze(sources), truncated: value.length > sources.length, known: true };
}
function phraseMatch(answer: string, phrase: string): boolean {
  const words = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const needle = words(phrase); return needle.length > 0 && (` ${words(answer)} `).includes(` ${needle} `);
}
function mentionItems(raw: readonly unknown[], query: MentionQuery, retrievedAt: string): readonly IndexedMentionObservation[] {
  return Object.freeze(raw.map((item) => {
    if (!record(item) || item.platform !== query.platform || item.location_code !== query.locationCode || item.language_code !== query.languageCode) throw new InvalidResponse();
    const firstRecordedAt = instant(item.first_response_at), lastUpdatedAt = instant(item.last_response_at);
    if (firstRecordedAt && lastUpdatedAt && firstRecordedAt > lastUpdatedAt) throw new InvalidResponse();
    if (lastUpdatedAt && (lastUpdatedAt < query.since || lastUpdatedAt > query.until)) throw new InvalidResponse();
    const answer = text(item.answer, AUTHORITY_LIMITS.responseBytes), question = text(item.question, 4000);
    const answerExcerpt = answer === null ? null : [...answer.slice(0, AUTHORITY_LIMITS.excerptCharacters * 2)].slice(0, AUTHORITY_LIMITS.excerptCharacters).join('');
    const excerptTruncated = answer !== null && answerExcerpt!.length < answer.length;
    const found = answerExcerpt === null ? null : phraseMatch(answerExcerpt, query.brandName);
    const sources = sourceList(item.sources), search = sourceList(item.search_results);
    const includesBrand = (url: string) => { const domain = authorityDomain(new URL(url).hostname); return domain === query.brandDomain || domain.endsWith('.' + query.brandDomain); };
    const present = (list: ReturnType<typeof sourceList>) => list.sources.some((source) => includesBrand(source.url)) ? true : list.known && !list.truncated ? false : null;
    return Object.freeze({ kind: 'supplier_indexed_mention' as const, brandId: query.brandId,
      id: sha(`${query.brandId}|${query.platform}|${query.locationCode}|${query.languageCode}|${question ?? ''}|${lastUpdatedAt ?? ''}|${sha(answer ?? '')}`),
      platform: query.platform, reportedModel: text(item.model_name, 100), locationCode: query.locationCode, languageCode: query.languageCode,
      question, answerExcerpt, excerptTruncated, firstRecordedAt, lastUpdatedAt, retrievedAt, sources: sources.sources, sourcesTruncated: sources.truncated,
      searchResults: search.sources, searchResultsTruncated: search.truncated, phraseInExcerpt: found === false && excerptTruncated ? null : found,
      brandInReportedSources: present(sources), brandInSearchResults: present(search), reportedAiSearchVolume: number(item.ai_search_volume),
      consumerResultObserved: false as const, referralTrafficMeasured: false as const });
  }));
}

export function queryAuthority(query: LinkGapQuery, dependencies: AuthorityDependencies): Promise<AuthoritySample<LinkGapCandidate>>;
export function queryAuthority(query: MentionQuery, dependencies: AuthorityDependencies): Promise<AuthoritySample<IndexedMentionObservation>>;
export async function queryAuthority(query: AuthorityQuery, dependencies: AuthorityDependencies): Promise<AuthoritySample<LinkGapCandidate | IndexedMentionObservation>> {
  const scope = normalize(query), body = bodyFor(scope), retrievedAt = instant((dependencies.now ?? (() => new Date()))().toISOString())!;
  const timeout = dependencies.timeoutMs ?? AUTHORITY_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > AUTHORITY_LIMITS.timeoutMs || Buffer.byteLength(body) > AUTHORITY_LIMITS.requestBytes) throw new AuthorityInputError();
  let receipt: AuthorityReceipt = { supplier: 'dataforseo', inputSha256: sha(JSON.stringify({ scope, body })), retrievedAt, httpStatus: null, responseCode: null, taskCode: null, taskId: null, requestEchoVerified: false, reportedTaskCostUsd: null, reportedTotalCostUsd: null };
  const result = (outcome: AuthoritySample<never>['outcome'], code: AuthoritySample<never>['code'], items: readonly (LinkGapCandidate | IndexedMentionObservation)[] = [], reportedTotal: number | null = null, complete = false): AuthoritySample<LinkGapCandidate | IndexedMentionObservation> =>
    Object.freeze({ outcome, code, scope, receipt: Object.freeze({ ...receipt }), items: Object.freeze([...items]), reportedTotal, complete });
  if (scope.kind === 'indexed_mentions' && scope.platform === 'chat_gpt' && (scope.locationCode !== 2840 || scope.languageCode !== 'en')) return result('unsupported', 'unsupported_market');
  const { login, password } = dependencies;
  if (!login || !password) return result('unconfigured', 'credentials_missing');
  if (Buffer.byteLength(login) > 512 || Buffer.byteLength(password) > 1024 || /[:\r\n\u0000]/u.test(login) || /[\r\n\u0000]/u.test(password)) throw new AuthorityInputError();
  if (dependencies.signal?.aborted) return result('not_started', 'aborted');
  const controller = new AbortController(); let rejectDeadline!: (reason: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const interrupt = () => { controller.abort(); rejectDeadline(new Error('interrupted')); };
  dependencies.signal?.addEventListener('abort', interrupt, { once: true }); const timer = setTimeout(interrupt, timeout);
  const race = <T>(operation: Promise<T>) => Promise.race([operation, deadline]);
  let responseBody: ReadableStream<Uint8Array> | null = null, reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    if (dependencies.signal?.aborted) return result('not_started', 'aborted');
    const response = await race((dependencies.fetchImpl ?? fetch)(AUTHORITY_ENDPOINTS[scope.kind], { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity' }, body }));
    responseBody = response.body; receipt = { ...receipt, httpStatus: response.status };
    if (!response.ok) return result([400, 401, 403, 404, 413, 422, 429].includes(response.status) ? 'provider_rejected' : 'outcome_unknown', 'provider_rejected');
    if (response.redirected || !/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;\s*charset=utf-8)?$/iu.test(response.headers.get('content-type') ?? '')
        || !['', 'identity'].includes((response.headers.get('content-encoding') ?? '').toLowerCase())) throw new InvalidResponse();
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^(?:0|[1-9][0-9]{0,8})$/u.test(declared) || Number(declared) > AUTHORITY_LIMITS.responseBytes)) throw new InvalidResponse('response_limit');
    if (!response.body) throw new InvalidResponse(); reader = response.body.getReader();
    const chunks: Buffer[] = []; let length = 0;
    for (;;) { const next = await race(reader.read()); if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new InvalidResponse(); length += next.value.byteLength;
      if (length > AUTHORITY_LIMITS.responseBytes) throw new InvalidResponse('response_limit'); chunks.push(Buffer.from(next.value)); }
    if (!length || (declared !== null && length !== Number(declared))) throw new InvalidResponse();
    let raw: unknown; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))); } catch { throw new InvalidResponse(); }
    if (!record(raw)) throw new InvalidResponse();
    receipt = { ...receipt, responseCode: number(raw.status_code, 60000), reportedTotalCostUsd: number(raw.cost, 1_000_000, false) };
    if (receipt.responseCode === null) throw new InvalidResponse();
    if (receipt.responseCode !== 20000) return result(receipt.responseCode >= 40000 ? 'provider_rejected' : 'outcome_unknown', 'provider_rejected');
    if (!Array.isArray(raw.tasks) || raw.tasks.length !== 1 || !record(raw.tasks[0]) || (raw.tasks_count !== undefined && raw.tasks_count !== 1)) throw new InvalidResponse();
    const task = raw.tasks[0], taskId = text(task.id, 100);
    if (taskId !== null && !/^[a-zA-Z0-9-]{1,100}$/u.test(taskId)) throw new InvalidResponse();
    receipt = { ...receipt, taskId, taskCode: number(task.status_code, 60000), reportedTaskCostUsd: number(task.cost, 1_000_000, false) };
    if (receipt.taskCode === null) throw new InvalidResponse();
    if (receipt.taskCode !== 20000) return result(receipt.taskCode >= 40000 ? 'provider_rejected' : 'outcome_unknown', 'provider_rejected');
    if (task.data !== undefined) {
      if (!record(task.data)) throw new InvalidResponse();
      const canonical = (value: unknown, depth = 0): unknown => {
        if (depth > 8) throw new InvalidResponse();
        if (Array.isArray(value)) { if (value.length > 50) throw new InvalidResponse(); return value.map((item) => canonical(item, depth + 1)); }
        if (record(value)) { const keys = Object.keys(value).sort(); if (keys.length > 50) throw new InvalidResponse(); return Object.fromEntries(keys.map((key) => [key, canonical(value[key], depth + 1)])); }
        return value;
      };
      const sent = (JSON.parse(body) as Record<string, unknown>[])[0]!;
      for (const key of Object.keys(sent)) {
        if (task.data[key] !== undefined && JSON.stringify(canonical(task.data[key])) !== JSON.stringify(canonical(sent[key]))) throw new InvalidResponse();
      }
      const required = scope.kind === 'link_gap' ? ['targets', 'exclude_targets'] : ['target', 'platform', 'location_code', 'language_code'];
      receipt = { ...receipt, requestEchoVerified: required.every((key) => task.data !== undefined && record(task.data) && Object.hasOwn(task.data, key)) };
    }
    if (!Array.isArray(task.result) || task.result.length !== 1 || !record(task.result[0])) throw new InvalidResponse();
    const data = task.result[0], total = number(data.total_count);
    if (!Array.isArray(data.items) || data.items.length > scope.limit || (data.items_count !== undefined && data.items_count !== data.items.length) || (total !== null && total < data.items.length)) throw new InvalidResponse();
    const items = scope.kind === 'link_gap' ? gapItems(data.items, scope) : mentionItems(data.items, scope, retrievedAt);
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new InvalidResponse();
    const complete = total !== null && total === items.length && !data.search_after_token;
    if (!items.length && total !== 0) return result('outcome_unknown', 'invalid_response');
    return result(items.length ? 'results' : 'empty', 'ok', items, total, complete);
  } catch (error) {
    controller.abort(); return result('outcome_unknown', error instanceof InvalidResponse ? error.code : error instanceof AuthorityInputError ? 'invalid_response' : 'transport_interrupted');
  } finally {
    clearTimeout(timer); dependencies.signal?.removeEventListener('abort', interrupt);
    if (reader) { void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* aborted pending read */ } }
    else if (responseBody) void responseBody.cancel().catch(() => undefined);
  }
}
export interface AuthorityDependencies {
  readonly login?: string; readonly password?: string; readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly now?: () => Date;
}
