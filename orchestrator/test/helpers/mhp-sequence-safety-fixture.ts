/**
 * A synthetic MHP follow-up world for the sequence safety release: the real MhpSequenceService
 * and real router, over an in-memory repository that follows app_private.mhp_sequence_command's
 * documented selection rules (0128). Synthetic names and example.invalid addresses only.
 */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CompanyContentExactReview, CompanyContentService, CompanyContentTransactionRunner } from '../../src/company-content-pg/index.js';
import { createMhpMount } from '../../src/mhp/mount.js';
import { MhpCommerceError } from '../../src/mhp/commerce-service.js';
import { MhpSequenceService, type MhpAudienceCandidate, type MhpSequenceActionResult, type MhpSequenceRepository, type MhpSequenceRun, type MhpSequenceLocal } from '../../src/mhp/followup-sequence-service.js';
import { canonicalFollowupSequence, followupSequenceSha, FOLLOWUP_SEQUENCE_MIME, FOLLOWUP_SEQUENCE_V2_SCHEMA, readCanonicalFollowupSequence } from '../../src/followup-sequences/definition.js';
import { storedFollowupAudience, type FollowupAudienceKind } from '../../src/followup-sequences/audience.js';
import type { FollowupEntryRule } from '../../src/followup-sequences/entry.js';
import type { FollowupRunState } from '../../src/followup-sequences/state.js';
import { portalCsrfToken } from '../../src/portal/session.js';
import type { PostgresPortalDeps } from '../../src/portal/router.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE } from '../../src/portal/product-profile.js';
import { ids, identity, token, now as fixtureNow, snapshot as emailSnapshot, review as emailReview, local as emailLocal } from './mhp-owner-email-fixture.js';

export const HOST = 'app.martinhowardproperty.co.uk', ORIGIN = `https://${HOST}`, SECRET = 'synthetic-sequence-safety-secret-at-least-32-bytes';
export const BASE = '/hq/marketing/sequences';
export const CAMPAIGN = 'webinar-2026-11-03';
export const seq = { item: '5afe0000-0000-4000-8000-000000000001', version: '5afe0000-0000-4000-8000-000000000002', book: '5afe0000-0000-4000-8000-000000000003',
  bookVersion: '5afe0000-0000-4000-8000-000000000004', other: '5afe0000-0000-4000-8000-000000000005', otherVersion: '5afe0000-0000-4000-8000-000000000006' };
export const prospect = (n: number) => `5afe1000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const runId = (n: number) => `5afe2000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FIRST = ['Alice', 'Ben', 'Chloe', 'Dev', 'Ella', 'Finn', 'Grace', 'Harry', 'Isla', 'Jack', 'Kira', 'Leo', 'Maya', 'Noah', 'Olive', 'Priya', 'Quinn', 'Ruby', 'Sam', 'Tara'];
export const person = (n: number): MhpAudienceCandidate => ({ prospectId: prospect(n), email: `${FIRST[(n - 1) % FIRST.length]!.toLowerCase()}.${n}@example.invalid`, firstName: FIRST[(n - 1) % FIRST.length]!,
  label: 'Before You Buy live webinar', registeredAt: '2026-10-20T10:00:00.000Z', marketingConsent: true, unsubscribed: false, signupConsentGiven: true });
const steps = [{ key: 'first', kind: 'email' as const, contentItemId: ids.item, contentVersionId: ids.version, contentSha256: emailReview.contentSha256 },
  { key: 'wait', kind: 'wait' as const, minutes: 2880 }, { key: 'second', kind: 'email' as const, contentItemId: ids.item, contentVersionId: ids.version, contentSha256: emailReview.contentSha256 }];
export const definitionFor = (title: string, entry: 'manual' | 'webinar_signup' = 'manual') => ({ schema: FOLLOWUP_SEQUENCE_V2_SCHEMA, brand: 'mhp' as const, campaign: CAMPAIGN, title, expiryHours: 24,
  entry: entry === 'manual' ? { mode: 'manual' as const, source: 'manual_owner' as const } : { mode: 'webinar_signup' as const, source: 'mhp.capture/v2' as const },
  stopOn: { reply: false, booked: false, purchased: false }, steps });

interface SequenceRecord { item: string; version: string; title: string; entry: 'manual' | 'webinar_signup'; audience: FollowupAudienceKind | 'legacy'; published: boolean; latest: boolean }
export interface World {
  sequences: Map<string, SequenceRecord>; runs: MhpSequenceRun[]; candidates: MhpAudienceCandidate[]; rules: FollowupEntryRule[];
  calls: string[]; commands: { action: string; commandId: string; runId: string; versionId: string }[]; receipts: Map<string, MhpSequenceActionResult>;
  batchLimit: number; mode: 'live' | 'test' | 'off'; workspaceSelected: boolean; failNext: { status: number; code?: string } | null;
  /** Runs inside the enrol command before people are chosen: simulates someone signing up in the race window. */
  beforeEnrol: (() => void) | null; now: number; selected: number; savedMetadata: unknown[];
}
let runCounter = 100;
export function makeRun(world: World, n: number, state: FollowupRunState, extra: Partial<MhpSequenceRun> = {}): MhpSequenceRun {
  const c = world.candidates.find(x => x.prospectId === prospect(n)) ?? person(n);
  const run: MhpSequenceRun = { id: runId(n), contentItemId: seq.item, contentVersionId: seq.version, email: c.email, firstName: c.firstName, state, position: state === 'active' ? 0 : 2,
    dueAt: new Date(world.now + 3_600_000).toISOString(), reason: state === 'stopped' ? 'manual' : null, createdAt: new Date(world.now - 86_400_000).toISOString(),
    lastAcceptedAt: state === 'completed' ? new Date(world.now - 3_600_000).toISOString() : null, inFlight: false, unknownProofId: null,
    steps: state === 'completed' ? [{ position: 0, acceptedAt: new Date(world.now - 90_000_000).toISOString(), dueAt: new Date(world.now - 90_000_000).toISOString(), expiresAt: new Date(world.now).toISOString(), cancelled: false, failed: false, held: false, inFlight: false },
      { position: 2, acceptedAt: new Date(world.now - 3_600_000).toISOString(), dueAt: new Date(world.now - 3_600_000).toISOString(), expiresAt: new Date(world.now).toISOString(), cancelled: false, failed: false, held: false, inFlight: false }] : [],
    ...extra };
  return run;
}
export function createWorld(): World {
  return { sequences: new Map([
    [seq.version, { item: seq.item, version: seq.version, title: 'Webinar replay follow-up', entry: 'manual', audience: 'webinar_signups', published: true, latest: true }],
    [seq.bookVersion, { item: seq.book, version: seq.bookVersion, title: 'Before You Buy: chapter one', entry: 'manual', audience: 'none_yet', published: true, latest: true }],
    [seq.otherVersion, { item: seq.other, version: seq.otherVersion, title: 'Old webinar thank-you', entry: 'manual', audience: 'legacy', published: true, latest: true }],
  ]), runs: [], candidates: Array.from({ length: 16 }, (_, i) => person(i + 1)), rules: [], calls: [], commands: [], receipts: new Map(), batchLimit: 500, mode: 'live',
  workspaceSelected: true, failNext: null, beforeEnrol: null, now: fixtureNow, selected: 0, savedMetadata: [] };
}
const eligible = (c: MhpAudienceCandidate) => c.marketingConsent && !c.unsubscribed && c.signupConsentGiven;
function record(world: World, versionId: string): SequenceRecord {
  const found = world.sequences.get(versionId); if (!found) throw new MhpCommerceError(404, 'This sequence was not found in the MHP workspace.'); return found;
}
function canonicalOf(r: SequenceRecord) { return canonicalFollowupSequence(definitionFor(r.title, r.entry)); }
export function repositoryFor(world: World): MhpSequenceRepository {
  const authorise = (given: { workspaceId: string }) => { if (!world.workspaceSelected || given.workspaceId !== identity.workspaceId) throw new MhpCommerceError(403, 'Open the MHP marketing workspace first.'); };
  return {
    snapshot: async given => { authorise(given); return { brand: emailSnapshot.database.brand, campaign: CAMPAIGN, eligible: world.candidates.filter(eligible).length,
      blocked: world.candidates.length - world.candidates.filter(eligible).length, runs: world.runs.slice(0, 100).map(run => ({ ...run })), runCount: world.runs.length, entryRules: world.rules.map(rule => ({ ...rule })) }; },
    local: async (given, versionId) => {
      authorise(given); if (!versionId) return null;
      const r = record(world, versionId), canonical = canonicalOf(r), sha = followupSequenceSha(canonical);
      const metadata = r.audience === 'legacy' ? {} : { mhpSequence: { schema: 'mhp.followup-sequence-local/v1', audience: storedFollowupAudience(r.audience, CAMPAIGN) } };
      return { ...emailLocal, contentItemId: r.item, contentVersionId: r.version, title: r.title, sourceItemId: `sequence:${r.item}`, sourceVersion: `edit:${r.version}`,
        canonicalContent: canonical, contentSha256: sha, metadata, valid: true,
        exact: { ...emailLocal.exact!, contentItemId: r.item, contentVersionId: r.version, canonicalContent: canonical, contentSha256: sha, definition: readCanonicalFollowupSequence(canonical), campaign: CAMPAIGN } } as unknown as MhpSequenceLocal;
    },
    audienceCandidates: async (given, campaign, after) => {
      authorise(given); world.calls.push('candidates');
      const sorted = [...world.candidates].sort((a, b) => a.prospectId < b.prospectId ? -1 : 1).filter(c => after === null || c.prospectId > after);
      const page = sorted.slice(0, 25); return { candidates: page.map(c => ({ ...c })), hasMore: sorted.length > 25, nextAfter: sorted.length > 25 ? page.at(-1)!.prospectId : null };
    },
    command: async (given, input) => {
      authorise(given);
      if (world.failNext) { const fail = world.failNext; world.failNext = null; throw new MhpCommerceError(fail.status, fail.status === 409 ? 'This sequence, one of its emails or its approval changed while you were looking at it, so nothing was done. Open the sequence again to see where things stand now.' : 'Sequence controls are temporarily unavailable. Nothing was changed. Try again in a minute.'); }
      const key = `${input.action}:${input.commandId}`, prior = world.receipts.get(key);
      world.calls.push(input.action); world.commands.push({ action: input.action, commandId: input.commandId, runId: input.runId, versionId: input.versionId });
      if (prior) return { ...prior, replayed: true };
      const r = record(world, input.versionId);
      let changed = 0, remaining = 0;
      if (input.action === 'enrol') {
        world.beforeEnrol?.(); world.beforeEnrol = null;
        const open = (c: MhpAudienceCandidate) => world.runs.some(run => run.email === c.email && ((run.contentVersionId === r.version) || (run.contentItemId === r.item && ['active', 'paused', 'held'].includes(run.state))));
        const pick = world.candidates.filter(c => eligible(c) && !open(c)).sort((a, b) => a.prospectId < b.prospectId ? -1 : 1);
        for (const c of pick.slice(0, world.batchLimit)) {
          world.runs.unshift({ id: `5afe3000-0000-4000-8000-${String(++runCounter).padStart(12, '0')}`, contentItemId: r.item, contentVersionId: r.version, email: c.email, firstName: c.firstName,
            state: 'active', position: 0, dueAt: new Date(world.now).toISOString(), reason: null, createdAt: new Date(world.now).toISOString(), lastAcceptedAt: null, inFlight: false, unknownProofId: null, steps: [] });
          changed++;
        }
        remaining = Math.max(0, pick.length - changed);
      } else {
        const match = (run: MhpSequenceRun) => run.contentItemId === r.item && (!input.runId || run.id === input.runId)
          && (input.action === 'pause' ? run.state === 'active' : input.action === 'resume' ? ['paused', 'held'].includes(run.state) : ['active', 'paused', 'held'].includes(run.state));
        const targets = world.runs.filter(match).sort((a, b) => a.id < b.id ? -1 : 1).slice(0, world.batchLimit);
        for (const run of targets) { run.state = input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'active' : input.action === 'stop' ? 'stopped' : 'cancelled'; if (input.action === 'stop') run.reason = 'manual'; changed++; }
        remaining = world.runs.filter(match).length;
      }
      const result: MhpSequenceActionResult = { action: input.action, contentItemId: r.item, contentVersionId: r.version, changed, remaining, blocked: 0, inFlight: 0, replayed: false };
      world.receipts.set(key, result); return result;
    },
    entryCommand: async (given, input) => { authorise(given); world.calls.push(`entry:${input.action}`); const r = record(world, input.versionId);
      return { action: input.action, contentItemId: r.item, contentVersionId: r.version, ruleId: input.ruleId || seq.other, state: input.action === 'activate' ? 'active' : 'off',
        expiresAt: input.expiresAt || new Date(world.now).toISOString(), watermark: '1', replayed: false }; },
  };
}
export function serviceFor(world: World): MhpSequenceService {
  const reviewOf = (versionId: string): CompanyContentExactReview => {
    const r = record(world, versionId), canonical = canonicalOf(r);
    return { ...emailReview, contentItemId: r.item, contentVersionId: r.version, kind: 'other', email: null, title: r.title, isLatest: r.latest,
      source: { system: 'mhp.followup-sequence', itemId: `sequence:${r.item}`, version: `edit:${r.version}` }, canonicalContent: canonical, canonicalByteLength: Buffer.byteLength(canonical),
      contentSha256: followupSequenceSha(canonical), contentMimeType: FOLLOWUP_SEQUENCE_MIME, approvalStatus: r.published ? 'approved' : 'unrequested', approvalStale: false } as CompanyContentExactReview;
  };
  const transactions = { run: async (_given: unknown, operation: any) => operation({ query: async () => ({ rows: [] }) }) } as CompanyContentTransactionRunner;
  const catalog = () => ({ items: [...world.sequences.values()].map(r => ({ ...reviewOf(r.version), sourceAttestationId: ids.proof, sourceCheckedAt: new Date(world.now).toISOString(),
    sourceExpiresAt: new Date(world.now + 900_000).toISOString(), sourceFresh: true, publishable: true })), nextCursor: null });
  return new MhpSequenceService({
    marketingWorkspace: { snapshot: async given => { if (!world.workspaceSelected) throw new MhpCommerceError(403, 'Open the MHP marketing workspace first.');
      return { userId: given.userId, selectedWorkspaceId: given.workspaceId, personalWorkspaceId: ids.prospect, marketingWorkspaceId: identity.workspaceId, marketingSelected: true }; },
      select: async () => { world.selected++; world.workspaceSelected = true; return { sessionToken: token, expiresAt: new Date(world.now + 3_600_000).toISOString(), workspaceId: identity.workspaceId }; } },
    repository: repositoryFor(world),
    reader: { listCatalog: async () => catalog() as any, getExactReview: async (_c, input) => reviewOf(input.contentVersionId) },
    adapter: { createVersion: async (_c, command) => { world.calls.push('save'); world.savedMetadata.push(command.metadata);
      return { disposition: 'applied', contentItemId: seq.book, contentVersionId: seq.bookVersion, versionNumber: 2, contentSha256: followupSequenceSha(command.content), sourceAttestationId: ids.proof, sourceAttestationExpiresAt: new Date(world.now + 900_000).toISOString() }; },
      refreshSourceAttestation: async () => { throw new Error('not used'); } } as Pick<CompanyContentService, 'createVersion' | 'refreshSourceAttestation'>,
    approvals: { requestApproval: async () => { throw new Error('not used'); }, decideApproval: async () => { throw new Error('not used'); } } as any,
    adapterTransactions: transactions,
    emails: { snapshot: async () => emailSnapshot, review: async () => ({ review: { ...emailReview, approvalStatus: 'approved', email: { ...emailReview.email!, subject: 'Your replay is ready, {{FIRSTNAME}}' } }, local: emailLocal }) as any,
      get status() { return { ...emailSnapshot.status, mode: world.mode, providerReady: world.mode !== 'off' }; } },
    campaign: CAMPAIGN,
  });
}
export function mountFor(world: World, service = serviceFor(world)) {
  const portal = { kind: 'postgres', secure: true, sessionSecret: SECRET, sessionCookieName: '__Host-mhp_session', productProfile: MARTIN_HOWARD_PROPERTY_PROFILE, portalBaseUrl: ORIGIN, now: () => world.now,
    crm: {} as PostgresPortalDeps['crm'], auth: { resolve: async (given: string) => given === token ? identity : null, login: async () => null, revoke: async () => {} }, abuseHashSecret: SECRET,
    requestContext: () => ({ requestId: ids.request, requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }),
    abuse: { admit: async () => ({ allowed: true, leaseHash: Buffer.alloc(32, 1), retryAfterSeconds: 0 }), complete: async () => {}, assertReady: async () => {}, close: async () => {} } } as PostgresPortalDeps;
  return { service, mount: createMhpMount({ portal, sequences: service, authMount: { handle: async () => false }, readiness: async () => [],
    hq: { isOwner: async () => true, snapshot: async () => ({ people: [], products: [], grants: [] }), grant: async () => ids.command },
    commerce: { billingEnabled: false, snapshot: async () => { throw new Error('excluded'); }, refund: async () => {}, billingPortal: async () => '', webhook: async () => {} },
    marketingWorkspace: { snapshot: async given => ({ userId: given.userId, selectedWorkspaceId: given.workspaceId, personalWorkspaceId: ids.prospect, marketingWorkspaceId: identity.workspaceId, marketingSelected: world.workspaceSelected }),
      select: async () => { throw new Error('excluded'); } } }) };
}
export const csrf = () => portalCsrfToken(SECRET, token);
export interface Reply { status: number; headers: Record<string, string>; body: string }
export function client(world: World) {
  const { mount, service } = mountFor(world);
  async function request(method: string, path: string, body = '', headers: Record<string, string> = {}): Promise<Reply> {
    const result: Reply = { status: 0, headers: {}, body: '' };
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url: path, headers: { host: HOST, cookie: `__Host-mhp_session=${token}`, 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number, head: Record<string, string> = {}) { result.status = status; for (const [k, v] of Object.entries(head)) result.headers[k.toLowerCase()] = v; },
      setHeader(key: string, value: string) { result.headers[key.toLowerCase()] = value; }, end(text = '') { result.body = text; } } as unknown as ServerResponse;
    await mount.handle(req, res); return result;
  }
  /** Submits a form exactly as a browser would from the rendered page: its own hidden fields plus the given overrides. */
  function formFields(html: string, action: string, index = 0): URLSearchParams {
    const forms = [...html.matchAll(/<form method="post" action="([^"]+)"[^>]*>(.*?)<\/form>/gsu)].filter(m => m[1] === action);
    const found = forms[index]; if (!found) throw new Error(`No form for ${action}`);
    const fields = new URLSearchParams();
    for (const input of found[2]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/gu)) fields.append(input[1]!, input[2]!.replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&'));
    return fields;
  }
  const post = (action: string, fields: URLSearchParams) => request('POST', action, fields.toString());
  const follow = (reply: Reply) => { if (reply.status !== 303) throw new Error(`Expected redirect, got ${reply.status}: ${reply.body.slice(0, 300)}`); return request('GET', reply.headers.location!); };
  return { request, formFields, post, follow, service };
}
export const page = (item: string, version: string, extra = '') => `${BASE}?item=${item}&version=${version}${extra}`;
/** Visible owner text: no tags, scripts, styles or attribute values. */
export function visibleText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gu, ' ').replace(/<style[\s\S]*?<\/style>/gu, ' ').replace(/<[^>]+>/gu, ' ').replace(/&[a-z#0-9]+;/giu, ' ').replace(/\s+/gu, ' ');
}
