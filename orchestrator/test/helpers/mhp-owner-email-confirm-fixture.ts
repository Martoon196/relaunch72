/** Synthetic owner-email world for the confirmation tests and the local browser walk-through. example.invalid addresses only. */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMhpMount } from '../../src/mhp/mount.js';
import { MhpCommerceError } from '../../src/mhp/commerce-service.js';
import { MhpOwnerEmailService, type MhpOwnerEmailRepository, type MhpOwnerEmailActionResult } from '../../src/mhp/owner-email-service.js';
import type { MhpAudienceCandidate } from '../../src/mhp/webinar-audience.js';
import { portalCsrfToken } from '../../src/portal/session.js';
import type { PostgresPortalDeps } from '../../src/portal/router.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE } from '../../src/portal/product-profile.js';
import { ids, identity, token, now as fixtureNow, local, review, snapshot } from './mhp-owner-email-fixture.js';

// The owner email "Schedule remaining audience" path: one press used to queue the whole webinar list with no
// names. These tests run the real service and router over an in-memory repository that follows
// app_private.mhp_owner_email_queue_command (0127): schedule = eligible registrations without a row for this email.
export const EMAIL_HOST = 'app.martinhowardproperty.co.uk', ORIGIN = `https://${EMAIL_HOST}`, SECRET = 'synthetic-owner-email-confirm-secret-at-least-32';
export const EMAIL_BASE = '/hq/marketing/emails';
const prospect = (n: number) => `0e3a1000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = (n: number, extra: Partial<MhpAudienceCandidate> = {}): MhpAudienceCandidate => ({ prospectId: prospect(n), email: `guest.${n}@example.invalid`, firstName: `Guest ${n}`,
  label: 'Before You Buy live webinar', registeredAt: null, marketingConsent: true, unsubscribed: false, signupConsentGiven: true, ...extra });
const eligible = (c: MhpAudienceCandidate) => c.marketingConsent && !c.unsubscribed && c.signupConsentGiven;
export function emailWorld() {
  const w = { now: fixtureNow, candidates: [1, 2, 3, 4, 5, 6].map(n => person(n)).concat([person(7, { unsubscribed: true }), person(8, { marketingConsent: false })]),
    rows: new Map<string, 'pending' | 'held' | 'cancelled'>(), calls: [] as string[], receipts: new Map<string, MhpOwnerEmailActionResult>(), beforeQueue: null as null | (() => void) };
  const campaign = snapshot.database.campaign;
  const repository: MhpOwnerEmailRepository = {
    snapshot: async () => ({ ...snapshot.database, eligible: w.candidates.filter(eligible).length,
      ownerItems: w.rows.size ? [{ contentItemId: ids.item, total: w.rows.size, sent: 0, pending: [...w.rows.values()].filter(v => v === 'pending').length, held: [...w.rows.values()].filter(v => v === 'held').length,
        inFlight: 0, failed: 0, cancelled: [...w.rows.values()].filter(v => v === 'cancelled').length, dueAt: null, expiresAt: null, holdReason: null, lastFailure: null }] : [] }),
    local: async () => local,
    audienceCandidates: async (_i, c, after) => { if (c !== campaign) throw new Error('wrong campaign'); const sorted = [...w.candidates].sort((a, b) => a.prospectId < b.prospectId ? -1 : 1).filter(x => after === null || x.prospectId > after);
      return { candidates: sorted.slice(0, 25), hasMore: sorted.length > 25, nextAfter: sorted.length > 25 ? sorted[24]!.prospectId : null }; },
    queue: async (_i, input) => {
      w.calls.push(input.action); const key = `${input.action}:${input.commandId}`; const prior = w.receipts.get(key); if (prior) return { ...prior, replayed: true };
      let changed = 0;
      if (input.action === 'schedule') { w.beforeQueue?.(); w.beforeQueue = null; for (const c of w.candidates.filter(eligible)) if (!w.rows.has(c.prospectId)) { w.rows.set(c.prospectId, 'pending'); changed++; } }
      else for (const [id, state] of w.rows) if (state !== 'cancelled') { if (input.action === 'cancel') w.rows.set(id, 'cancelled'); changed++; }
      const result = { action: input.action, contentItemId: ids.item, contentVersionId: input.versionId, changed, remaining: 0, inFlight: 0, replayed: false };
      w.receipts.set(key, result); return result;
    },
    testBegin: async () => ({ send: false, status: 'unknown' }), testFinish: async () => {},
  };
  const service = new MhpOwnerEmailService({
    marketingWorkspace: { snapshot: async given => ({ userId: given.userId, selectedWorkspaceId: given.workspaceId, personalWorkspaceId: ids.prospect, marketingWorkspaceId: identity.workspaceId, marketingSelected: true }) },
    repository, reader: { listCatalog: async () => snapshot.catalog, getExactReview: async () => ({ ...review, approvalStatus: 'approved' }) },
    adapter: {} as never, approvals: {} as never, adapterTransactions: {} as never, campaign, status: { mode: 'live', providerReady: true, testRecipientCount: 0, testEnabled: false }, testRecipient: null });
  const portal = { kind: 'postgres', secure: true, sessionSecret: SECRET, sessionCookieName: '__Host-mhp_session', productProfile: MARTIN_HOWARD_PROPERTY_PROFILE, portalBaseUrl: ORIGIN, now: () => w.now,
    crm: {} as PostgresPortalDeps['crm'], auth: { resolve: async (given: string) => given === token ? identity : null, login: async () => null, revoke: async () => {} }, abuseHashSecret: SECRET,
    requestContext: () => ({ requestId: ids.request, requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }),
    abuse: { admit: async () => ({ allowed: true, leaseHash: Buffer.alloc(32, 1), retryAfterSeconds: 0 }), complete: async () => {}, assertReady: async () => {}, close: async () => {} } } as PostgresPortalDeps;
  const mount = createMhpMount({ portal, ownerEmail: service, authMount: { handle: async () => false }, readiness: async () => [],
    hq: { isOwner: async () => true, snapshot: async () => ({ people: [], products: [], grants: [] }), grant: async () => ids.command },
    commerce: { billingEnabled: false, snapshot: async () => { throw new Error('excluded'); }, refund: async () => {}, billingPortal: async () => '', webhook: async () => {} },
    marketingWorkspace: { snapshot: async given => ({ userId: given.userId, selectedWorkspaceId: given.workspaceId, personalWorkspaceId: ids.prospect, marketingWorkspaceId: identity.workspaceId, marketingSelected: true }), select: async () => { throw new Error('excluded'); } } });
  async function request(method: string, path: string, body = '', headers: Record<string, string> = {}) {
    const out = { status: 0, headers: {} as Record<string, string>, body: '' };
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url: path, headers: { host: EMAIL_HOST, cookie: `__Host-mhp_session=${token}`, 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number, head: Record<string, string> = {}) { out.status = status; for (const [k, v] of Object.entries(head)) out.headers[k.toLowerCase()] = v; }, setHeader() {}, end(text = '') { out.body = text; } } as unknown as ServerResponse;
    await mount.handle(req, res); return out;
  }
  const formFields = (html: string, action: string) => {
    const found = [...html.matchAll(/<form method="post" action="([^"]+)"[^>]*>(.*?)<\/form>/gsu)].find(m => m[1] === action); if (!found) throw new Error(`No form ${action}`);
    const fields = new URLSearchParams(); for (const i of found[2]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/gu)) fields.append(i[1]!, i[2]!.replace(/&amp;/gu, '&')); return fields;
  };
  return { w, service, request, formFields, mount };
}
