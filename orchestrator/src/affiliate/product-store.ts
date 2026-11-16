/**
 * The affiliate products and programme details of one business (migration 0158), behind the r72_affiliate_definer
 * functions only, on the content-command connection (r72_content_command), exactly as the content owner stores call
 * their functions: one transaction with the request's user, business and request id, the owner's portal session
 * locked again inside it, and the sha-256 of the session token passed to the function, which checks the owner rule
 * itself (app_private.seo_media_owner) for the business asked about.
 *
 * While the database still ends at 0157 the functions do not exist: every call answers NOT_OPENED_YET instead of
 * failing (42883 undefined function, 42P01 undefined table, 3F000 undefined schema), so applying 0158 takes effect
 * without a restart. Every other refusal is a typed answer with one plain-English sentence; a failure we do not
 * recognise (the database is down) is thrown as it is. Nothing imports this module yet except tests.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import { programmeFor, parseRegisteredSite, type ProgrammeId } from './programmes.js';

/** The signed-in owner making the call (the user variant of the content stores' principal). */
export interface AffiliateOwner {
  readonly userId: string;
  readonly requestId: string;
  readonly sessionToken: string;
  /** The workspace the portal session has selected (the session is checked against it). */
  readonly selectedWorkspaceId: string;
}

/** The database does not have 0158 yet: the feature is simply not offered. */
export const NOT_OPENED_YET = Object.freeze({ ok: false as const, kind: 'not_opened_yet' as const });
export type NotOpenedYet = typeof NOT_OPENED_YET;

export type AffiliateRefusalReason = 'forbidden' | 'invalid' | 'stale' | 'command_reused' | 'settings_required' | 'tag_mismatch'
  | 'product_cap' | 'report_cap' | 'report_conflict' | 'not_found' | 'link' | 'report_unreadable';
export interface AffiliateRefusal {
  readonly ok: false;
  readonly kind: 'refused';
  readonly reason: AffiliateRefusalReason;
  /** One plain-English sentence a screen can show as it is. */
  readonly message: string;
}
export type AffiliateResult<T> = { readonly ok: true; readonly value: T } | NotOpenedYet | AffiliateRefusal;

export const AFFILIATE_MESSAGES: Readonly<Record<AffiliateRefusalReason, string>> = Object.freeze({
  forbidden: 'Only someone who runs this business can do this. Sign in again and try once more.',
  invalid: 'Some of these details could not be saved. Check them and try again.',
  stale: 'This was changed somewhere else a moment ago. Open it again to see the latest version.',
  command_reused: 'This was already sent once with different details. Open the page again and try once more.',
  settings_required: 'Add your Amazon UK tracking ID and website first.',
  tag_mismatch: 'This link carries a different tracking ID from the one saved for this business.',
  product_cap: 'A business can use up to 500 products at once. Stop using one before adding another.',
  report_cap: 'This business already keeps 200 reports, which is the most it can keep.',
  report_conflict: 'This report was already added for that month with different figures.',
  not_found: 'That product could not be found.',
  link: 'This link cannot be used.',
  report_unreadable: 'We could not read this report.',
});

const ABSENT = new Set(['42883', '42P01', '3F000']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => typeof value === 'string' ? value : null;

/** A refusal; message defaults to the reason's own sentence (a link or report refusal carries its specific one). */
export const refused = (reason: AffiliateRefusalReason, message: string = AFFILIATE_MESSAGES[reason]): AffiliateRefusal =>
  Object.freeze({ ok: false as const, kind: 'refused' as const, reason, message });

/** A database failure as an answer: not opened yet, a typed refusal, or null (not ours to answer: rethrow). */
export function answerFor(error: unknown): NotOpenedYet | AffiliateRefusal | null {
  if (error instanceof InactivePortalSessionError) return refused('forbidden');
  const code = String((error as { code?: unknown })?.code ?? '');
  const detail = String((error as { detail?: unknown })?.detail ?? '');
  if (ABSENT.has(code)) return NOT_OPENED_YET;
  if (code === '42501') return refused('forbidden');
  if (code === '40001') return refused('stale');
  if (code === '23505') return refused(detail === 'affiliate_report_conflict' ? 'report_conflict' : 'command_reused');
  if (code === '55000') return refused('settings_required');
  if (code === '54000') return refused(detail === 'affiliate_report_cap' ? 'report_cap' : 'product_cap');
  if (code === '22023' && detail === 'affiliate_tag_mismatch') return refused('tag_mismatch');
  if (code === '22023' && detail === 'affiliate_not_found') return refused('not_found');
  if (code === '22023' || code === '22P02' || code === '23514' || code === '22008' || code === '22007' || code === '23502') return refused('invalid');
  return null;
}

/**
 * One call of an 0158 function inside the owner's transaction. Shared by the product and report stores.
 */
export async function callAffiliateFunction<T>(pool: Pick<Pool, 'connect'>, owner: AffiliateOwner, fn: 'affiliate_product_command' | 'affiliate_programme_command' | 'affiliate_report_command',
  workspaceId: string, action: string, input: Record<string, unknown>): Promise<AffiliateResult<T>> {
  if (!UUID.test(workspaceId) || !UUID.test(owner.userId) || !UUID.test(owner.selectedWorkspaceId) || typeof owner.sessionToken !== 'string' || !owner.sessionToken) {
    return refused('forbidden');
  }
  const sessionHash = createHash('sha256').update(owner.sessionToken).digest();
  try {
    const value = await withTransaction(pool, { actorKind: 'user', workspaceId, userId: owner.userId, requestId: owner.requestId }, async (t) => {
      // The caller's exact portal session, locked again inside this transaction (as the content stores do).
      const guard = await t.query<{ ok: boolean }>('SELECT app_private.lock_active_portal_session($1, $2, $3) AS ok',
        [sessionHash, owner.userId, owner.selectedWorkspaceId]);
      if (guard.rows[0]?.ok !== true) throw new InactivePortalSessionError();
      const result = await t.query<{ value: T }>(`SELECT app_private.${fn}($1,$2,$3,$4::jsonb) AS value`, [workspaceId, sessionHash, action, JSON.stringify(input)]);
      return result.rows[0]!.value;
    });
    return Object.freeze({ ok: true as const, value });
  } catch (error) {
    const answer = answerFor(error);
    if (answer) return answer;
    throw error;
  }
}

export interface AffiliateProduct {
  readonly productId: string;
  readonly revision: number;
  readonly programme: ProgrammeId;
  readonly merchantName: string;
  readonly productName: string;
  /** The programme's product code (for Amazon UK, the ASIN). */
  readonly merchantProductId: string;
  readonly productUrl: string;
  readonly affiliateUrl: string;
  readonly infoUrl: string | null;
  readonly notes: string | null;
  readonly ownerUsed: boolean;
  readonly status: 'active' | 'retired';
  readonly createdAt: string;
}
export interface ProgrammeSettings {
  readonly programme: ProgrammeId;
  readonly revision: number;
  readonly trackingId: string;
  readonly registeredSite: string;
  readonly siteListedConfirmed: true;
  readonly accountConfirmed: true;
  readonly createdAt: string;
}
/** What the owner gives for a product: the link they pasted, and what they know about it. */
export interface ProductDetails {
  readonly programme: ProgrammeId;
  /** The pasted link or product page (read and rebuilt by the programme; never stored as pasted). */
  readonly link: string;
  readonly productName: string;
  readonly notes?: string | null;
  readonly ownerUsed: boolean;
  /** The maker's own page about it, optional. */
  readonly infoUrl?: string | null;
}
export interface CommandAnswer { readonly replayed: boolean; readonly productId: string; readonly revision: number; readonly status: 'active' | 'retired' }

function productOf(value: unknown): AffiliateProduct | null {
  if (!record(value) || typeof value.productId !== 'string' || typeof value.revision !== 'number' || programmeFor(value.programme) === null
    || typeof value.productName !== 'string' || typeof value.affiliateUrl !== 'string' || (value.status !== 'active' && value.status !== 'retired')) return null;
  return Object.freeze({ productId: value.productId, revision: value.revision, programme: value.programme as ProgrammeId, merchantName: String(value.merchantName ?? ''),
    productName: value.productName, merchantProductId: String(value.merchantProductId ?? ''), productUrl: String(value.productUrl ?? ''), affiliateUrl: value.affiliateUrl,
    infoUrl: str(value.infoUrl), notes: str(value.notes), ownerUsed: value.ownerUsed === true, status: value.status, createdAt: String(value.createdAt ?? '') });
}
function settingsOf(value: unknown): ProgrammeSettings | null {
  if (!record(value) || programmeFor(value.programme) === null || typeof value.revision !== 'number' || typeof value.trackingId !== 'string'
    || typeof value.registeredSite !== 'string') return null;
  return Object.freeze({ programme: value.programme as ProgrammeId, revision: value.revision, trackingId: value.trackingId, registeredSite: value.registeredSite,
    siteListedConfirmed: true as const, accountConfirmed: true as const, createdAt: String(value.createdAt ?? '') });
}
const map = <A, B>(result: AffiliateResult<A>, f: (a: A) => B): AffiliateResult<B> => result.ok ? Object.freeze({ ok: true as const, value: f(result.value) }) : result;

const TEXT = /[\u0000-\u001f\u007f<>]/u;
function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length >= 1 && text.length <= 200 && !TEXT.test(text) ? text : null;
}
function cleanNotes(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\r\n?/gu, '\n').replace(/\t/gu, ' ').trim();
  if (!text) return null;
  return text.length <= 2000 && !/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(text) ? text : undefined;
}
function cleanInfoUrl(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  const raw = value.trim();
  if (!/^https:\/\//iu.test(raw) || /[\s<>"'`\\]/u.test(raw) || (raw.slice(8).split(/[/?#]/u)[0] ?? '').includes('@')) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname.includes('.') && url.href.length <= 2048 ? url.href : undefined;
  } catch { return undefined; }
}

/**
 * The products and programme details of one business. Every write carries a command id (a fresh one when none is
 * given): sending the same command again answers the first result.
 */
export class PgAffiliateProductStore {
  constructor(private readonly pool: Pick<Pool, 'connect'>, private readonly owner: AffiliateOwner) {}

  private call<T>(fn: 'affiliate_product_command' | 'affiliate_programme_command', workspaceId: string, action: string, input: Record<string, unknown>) {
    return callAffiliateFunction<T>(this.pool, this.owner, fn, workspaceId, action, input);
  }

  async list(workspaceId: string): Promise<AffiliateResult<readonly AffiliateProduct[]>> {
    return map(await this.call<unknown>('affiliate_product_command', workspaceId, 'list', {}),
      value => Object.freeze((Array.isArray(value) ? value : []).map(productOf).filter((p): p is AffiliateProduct => p !== null)));
  }

  async get(workspaceId: string, productId: string): Promise<AffiliateResult<AffiliateProduct | null>> {
    if (!UUID.test(productId)) return refused('invalid');
    return map(await this.call<unknown>('affiliate_product_command', workspaceId, 'get', { productId }), productOf);
  }

  async settings(workspaceId: string, programme: ProgrammeId): Promise<AffiliateResult<ProgrammeSettings | null>> {
    if (!programmeFor(programme)) return refused('invalid');
    return map(await this.call<unknown>('affiliate_programme_command', workspaceId, 'get', { programme }), settingsOf);
  }

  /** Saves the programme details (expectedRevision 0 for the first time). Both confirmations must be true. */
  async saveSettings(args: { readonly workspaceId: string; readonly programme: ProgrammeId; readonly expectedRevision: number; readonly trackingId: string;
    readonly registeredSite: string; readonly siteListedConfirmed: boolean; readonly accountConfirmed: boolean; readonly commandId?: string }):
    Promise<AffiliateResult<{ readonly replayed: boolean; readonly revision: number }>> {
    const programme = programmeFor(args.programme);
    const commandId = args.commandId ?? randomUUID();
    if (!programme || !UUID.test(commandId) || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || args.expectedRevision > 999
      || args.siteListedConfirmed !== true || args.accountConfirmed !== true) return refused('invalid');
    const tracking = programme.validateTrackingId(args.trackingId), site = parseRegisteredSite(args.registeredSite);
    if (!tracking.ok || !site.ok) return refused('invalid');
    const result = await this.call<{ replayed: boolean; revision: number }>('affiliate_programme_command', args.workspaceId, 'save', {
      commandId, programme: programme.id, expectedRevision: args.expectedRevision,
      settings: { trackingId: tracking.trackingId, registeredSite: site.site, siteListedConfirmed: true, accountConfirmed: true },
    });
    return map(result, v => Object.freeze({ replayed: v.replayed === true, revision: Number(v.revision) }));
  }

  /**
   * The product as it will be stored: the link read and rebuilt with the saved tracking ID (refused in plain English
   * when the link cannot be used), the other fields cleaned. Pure: no database call.
   */
  static prepare(details: ProductDetails, savedTrackingId: string | null): { readonly ok: true; readonly product: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
    const programme = programmeFor(details.programme);
    if (!programme) return { ok: false, reason: AFFILIATE_MESSAGES.invalid };
    const link = programme.prepareLink(details.link, savedTrackingId);
    if (!link.ok) return link;
    const productName = cleanName(details.productName);
    if (productName === null) return { ok: false, reason: 'Give the product a name of up to 200 characters.' };
    const notes = cleanNotes(details.notes);
    if (notes === undefined) return { ok: false, reason: 'What you know about the product can be up to 2,000 characters.' };
    const infoUrl = cleanInfoUrl(details.infoUrl);
    if (infoUrl === undefined) return { ok: false, reason: 'The maker\'s page must be a full secure web address, or leave it empty.' };
    if (typeof details.ownerUsed !== 'boolean') return { ok: false, reason: AFFILIATE_MESSAGES.invalid };
    return { ok: true, product: { programme: programme.id, merchantName: programme.merchantName, productName, merchantProductId: link.productCode,
      productUrl: link.productUrl, affiliateUrl: link.affiliateUrl, infoUrl, notes, ownerUsed: details.ownerUsed } };
  }

  private async write(workspaceId: string, action: 'add' | 'edit', productId: string, expectedRevision: number | null, details: ProductDetails, commandId: string):
    Promise<AffiliateResult<CommandAnswer>> {
    if (!UUID.test(productId) || !UUID.test(commandId)) return refused('invalid');
    const settings = await this.settings(workspaceId, details.programme);
    if (!settings.ok) return settings;
    if (settings.value === null) return refused('settings_required');
    const prepared = PgAffiliateProductStore.prepare(details, settings.value.trackingId);
    if (!prepared.ok) return refused('link', prepared.reason);
    const input: Record<string, unknown> = { commandId, productId, product: prepared.product };
    if (expectedRevision !== null) input.expectedRevision = expectedRevision;
    return map(await this.call<CommandAnswer>('affiliate_product_command', workspaceId, action, input), answerOf);
  }

  /** Adds a product. The programme details must be saved first; the link is rebuilt with the saved tracking ID. */
  add(args: { readonly workspaceId: string; readonly details: ProductDetails; readonly productId?: string; readonly commandId?: string }): Promise<AffiliateResult<CommandAnswer>> {
    return this.write(args.workspaceId, 'add', args.productId ?? randomUUID(), null, args.details, args.commandId ?? randomUUID());
  }

  /** A new revision of an active product. */
  async edit(args: { readonly workspaceId: string; readonly productId: string; readonly expectedRevision: number; readonly details: ProductDetails; readonly commandId?: string }):
    Promise<AffiliateResult<CommandAnswer>> {
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1 || args.expectedRevision > 999) return refused('invalid');
    return this.write(args.workspaceId, 'edit', args.productId, args.expectedRevision, args.details, args.commandId ?? randomUUID());
  }

  /** "Stop using": a new revision marked retired. Nothing is deleted. */
  async retire(args: { readonly workspaceId: string; readonly productId: string; readonly expectedRevision: number; readonly commandId?: string }): Promise<AffiliateResult<CommandAnswer>> {
    const commandId = args.commandId ?? randomUUID();
    if (!UUID.test(args.productId) || !UUID.test(commandId) || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1 || args.expectedRevision > 999) return refused('invalid');
    return map(await this.call<CommandAnswer>('affiliate_product_command', args.workspaceId, 'retire', { commandId, productId: args.productId, expectedRevision: args.expectedRevision }), answerOf);
  }
}

function answerOf(value: CommandAnswer): CommandAnswer {
  return Object.freeze({ replayed: value.replayed === true, productId: String(value.productId), revision: Number(value.revision), status: value.status === 'retired' ? 'retired' : 'active' });
}
