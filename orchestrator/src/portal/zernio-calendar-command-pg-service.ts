/**
 * Postgres implementation of the calendar-to-Zernio command seam.
 *
 * Clear provider profile/account references are accepted only as constructor
 * configuration and immediately reduced to SHA-256 digests. They are never
 * stored on the service, returned, logged, rendered or accepted from a portal
 * request. The API key is deliberately absent from every type in this module.
 */

import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import {
  ZernioPostingError,
  type ZernioPostingClient,
} from '../public-social-outbound/zernio-posting-client.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import type {
  PortalZernioCalendarCommandFailure,
  PortalZernioCalendarCommandInput,
  PortalZernioCalendarCommandResult,
  PortalZernioCalendarCommandService,
  PortalZernioCalendarNetwork,
  PortalZernioDirectScheduleInput,
  PortalZernioDirectScheduleListResult,
  PortalZernioDirectScheduleResult,
} from './zernio-calendar-command-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROVIDER_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const OPERATION_TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,99}$/u;
const NETWORKS = new Set<unknown>(['instagram', 'linkedin']);
const COMMAND_KEYS = Object.freeze([
  'approvalDecisionId',
  'approvalRequestId',
  'contentItemId',
  'contentVersionId',
  'network',
  'operationTag',
  'planningIntentId',
  'planningTargetId',
  'scheduledFor',
  'sourceAttestationId',
] as const);

interface CommandRow extends QueryResultRow {
  readonly job_id: unknown;
  readonly idempotency_key_sha256: unknown;
  readonly daily_publish_cap: unknown;
  readonly monthly_publish_cap: unknown;
}

interface DirectReserveRow extends QueryResultRow {
  readonly schedule_id: unknown;
  readonly current_state: unknown;
  readonly provider_external_id: unknown;
  readonly scheduled_for: unknown;
  readonly created_now: unknown;
}

interface DirectListRow extends QueryResultRow {
  readonly schedule_id: unknown;
  readonly network: unknown;
  readonly content_body: unknown;
  readonly scheduled_for: unknown;
  readonly state: unknown;
  readonly provider_external_id: unknown;
  readonly safe_code: unknown;
}

export interface PortalZernioCalendarConfiguredAccount {
  readonly network: PortalZernioCalendarNetwork;
  readonly providerAccountId: string;
}

export interface PgPortalZernioCalendarCommandDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly commandPool: Pick<Pool, 'connect'>;
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  readonly providerProfileId: string;
  readonly accounts: readonly PortalZernioCalendarConfiguredAccount[];
  readonly postingClient?: Pick<ZernioPostingClient, 'schedule'>;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function failed(
  kind: PortalZernioCalendarCommandFailure['kind'],
): PortalZernioCalendarCommandFailure {
  return Object.freeze({ ok: false, kind });
}

function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

function mapFailure(error: unknown): PortalZernioCalendarCommandFailure {
  if (error instanceof InactivePortalSessionError) return failed('unauthenticated');
  const code = postgresCode(error);
  if (code === '42501') return failed('forbidden');
  if (code === '40001' || code === '23505') return failed('conflict');
  if (code === '22023' || code === '23514' || code === '23503') {
    return failed('validation');
  }
  return failed('unavailable');
}

function canonicalUtcInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
}

function validCommand(input: PortalZernioCalendarCommandInput): boolean {
  const prototype = Object.getPrototypeOf(input) as unknown;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Object.keys(input).sort();
  if ((prototype !== Object.prototype && prototype !== null)
      || Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)
      || keys.length !== COMMAND_KEYS.length
      || keys.some((key, index) => key !== COMMAND_KEYS[index])) {
    return false;
  }
  return NETWORKS.has(input.network)
    && UUID.test(input.planningIntentId)
    && UUID.test(input.planningTargetId)
    && UUID.test(input.contentItemId)
    && UUID.test(input.contentVersionId)
    && UUID.test(input.approvalRequestId)
    && UUID.test(input.approvalDecisionId)
    && UUID.test(input.sourceAttestationId)
    && OPERATION_TAG.test(input.operationTag)
    && canonicalUtcInstant(input.scheduledFor);
}

export class PgPortalZernioCalendarCommandService
implements PortalZernioCalendarCommandService {
  readonly configuredNetworks: readonly PortalZernioCalendarNetwork[];
  readonly #principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly #commandPool: Pick<Pool, 'connect'>;
  readonly #workspaceId: string;
  readonly #providerConnectionId: string;
  readonly #providerProfileIdSha256: Buffer;
  readonly #accountSha256ByNetwork: ReadonlyMap<PortalZernioCalendarNetwork, Buffer>;
  readonly #providerAccountIdByNetwork: ReadonlyMap<PortalZernioCalendarNetwork, string>;
  readonly #postingClient: Pick<ZernioPostingClient, 'schedule'>;

  constructor(dependencies: PgPortalZernioCalendarCommandDependencies) {
    if (!UUID.test(dependencies.workspaceId)
        || !UUID.test(dependencies.providerConnectionId)
        || !PROVIDER_REFERENCE.test(dependencies.providerProfileId)
        || dependencies.accounts.length < 1
        || dependencies.accounts.length > 2) {
      throw new Error('Zernio calendar command configuration is invalid');
    }
    const accountDigests = new Map<PortalZernioCalendarNetwork, Buffer>();
    const accountIds = new Map<PortalZernioCalendarNetwork, string>();
    for (const account of dependencies.accounts) {
      if (!NETWORKS.has(account.network)
          || !PROVIDER_REFERENCE.test(account.providerAccountId)
          || accountDigests.has(account.network)) {
        throw new Error('Zernio calendar account configuration is invalid');
      }
      accountDigests.set(account.network, sha256(account.providerAccountId));
      accountIds.set(account.network, account.providerAccountId);
    }

    // Store only non-secret UUIDs and one-way digests. In particular, do not
    // retain `dependencies`, which contains the clear configured references.
    this.#principalResolver = dependencies.principalResolver;
    this.#commandPool = dependencies.commandPool;
    this.#workspaceId = dependencies.workspaceId;
    this.#providerConnectionId = dependencies.providerConnectionId;
    this.#providerProfileIdSha256 = sha256(dependencies.providerProfileId);
    this.#accountSha256ByNetwork = accountDigests;
    this.#providerAccountIdByNetwork = accountIds;
    this.#postingClient = dependencies.postingClient ?? Object.freeze({
      async schedule(): Promise<never> {
        throw new ZernioPostingError('invalid_configuration');
      },
    });
    this.configuredNetworks = Object.freeze([...accountDigests.keys()].sort());
  }

  async scheduleDirect(
    identity: PortalCrmRequestIdentity,
    input: PortalZernioDirectScheduleInput,
  ): Promise<PortalZernioDirectScheduleResult> {
    if (Object.getPrototypeOf(input) !== Object.prototype
        || Object.keys(input).sort().join(',') !== 'commandKey,content,network,scheduledFor'
        || input.network !== 'linkedin'
        || typeof input.content !== 'string' || input.content.trim() !== input.content
        || Buffer.byteLength(input.content, 'utf8') < 1
        || Buffer.byteLength(input.content, 'utf8') > 12_000
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(input.content)
        || !canonicalUtcInstant(input.scheduledFor)
        || !/^[!-~]{8,200}$/u.test(input.commandKey)) return failed('validation');
    const accountDigest = this.#accountSha256ByNetwork.get('linkedin');
    const accountId = this.#providerAccountIdByNetwork.get('linkedin');
    if (!accountDigest || !accountId) return failed('validation');
    try {
      const context = await this.#context(identity);
      if (!context) return failed('unauthenticated');
      const reserved = await withTransaction(this.#commandPool, context, async (client) => {
        const result = await client.query<DirectReserveRow>(
          `/* portal.zernio-calendar.reserve-direct */
           SELECT schedule_id::text, current_state, provider_external_id,
             scheduled_for::text, created_now
           FROM app_private.reserve_zernio_direct_schedule(
             $1::uuid,$2::uuid,$3::text,$4::bytea,$5::text,$6::timestamptz,$7::text
           )`,
          [this.#workspaceId, this.#providerConnectionId, 'linkedin', accountDigest, input.content,
            input.scheduledFor, input.commandKey],
        );
        const row = result.rows[0];
        if (result.rows.length !== 1 || !row || typeof row.schedule_id !== 'string'
            || !UUID.test(row.schedule_id) || typeof row.current_state !== 'string'
            || typeof row.scheduled_for !== 'string' || !canonicalUtcInstant(row.scheduled_for)
            || typeof row.created_now !== 'boolean') throw new Error('Invalid direct reserve result');
        return row;
      }, { isolation: 'serializable' });
      if (!reserved.created_now) {
        if (reserved.current_state === 'scheduled'
            && typeof reserved.provider_external_id === 'string') {
          return Object.freeze({ ok: true, scheduleId: reserved.schedule_id as string,
            providerPostId: reserved.provider_external_id, scheduledFor: reserved.scheduled_for as string,
            disposition: 'replayed' as const });
        }
        return failed('conflict');
      }

      let outcome: 'scheduled' | 'failed' | 'outcome_unknown' = 'scheduled';
      let providerPostId: string | null = null;
      let receiptSha256: string;
      let safeCode = 'scheduled';
      try {
        const provider = await this.#postingClient.schedule({
          requestId: reserved.schedule_id as string,
          content: input.content,
          targets: Object.freeze([{ network: 'linkedin', accountId }]),
          scheduledFor: input.scheduledFor,
        });
        if (provider.status !== 'scheduled' || provider.platforms.length !== 1
            || provider.platforms[0]?.network !== 'linkedin'
            || provider.platforms[0].accountId !== accountId) {
          throw new ZernioPostingError('invalid_provider_response');
        }
        providerPostId = provider.providerPostId;
        receiptSha256 = provider.responseSha256;
      } catch (error) {
        const providerCode = error instanceof ZernioPostingError ? error.code : 'outcome_unknown';
        outcome = providerCode === 'outcome_unknown' ? 'outcome_unknown' : 'failed';
        safeCode = `zernio.${providerCode}`;
        receiptSha256 = createHash('sha256').update(
          `propertypredator.zernio-direct-calendar/failure/v1|${reserved.schedule_id as string}|${safeCode}`,
          'utf8',
        ).digest('hex');
      }
      const providerOccurredAt = new Date().toISOString();
      await withTransaction(this.#commandPool, context, async (client) => {
        const result = await client.query<{ disposition: unknown }>(
          `/* portal.zernio-calendar.settle-direct */
           SELECT app_private.settle_zernio_direct_schedule(
             $1::uuid,$2::uuid,$3::text,$4::text,$5::bytea,$6::text,$7::timestamptz
           ) AS disposition`,
          [this.#workspaceId, reserved.schedule_id, outcome, providerPostId,
            Buffer.from(receiptSha256, 'hex'), safeCode, providerOccurredAt],
        );
        if (!['applied', 'replayed'].includes(String(result.rows[0]?.disposition))) {
          throw new Error('Invalid direct settlement result');
        }
      }, { isolation: 'serializable' });
      if (outcome !== 'scheduled' || !providerPostId) {
        return failed(outcome === 'outcome_unknown' ? 'conflict' : 'unavailable');
      }
      return Object.freeze({ ok: true, scheduleId: reserved.schedule_id as string,
        providerPostId, scheduledFor: reserved.scheduled_for as string,
        disposition: 'applied' as const });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async listDirect(
    identity: PortalCrmRequestIdentity,
    input: Readonly<{ from: string; to: string }>,
  ): Promise<PortalZernioDirectScheduleListResult> {
    if (Object.getPrototypeOf(input) !== Object.prototype
        || Object.keys(input).sort().join(',') !== 'from,to'
        || !canonicalUtcInstant(input.from) || !canonicalUtcInstant(input.to)
        || input.from >= input.to) return failed('validation');
    try {
      const context = await this.#context(identity);
      if (!context) return failed('unauthenticated');
      const items = await withTransaction(this.#commandPool, context, async (client) => {
        const result = await client.query<DirectListRow>(
          `/* portal.zernio-calendar.list-direct */
           SELECT schedule_id::text, network, content_body, scheduled_for::text,
             state, provider_external_id, safe_code
           FROM app_private.list_zernio_direct_schedules($1::uuid,$2::timestamptz,$3::timestamptz,100)`,
          [this.#workspaceId, input.from, input.to],
        );
        return result.rows.map((row) => {
          if (typeof row.schedule_id !== 'string' || !UUID.test(row.schedule_id)
              || row.network !== 'linkedin' || typeof row.content_body !== 'string'
              || typeof row.scheduled_for !== 'string' || !canonicalUtcInstant(row.scheduled_for)
              || !['reserved', 'scheduled', 'failed', 'outcome_unknown', 'cancelled'].includes(String(row.state))
              || (row.provider_external_id !== null && typeof row.provider_external_id !== 'string')
              || (row.safe_code !== null && (typeof row.safe_code !== 'string' || !SAFE_CODE.test(row.safe_code)))) {
            throw new Error('Invalid direct calendar row');
          }
          return Object.freeze({ scheduleId: row.schedule_id as string, network: 'linkedin' as const,
            content: row.content_body, scheduledFor: row.scheduled_for as string,
            state: row.state as 'reserved' | 'scheduled' | 'failed' | 'outcome_unknown' | 'cancelled',
            providerPostId: row.provider_external_id as string | null,
            safeCode: row.safe_code as string | null });
        });
      });
      return Object.freeze({ ok: true, items: Object.freeze(items) });
    } catch (error) {
      return mapFailure(error);
    }
  }

  async #context(identity: PortalCrmRequestIdentity): Promise<DatabaseRequestContext | null> {
    const principal = await this.#principalResolver.resolve(identity.sessionToken);
    if (!principal || principal.workspaceId !== this.#workspaceId) return null;
    return requestDatabaseContext({
      ...principal,
      requestId: identity.requestId,
      portalSessionTokenHash: sha256(identity.sessionToken),
    });
  }

  async stage(
    identity: PortalCrmRequestIdentity,
    input: PortalZernioCalendarCommandInput,
  ): Promise<PortalZernioCalendarCommandResult> {
    if (!validCommand(input)) return failed('validation');
    const accountSha256 = this.#accountSha256ByNetwork.get(input.network);
    if (!accountSha256) return failed('validation');

    try {
      const context = await this.#context(identity);
      if (!context) return failed('unauthenticated');
      const row = await withTransaction(
        this.#commandPool,
        context,
        async (client) => {
          const result = await client.query<CommandRow>(
            `/* portal.zernio-calendar.stage */
             SELECT
               job_id::text,
               encode(idempotency_key_sha256, 'hex') AS idempotency_key_sha256,
               daily_publish_cap,
               monthly_publish_cap
             FROM app_private.enqueue_zernio_calendar_from_connected_account(
               $1::uuid,$2::uuid,$3::text,$4::bytea,$5::bytea,$6::uuid,$7::uuid,
               $8::uuid,$9::uuid,$10::uuid,$11::uuid,$12::uuid,$13::text,$14::timestamptz
             )`,
            [
              this.#workspaceId,
              this.#providerConnectionId,
              input.network,
              this.#providerProfileIdSha256,
              accountSha256,
              input.planningIntentId.toLowerCase(),
              input.planningTargetId.toLowerCase(),
              input.contentItemId.toLowerCase(),
              input.contentVersionId.toLowerCase(),
              input.approvalRequestId.toLowerCase(),
              input.approvalDecisionId.toLowerCase(),
              input.sourceAttestationId.toLowerCase(),
              input.operationTag,
              input.scheduledFor,
            ],
          );
          const selected = result.rows[0];
          if (result.rows.length !== 1 || !selected
              || typeof selected.job_id !== 'string' || !UUID.test(selected.job_id)
              || typeof selected.idempotency_key_sha256 !== 'string'
              || !SHA256.test(selected.idempotency_key_sha256)
              || Number(selected.daily_publish_cap) !== 1
              || Number(selected.monthly_publish_cap) !== 3) {
            throw new Error('Invalid Zernio calendar command result');
          }
          return Object.freeze({
            jobId: selected.job_id,
            idempotencyKeySha256: selected.idempotency_key_sha256,
          });
        },
        { isolation: 'serializable' },
      );
      return Object.freeze({
        ok: true,
        jobId: row.jobId,
        idempotencyKeySha256: row.idempotencyKeySha256,
        caps: Object.freeze({ daily: 1, monthly: 3 }),
        providerEffects: 'none',
        workerLeaseClaimed: false,
      });
    } catch (error) {
      return mapFailure(error);
    }
  }
}

export function createPgPortalZernioCalendarCommandService(input: Readonly<{
  webPool: Pool;
  commandPool: Pool;
  workspaceId: string;
  providerConnectionId: string;
  providerProfileId: string;
  accounts: readonly PortalZernioCalendarConfiguredAccount[];
  postingClient: Pick<ZernioPostingClient, 'schedule'>;
}>): PgPortalZernioCalendarCommandService {
  return new PgPortalZernioCalendarCommandService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    commandPool: input.commandPool,
    workspaceId: input.workspaceId,
    providerConnectionId: input.providerConnectionId,
    providerProfileId: input.providerProfileId,
    accounts: input.accounts,
    postingClient: input.postingClient,
  });
}
