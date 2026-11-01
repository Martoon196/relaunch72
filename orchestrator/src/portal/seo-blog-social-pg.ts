/**
 * PostgreSQL implementation of the per-brand social registry and the
 * canonical planning/enqueue path for linked blog promotions.
 *
 * Every command runs under the signed-in owner's exact portal session through
 * the existing r72_zernio_social_command identity; brand membership is
 * re-checked by each definer function. Nothing here calls a provider except
 * the one-use OAuth handoff preparation owned by the connection service.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { CompanyContentService } from '../company-content-pg/index.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import type { PortalSessionIdentity } from './auth-service.js';
import { centralPromotionRunner } from './central-content-promotion-pg.js';
import { PgPortalZernioSocialConnectionService } from './zernio-social-connection-pg-service.js';
import type { PortalZernioFailureKind, PortalZernioWebhookResult } from './zernio-social-connection-service.js';
import type { VerifiedZernioAccountWebhook } from '../public-social-outbound/zernio-account-webhook-contract.js';
import { createZernioLiveConnectionClient, ZERNIO_LIVE_CONNECTION_CONTRACT, type ZernioLiveConnectionClient } from '../public-social-outbound/zernio-live-connection.js';
import { promotionCommand, promotionCommandKey } from '../seo-blog/promotions.js';
import { ACCOUNT_ID, PROFILE_ID, SocialDeliveryHoldError, type SocialAccount, type SocialBinding, type SocialOverview, type SocialPlanInput, type SocialPlanResult, type SocialProfile, type SocialRegistry } from '../seo-blog/social.js';
import { SeoBlogError, type PromotionNetwork } from '../seo-blog/types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function sha256(value: string): Buffer { return createHash('sha256').update(value, 'utf8').digest(); }

function failureMessage(kind: PortalZernioFailureKind): string {
  switch (kind) {
    case 'unauthenticated': return 'Sign in again to continue.';
    case 'forbidden': return 'Only an owner or admin of this brand can connect its accounts.';
    case 'validation': return 'Check the account details and try again.';
    case 'conflict': return 'A connection step for this network is already open. Try again shortly.';
    case 'billing_required': return 'The provider account needs attention before connecting.';
    case 'rate_limited': return 'The provider is rate limiting connections. Try again shortly.';
    case 'provider_rejected': return 'The provider rejected the connection handoff.';
    case 'provider_unavailable': return 'The provider is temporarily unavailable.';
    default: return 'Account connection is temporarily unavailable.';
  }
}

export interface PgSeoBlogSocialRegistryInput {
  readonly zernioPool: Pick<Pool, 'connect'>;
  readonly contentCommandPool: Pick<Pool, 'connect'>;
  readonly contentAdapterPool: Pick<Pool, 'connect'>;
  readonly identity: PortalSessionIdentity;
  readonly requestId: string;
  /** Zernio API key used only for the one-use OAuth handoff preparation. */
  readonly zernioApiKey: string | null;
  /** Property Predator's environment-bound profiles can never be registered to a brand. */
  readonly reservedProfileIds: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

export function createPgSeoBlogSocialRegistry(input: PgSeoBlogSocialRegistryInput): SocialRegistry {
  const sessionHash = sha256(input.identity.sessionToken);
  const now = input.now ?? (() => new Date());
  const reserved = new Set(input.reservedProfileIds.map(id => id.trim()).filter(Boolean));

  async function tx<T>(brandId: string, operation: (t: import('../db/transaction.js').DbTransaction) => Promise<T>, options: { serializable?: boolean; readOnly?: boolean } = {}): Promise<T> {
    if (!UUID.test(brandId)) throw new SeoBlogError(404, 'That brand was not found.', 'not_found');
    return withTransaction(input.zernioPool, { actorKind: 'user', userId: input.identity.userId, workspaceId: brandId, requestId: input.requestId }, async t => {
      const guard = await t.query<{ ok: boolean }>(`SELECT app_private.${options.readOnly ? 'active_portal_session' : 'lock_active_portal_session'}($1, $2, $3) AS ok`, [sessionHash, input.identity.userId, input.identity.workspaceId]);
      if (guard.rows[0]?.ok !== true) throw new InactivePortalSessionError();
      return operation(t);
    }, { isolation: options.serializable ? 'serializable' : 'read committed', readOnly: options.readOnly ?? false });
  }

  function translate(error: unknown): never {
    if (error instanceof SeoBlogError || error instanceof SocialDeliveryHoldError) throw error;
    const code = (error as { code?: string }).code;
    const message = (error as Error).message ?? '';
    // 42501 carries the curated reason from the definer function (membership, verification, target identity).
    if (code === '42501') throw new SeoBlogError(403, /not a verified account/.test(message) ? 'That account is not a verified, connected account of this brand.' : message || 'Only an owner or admin of this brand can change its social delivery.');
    if (code === '40001') throw new SeoBlogError(409, message.startsWith('That Zernio profile') || message.startsWith('This brand already') ? message : 'Something else changed at the same time. Try again.');
    if (code === '55000') throw new SocialDeliveryHoldError(message.replace(/^[^:]*:\s*/, ''));
    if (code === '23505') throw new SeoBlogError(409, 'That registration already exists.');
    if (code === '22023' || code === '23514' || code === '23503') throw new SeoBlogError(400, 'Check the details and try again.');
    throw error;
  }

  async function profileFor(brandId: string): Promise<SocialProfile | null> {
    const rows = await tx(brandId, async t => (await t.query<{ provider_connection_id: string; provider_profile_id: string; registered_at: Date }>(
      'SELECT provider_connection_id, provider_profile_id, registered_at FROM app_private.seo_blog_zernio_profile($1)', [brandId])).rows, { readOnly: true });
    const row = rows[0];
    return row ? { providerConnectionId: row.provider_connection_id, providerProfileId: row.provider_profile_id, registeredAt: new Date(row.registered_at).toISOString() } : null;
  }

  function liveClient(profile: SocialProfile): ZernioLiveConnectionClient {
    if (!input.zernioApiKey) throw new SeoBlogError(503, 'Account connection is not configured on this server.');
    return createZernioLiveConnectionClient({ apiKey: input.zernioApiKey, providerProfileId: profile.providerProfileId, fetch: input.fetch ?? globalThis.fetch });
  }

  /**
   * The 0074 connection functions take the session token digest as data and
   * re-check owner/admin membership of the brand workspace themselves; the
   * session itself is locked on its canonical workspace by tx() above, so the
   * brand id stays a selector rather than a session re-selection.
   */
  async function accountsFor(brandId: string, profile: SocialProfile): Promise<SocialAccount[]> {
    const rows = await tx(brandId, async t => (await t.query<{ account_id: string; network: SocialAccount['network']; username: string | null; status: SocialAccount['status']; linked_at: Date; webhook_receipt_count: string | number }>(
      'SELECT account_id, network, username, status, linked_at, webhook_receipt_count FROM app_private.read_zernio_social_accounts($1::uuid,$2::uuid,$3::bytea)',
      [brandId, profile.providerConnectionId, sha256(profile.providerProfileId)])).rows, { readOnly: true });
    return rows.map(r => ({ accountId: r.account_id, network: r.network, username: r.username, status: r.status, linkedAt: new Date(r.linked_at).toISOString(), webhookReceiptCount: Number(r.webhook_receipt_count) }));
  }

  async function bindingsFor(brandId: string): Promise<SocialBinding[]> {
    const rows = await tx(brandId, async t => (await t.query<{ binding_id: string; network: PromotionNetwork; provider_connection_id: string; provider_account_id_sha256: string; username: string | null; daily_cap: number; monthly_cap: number; status: 'active' | 'revoked'; registered_at: Date; revoked_at: Date | null }>(
      'SELECT * FROM app_private.seo_blog_social_bindings($1)', [brandId])).rows, { readOnly: true });
    return rows.map(r => ({ id: r.binding_id, network: r.network, providerConnectionId: r.provider_connection_id, providerAccountIdSha256: r.provider_account_id_sha256, username: r.username, dailyCap: Number(r.daily_cap), monthlyCap: Number(r.monthly_cap), status: r.status, registeredAt: new Date(r.registered_at).toISOString(), revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null }));
  }

  return {
    async overview(brandId) {
      const profile = await profileFor(brandId);
      const accounts = profile ? await accountsFor(brandId, profile) : [];
      return { profile, accounts, bindings: await bindingsFor(brandId) };
    },
    async registerProfile(brandId, displayName, providerProfileId) {
      const profileId = providerProfileId.trim();
      if (!PROFILE_ID.test(profileId)) throw new SeoBlogError(400, 'Enter the Zernio profile id exactly as shown in your Zernio dashboard.');
      if (reserved.has(profileId)) throw new SeoBlogError(403, 'That profile is reserved for another application and cannot be registered to a brand.');
      try {
        const rows = await tx(brandId, async t => (await t.query<{ provider_connection_id: string; disposition: 'applied' | 'replayed' }>(
          'SELECT provider_connection_id, disposition FROM app_private.seo_blog_register_zernio_profile($1, $2, $3)', [brandId, displayName.trim().slice(0, 120) || 'Brand social accounts', profileId])).rows);
        const row = rows[0];
        if (!row) throw new SeoBlogError(503, 'Registration did not complete.');
        return { providerConnectionId: row.provider_connection_id, disposition: row.disposition };
      } catch (error) {
        // Another brand's registration row is invisible under this brand's scope; only the unique digest reveals it.
        if ((error as { code?: string }).code === '23505') throw new SeoBlogError(409, 'That Zernio profile is registered to another brand.');
        translate(error);
      }
    },
    async beginConnect(brandId, network, intentId) {
      const profile = await profileFor(brandId);
      if (!profile) throw new SeoBlogError(409, 'Register the brand’s Zernio profile first.');
      const client = liveClient(profile);
      try {
        await tx(brandId, async t => {
          const r = await t.query<{ disposition: string }>(
            'SELECT app_private.begin_zernio_connection_intent($1::uuid,$2::uuid,$3::uuid,$4::bytea,$5::bytea,$6::text) AS disposition',
            [brandId, profile.providerConnectionId, intentId, sessionHash, sha256(profile.providerProfileId), network]);
          if (r.rows[0]?.disposition !== 'claimed' && r.rows[0]?.disposition !== 'replayed') throw new SeoBlogError(503, 'The connection handoff could not be recorded.');
        }, { serializable: true });
        const prepared = await client.prepare({ network, intentId });
        await tx(brandId, async t => {
          const r = await t.query<{ disposition: string }>(
            'SELECT app_private.complete_zernio_connection_preparation($1::uuid,$2::uuid,$3::uuid,$4::bytea,$5::bytea,$6::bytea) AS disposition',
            [brandId, profile.providerConnectionId, intentId, sessionHash, Buffer.from(prepared.providerStateSha256, 'hex'), Buffer.from(prepared.authUrlSha256, 'hex')]);
          if (r.rows[0]?.disposition !== 'prepared' && r.rows[0]?.disposition !== 'replayed') throw new SeoBlogError(503, 'The connection handoff could not be prepared.');
        }, { serializable: true });
        return { authUrl: prepared.authUrl };
      } catch (error) {
        if ((error as { name?: string }).name === 'ZernioLiveConnectionError') throw new SeoBlogError(503, failureMessage(((error as { code?: PortalZernioFailureKind }).code) ?? 'provider_rejected'));
        translate(error);
      }
    },
    async completeConnect(brandId, callback) {
      const profile = await profileFor(brandId);
      if (!profile) throw new SeoBlogError(409, 'Register the brand’s Zernio profile first.');
      if (callback.providerProfileId !== profile.providerProfileId) throw new SeoBlogError(400, 'The provider callback names a different profile.');
      if (!ACCOUNT_ID.test(callback.providerAccountId) && !PROFILE_ID.test(callback.providerAccountId)) throw new SeoBlogError(400, 'The provider callback is invalid.');
      const username = callback.username.trim();
      if (!username || username.length > 160 || /[\u0000-\u001f\u007f]/u.test(username)) throw new SeoBlogError(400, 'The provider callback is invalid.');
      try {
        const rows = await tx(brandId, async t => (await t.query<{ disposition: 'recorded' | 'replayed'; account_id: string }>(
          'SELECT disposition, account_id FROM app_private.record_zernio_connection_callback($1::uuid,$2::uuid,$3::uuid,$4::bytea,$5::bytea,$6::bytea,$7::text,$8::text,$9::bytea,$10::timestamptz)',
          [brandId, profile.providerConnectionId, callback.intentId, sessionHash, sha256(profile.providerProfileId), sha256(callback.providerAccountId), callback.network, username, sha256(callback.canonicalCallback), now().toISOString()])).rows, { serializable: true });
        const row = rows[0];
        if (!row || (row.disposition !== 'recorded' && row.disposition !== 'replayed')) throw new SeoBlogError(503, 'The provider callback could not be recorded.');
        return { disposition: row.disposition };
      } catch (error) { translate(error); }
    },
    async registerBinding(brandId, binding) {
      const accountId = binding.providerAccountId.trim().toLowerCase();
      if (!ACCOUNT_ID.test(accountId)) throw new SeoBlogError(400, 'Enter the 24-character account id from Zernio.');
      if (!Number.isInteger(binding.dailyCap) || binding.dailyCap < 0 || binding.dailyCap > 24 || !Number.isInteger(binding.monthlyCap) || binding.monthlyCap < 0 || binding.monthlyCap > 300) throw new SeoBlogError(400, 'Caps must be whole numbers: 0–24 per day and 0–300 per month.');
      const profile = await profileFor(brandId);
      if (!profile) throw new SeoBlogError(409, 'Register the brand’s Zernio profile first.');
      try {
        const rows = await tx(brandId, async t => (await t.query<{ binding_id: string; disposition: 'applied' | 'replayed' | 'caps_changed' }>(
          'SELECT binding_id, disposition FROM app_private.seo_blog_register_social_binding($1, $2, $3, $4, $5, $6)',
          [brandId, profile.providerConnectionId, binding.network, accountId, binding.dailyCap, binding.monthlyCap])).rows, { serializable: true });
        const row = rows[0];
        if (!row) throw new SeoBlogError(503, 'Registration did not complete.');
        return { bindingId: row.binding_id, disposition: row.disposition };
      } catch (error) { translate(error); }
    },
    async revokeBinding(brandId, bindingId) {
      if (!UUID.test(bindingId)) throw new SeoBlogError(400, 'Choose a registered account.');
      try { await tx(brandId, async t => { await t.query('SELECT app_private.seo_blog_revoke_social_binding($1, $2)', [brandId, bindingId]); }); }
      catch (error) { translate(error); }
    },
    async plan(request): Promise<SocialPlanResult> {
      const { brand, version, network, link, binding, observation, dispatchId, scheduledFor } = request;
      const command = promotionCommand(brand, version, network, observation);
      const context = { actorKind: 'user' as const, userId: input.identity.userId, workspaceId: brand.id, requestId: input.requestId };
      // 1. Fresh short-lived attestation of the exact source tuple, keyed by the durable schedule observation.
      const drafts = new CompanyContentService({ transactionRunner: centralPromotionRunner(input.contentAdapterPool, input.identity, version) });
      const attested = await drafts.refreshSourceAttestation(context, {
        commandKey: `${promotionCommandKey(version, network, observation)}:schedule`,
        contentItemId: link.contentItemId, contentVersionId: link.contentVersionId,
        expected: { source: command.source, contentSha256: command.blob.sha256, blobSha256: command.blob.sha256, brandSha256: command.brand.sha256 },
        attestation: { catalogSha256: command.attestation.catalogSha256, checkedAt: observation.observedAt, expiresAt: observation.expiresAt },
      });
      if (!link.approvalRequestId) throw new SocialDeliveryHoldError('Approve this exact accompanying post again before scheduling.');
      const approvalRequestId = link.approvalRequestId;
      // 2. Canonical planning intent + calendar job in one serializable command transaction.
      try {
        return await tx(brand.id, async t => {
          const target = await t.query<{ test_target_id: string }>(
            `SELECT test_target_id::text FROM app_private.bootstrap_zernio_calendar_planner_target($1::uuid,$2::uuid,$3::text,$4::bytea,$5::bytea)`,
            [brand.id, binding.providerConnectionId, network, sha256(await profileIdFor(t, brand.id)), Buffer.from(binding.providerAccountIdSha256, 'hex')]);
          const targetId = target.rows[0]?.test_target_id;
          if (!targetId || !UUID.test(targetId)) throw new SeoBlogError(503, 'The calendar target could not be prepared.');
          const intent = await t.query<{ intent_id: string; disposition: string }>(
            `SELECT intent_id::text, disposition FROM app_private.seo_blog_create_promotion_planning_intent($1::uuid,$2::uuid,$3::uuid,$4::timestamptz,$5::uuid[])`,
            [brand.id, dispatchId, link.contentVersionId, scheduledFor, [targetId]]);
          const intentId = intent.rows[0]?.intent_id;
          if (!intentId) throw new SeoBlogError(503, 'The planning intent could not be recorded.');
          const job = await t.query<{ job_id: string; daily_cap: number; monthly_cap: number }>(
            `SELECT job_id::text, daily_cap, monthly_cap FROM app_private.seo_blog_enqueue_zernio_calendar($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9::uuid,$10::text,$11::timestamptz)`,
            [brand.id, binding.id, intentId, targetId, link.contentItemId, link.contentVersionId, approvalRequestId, link.approvalDecisionId, attested.sourceAttestationId, `seo-blog:${dispatchId}`, scheduledFor]);
          const row = job.rows[0];
          if (!row?.job_id) throw new SeoBlogError(503, 'The calendar job could not be recorded.');
          return { intentId, jobId: row.job_id, dailyCap: Number(row.daily_cap), monthlyCap: Number(row.monthly_cap) };
        }, { serializable: true });
      } catch (error) { translate(error); }
    },
  };

  async function profileIdFor(t: import('../db/transaction.js').DbTransaction, brandId: string): Promise<string> {
    const rows = (await t.query<{ provider_profile_id: string }>('SELECT provider_profile_id FROM app_private.seo_blog_zernio_profile($1)', [brandId])).rows;
    const id = rows[0]?.provider_profile_id;
    if (!id) throw new SeoBlogError(409, 'Register the brand’s Zernio profile first.');
    return id;
  }
}

export function seoBlogSocialReservedProfileIds(env: NodeJS.ProcessEnv): string[] {
  return [env.PROPERTY_PREDATOR_ZERNIO_PROVIDER_PROFILE_ID ?? '', ...(env.PROPERTY_PREDATOR_ZERNIO_PROVIDER_PROFILE_IDS ?? '').split(',')]
    .map(v => v.trim()).filter(Boolean);
}

export function newDispatchId(): string { return randomUUID(); }

const DISCOVERY_WORKSPACE = '00000000-0000-4000-8000-000000000000';

export interface SeoBlogBrandProfileBinding {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly providerProfileId: string;
}

/** Maps a provider profile id to the single brand that registered it; null when no brand owns it. */
export async function resolveSeoBlogBrandForProfile(
  zernioPool: Pick<Pool, 'connect'>,
  actor: { actorKind: 'user'; userId: string; requestId: string } | { actorKind: 'webhook'; requestId: string },
  providerProfileId: string,
): Promise<SeoBlogBrandProfileBinding | null> {
  if (!PROFILE_ID.test(providerProfileId)) return null;
  const rows = await withTransaction(zernioPool, { ...actor, workspaceId: DISCOVERY_WORKSPACE }, async t => (await t.query<{ workspace_id: string; provider_connection_id: string; provider_profile_id: string }>(
    'SELECT workspace_id, provider_connection_id, provider_profile_id FROM app_private.seo_blog_zernio_profile_workspace($1)', [sha256(providerProfileId)])).rows, { readOnly: true });
  const row = rows[0];
  return row ? { workspaceId: row.workspace_id, connectionId: row.provider_connection_id, providerProfileId: row.provider_profile_id } : null;
}

export interface SeoBlogZernioWebhookBrands {
  resolve(providerProfileId: string): Promise<SeoBlogBrandProfileBinding | null>;
  record(verified: VerifiedZernioAccountWebhook, binding: SeoBlogBrandProfileBinding): Promise<PortalZernioWebhookResult>;
}

/** Signed account-lifecycle receipts for registered brands, recorded under that brand's own workspace and connection. */
export function createSeoBlogZernioWebhookBrands(zernioPool: Pick<Pool, 'connect'>): SeoBlogZernioWebhookBrands {
  const inertLiveClient: ZernioLiveConnectionClient = { contract: ZERNIO_LIVE_CONNECTION_CONTRACT, prepare: async () => { throw new Error('Webhook receipts never prepare a provider handoff'); } };
  return {
    resolve: profileId => resolveSeoBlogBrandForProfile(zernioPool, { actorKind: 'webhook', requestId: `zernio-webhook-resolve-${randomUUID()}` }, profileId),
    record(verified, binding) {
      const service = new PgPortalZernioSocialConnectionService({
        principalResolver: { resolve: async () => null }, commandPool: zernioPool, liveClient: inertLiveClient,
        workspaceId: binding.workspaceId, providerConnectionId: binding.connectionId, providerProfileId: binding.providerProfileId,
      });
      return service.recordWebhook(verified);
    },
  };
}
