import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  PortalAbuseAdmission,
  PortalAbuseDecision,
  PortalAbuseGuard,
  PortalAbuseOutcome,
} from './abuse.js';

interface AdmissionRow {
  allowed: boolean;
  retry_after_seconds: number;
  lease_hash: Buffer | null;
}

interface ReadyRow {
  ready: boolean;
}

interface CompleteRow {
  completed: boolean;
}

/**
 * Thin function-only adapter. Policy and HMAC derivation remain in the portal;
 * PostgreSQL receives only fixed labels, integer bounds and 32-byte evidence.
 */
export class PgPortalAbuseGuard implements PortalAbuseGuard {
  readonly #pool: Pick<Pool, 'query' | 'end'>;
  readonly #ownsPool: boolean;
  #closed = false;

  constructor(pool: Pick<Pool, 'query' | 'end'>, options: { ownsPool?: boolean } = {}) {
    this.#pool = pool;
    this.#ownsPool = options.ownsPool === true;
  }

  async admit(input: PortalAbuseAdmission): Promise<PortalAbuseDecision> {
    if (this.#closed) throw new Error('Portal abuse guard is closed');
    if (input.dimensions.length < 1 || input.dimensions.length > 9
        || input.requestHash.length !== 32
        || !Number.isSafeInteger(input.cost) || input.cost < 1) {
      throw new Error('Portal abuse admission is invalid');
    }
    const leaseHash = randomBytes(32);
    const result = await this.#pool.query<AdmissionRow>(
      `/* portal.abuse-admit */
       SELECT allowed, retry_after_seconds, lease_hash
       FROM app_private.admit_portal_abuse(
         $1::text, $2::text[], $3::bytea[], $4::integer[], $5::integer[],
         $6::integer[], $7::integer[], $8::bytea, $9::bytea
       )`,
      [
        input.routeClass,
        input.dimensions.map(({ name }) => name),
        input.dimensions.map(({ subjectHash }) => subjectHash),
        input.dimensions.map(({ capacity }) => capacity),
        input.dimensions.map(({ windowSeconds }) => windowSeconds),
        input.dimensions.map(() => input.cost),
        input.dimensions.map(({ maxConcurrency }) => maxConcurrency),
        leaseHash,
        input.requestHash,
      ],
    );
    if (result.rows.length !== 1) throw new Error('Portal abuse admission returned an invalid result');
    const row = result.rows[0]!;
    if (row.allowed === true) {
      if (row.retry_after_seconds !== 0 || !Buffer.isBuffer(row.lease_hash)
          || row.lease_hash.length !== 32 || !timingSafeEqual(row.lease_hash, leaseHash)) {
        throw new Error('Portal abuse admission returned invalid allowed evidence');
      }
      return Object.freeze({ allowed: true, retryAfterSeconds: 0, leaseHash: row.lease_hash });
    }
    if (row.allowed !== false || row.lease_hash !== null
        || !Number.isSafeInteger(row.retry_after_seconds)
        || row.retry_after_seconds < 1 || row.retry_after_seconds > 86_400) {
      throw new Error('Portal abuse admission returned invalid denial evidence');
    }
    return Object.freeze({
      allowed: false,
      retryAfterSeconds: row.retry_after_seconds,
      leaseHash: null,
    });
  }

  async complete(leaseHash: Buffer, outcome: PortalAbuseOutcome): Promise<void> {
    if (this.#closed) return;
    if (!Buffer.isBuffer(leaseHash) || leaseHash.length !== 32
        || !['success', 'auth_failure', 'service_error'].includes(outcome)) {
      throw new Error('Portal abuse completion is invalid');
    }
    const result = await this.#pool.query<CompleteRow>(
      `/* portal.abuse-complete */
       SELECT app_private.complete_portal_abuse_lease($1::bytea, $2::text) AS completed`,
      [leaseHash, outcome],
    );
    if (result.rows.length !== 1 || result.rows[0]?.completed !== true) {
      throw new Error('Portal abuse completion returned an invalid result');
    }
  }

  async assertReady(): Promise<void> {
    if (this.#closed) throw new Error('Portal abuse guard is closed');
    const result = await this.#pool.query<ReadyRow>(
      `/* portal.abuse-runtime-readiness */
       SELECT app_private.portal_abuse_ready() AS ready`,
    );
    if (result.rows.length !== 1 || result.rows[0]?.ready !== true) {
      throw new Error('Portal abuse guard is not ready');
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsPool) await this.#pool.end();
  }
}
