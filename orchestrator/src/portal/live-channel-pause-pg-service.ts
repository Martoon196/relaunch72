import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { requestDatabaseContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import type {
  PortalLiveChannelPauseOutcome,
  PortalLiveChannelPauseScope,
  PortalLiveChannelPauseService,
} from './live-channel-pause-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SCOPES = new Set<PortalLiveChannelPauseScope>([
  'all', 'customer_email', 'owned_social', 'whatsapp', 'sms', 'social_dm',
]);

interface PauseRow extends QueryResultRow { readonly disposition: unknown }

function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : null;
}

function failed(kind: Extract<PortalLiveChannelPauseOutcome, { ok: false }>['kind']):
Extract<PortalLiveChannelPauseOutcome, { ok: false }> {
  return Object.freeze({ ok: false, kind });
}

export class PgPortalLiveChannelPauseService implements PortalLiveChannelPauseService {
  constructor(private readonly dependencies: Readonly<{
    principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
    commandPool: Pick<Pool, 'connect'>;
  }>) {}

  async engage(
    identity: PortalCrmRequestIdentity,
    input: Readonly<{ scope: PortalLiveChannelPauseScope; commandKey: string }>,
  ): Promise<PortalLiveChannelPauseOutcome> {
    if (!SCOPES.has(input.scope) || !UUID.test(input.commandKey)) return failed('validation');
    try {
      const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
      if (!principal) return failed('unauthenticated');
      const context = requestDatabaseContext({ ...principal, requestId: identity.requestId,
        portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest() });
      const disposition = await withTransaction(this.dependencies.commandPool, context,
        async (client) => {
          const result = await client.query<PauseRow>(
            `/* portal.live-channels.engage-emergency-pause */
             SELECT app_private.engage_property_predator_live_channel_pause(
               $1::uuid, $2::bytea, $3::text, $4::uuid
             ) AS disposition`,
            [context.workspaceId, context.portalSessionTokenHash, input.scope,
              input.commandKey.toLowerCase()],
          );
          if (result.rows.length !== 1
              || (result.rows[0]!.disposition !== 'engaged'
                && result.rows[0]!.disposition !== 'replayed')) {
            throw new Error('Live channel pause returned invalid evidence');
          }
          return result.rows[0]!.disposition;
        }, { isolation: 'serializable' });
      return Object.freeze({ ok: true, disposition, scope: input.scope });
    } catch (error) {
      if (error instanceof InactivePortalSessionError) return failed('unauthenticated');
      const code = postgresCode(error);
      if (code === '42501') return failed('forbidden');
      if (code === '22023' || code === '23514' || code === '40001') return failed('validation');
      return failed('unavailable');
    }
  }
}

export function createPgPortalLiveChannelPauseService(input: Readonly<{
  webPool: Pool;
  crmCommandPool: Pool;
}>): PgPortalLiveChannelPauseService {
  return new PgPortalLiveChannelPauseService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    commandPool: input.crmCommandPool,
  });
}
