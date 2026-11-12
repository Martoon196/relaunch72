import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import type { FollowupRunState } from '../followup-sequences/state.js';
import { FlowWorkspaceError } from '../followup-sequences/workspace.js';

/** The workspace every 0152 table and function is pinned to. */
export const PP_FOLLOWUP_WORKSPACE_ID = 'd975ff66-336a-46c2-b36b-d7095a11af97';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;
const time = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value));

export interface PpFollowupRun {
  readonly id: string; readonly contentItemId: string; readonly contentVersionId: string; readonly contactId: string; readonly contactPointId: string;
  readonly email: string; readonly displayName: string; readonly state: FollowupRunState; readonly position: number; readonly dueAt: string;
  readonly reason: string | null; readonly createdAt: string; readonly lastAcceptedAt: string | null; readonly inFlight: boolean; readonly unknownProofId: string | null;
  readonly steps: readonly { position: number; acceptedAt: string | null; dueAt: string; expiresAt: string; cancelled: boolean; failed: boolean; held: boolean; inFlight: boolean }[];
}
export interface PpFollowupContact { readonly contactId: string; readonly contactPointId: string; readonly displayName: string; readonly email: string; readonly inOpenRun: boolean }
export interface PpFollowupDatabaseSnapshot { readonly campaign: string; readonly permitted: number; readonly contacts: readonly PpFollowupContact[];
  readonly runs: readonly PpFollowupRun[]; readonly runCount: number }
export type PpFollowupAction = 'enrol' | 'pause' | 'resume' | 'cancel' | 'stop';
export interface PpFollowupCommand { readonly action: PpFollowupAction; readonly commandId: string; readonly itemId: string; readonly versionId: string;
  readonly contactPointId: string; readonly runId: string; readonly ackProofId: string }
export interface PpFollowupCommandResult { readonly action: PpFollowupAction; readonly contentItemId: string; readonly contentVersionId: string;
  readonly changed: number; readonly remaining: number; readonly blocked: number; readonly inFlight: number;
  readonly reason: 'not_permitted' | 'already_enrolled' | 'older_version_open' | null; readonly replayed: boolean }
export interface PpFollowupRepository {
  snapshot(identity: PortalSessionIdentity): Promise<PpFollowupDatabaseSnapshot>;
  command(identity: PortalSessionIdentity, input: PpFollowupCommand & { requestId: string }): Promise<PpFollowupCommandResult>;
}
export interface PpFollowupUnsubscriber { unsubscribe(contactPointId: string): Promise<{ known: boolean; recorded: boolean; stopped: number }> }

function failure(error: unknown): never {
  if (error instanceof FlowWorkspaceError) throw error;
  const code = (error as { code?: string })?.code;
  if (code === '42501') throw new FlowWorkspaceError(403, 'Open the Property Predator workspace with an owner or admin account.');
  if (['23514', '23505', '40001'].includes(code ?? '')) throw new FlowWorkspaceError(409, 'The flow, its messages or their approval changed. Refresh before continuing.');
  if (code === '22023') throw new FlowWorkspaceError(400, 'Check the flow and the selected action.');
  throw new FlowWorkspaceError(503, 'PP follow-up delivery controls are temporarily unavailable.');
}
const RUN_STATES = ['active', 'paused', 'held', 'completed', 'stopped', 'cancelled', 'failed'];
export function parsePpFollowupSnapshot(value: unknown): PpFollowupDatabaseSnapshot {
  if (!record(value) || value.campaign !== 'pp-owner-followup' || !count(value.permitted) || !count(value.runCount)
      || !Array.isArray(value.contacts) || value.contacts.length > 200 || !Array.isArray(value.runs) || value.runs.length > 100
      || value.contacts.some(c => !record(c) || !uuid(c.contactId) || !uuid(c.contactPointId) || typeof c.displayName !== 'string'
        || typeof c.email !== 'string' || typeof c.inOpenRun !== 'boolean')
      || value.runs.some(r => !record(r) || !uuid(r.id) || !uuid(r.contentItemId) || !uuid(r.contentVersionId) || !uuid(r.contactId) || !uuid(r.contactPointId)
        || typeof r.email !== 'string' || typeof r.displayName !== 'string' || !RUN_STATES.includes(String(r.state)) || !count(r.position)
        || !time(r.dueAt) || !time(r.createdAt) || !(r.lastAcceptedAt === null || time(r.lastAcceptedAt)) || typeof r.inFlight !== 'boolean'
        || !(r.reason === null || typeof r.reason === 'string') || !(r.unknownProofId === null || uuid(r.unknownProofId)) || !Array.isArray(r.steps)))
    throw new Error('Invalid PP follow-up snapshot');
  return value as unknown as PpFollowupDatabaseSnapshot;
}

/** Owner reads through r72_web and owner commands through r72_identity_command; both authorise the session in SQL. */
export class PgPpFollowupRepository implements PpFollowupRepository, PpFollowupUnsubscriber {
  constructor(private readonly web: Pick<Pool, 'query'>, private readonly commands: Pick<Pool, 'query'>) {}
  private token(identity: PortalSessionIdentity): Buffer {
    if (identity.workspaceId !== PP_FOLLOWUP_WORKSPACE_ID || !identity.sessionToken) throw new FlowWorkspaceError(403, 'Open the Property Predator workspace first.');
    return createHash('sha256').update(identity.sessionToken).digest();
  }
  async snapshot(identity: PortalSessionIdentity): Promise<PpFollowupDatabaseSnapshot> {
    try {
      const result = await this.web.query<{ value: unknown }>('SELECT app_private.pp_followup_snapshot($1) AS value', [this.token(identity)]);
      return parsePpFollowupSnapshot(result.rows[0]?.value);
    } catch (error) { return failure(error); }
  }
  async command(identity: PortalSessionIdentity, input: PpFollowupCommand & { requestId: string }): Promise<PpFollowupCommandResult> {
    try {
      const result = await this.commands.query<{ value: PpFollowupCommandResult }>('SELECT app_private.pp_followup_command($1,$2,$3,$4,$5,$6,$7,$8) AS value',
        [this.token(identity), input.action, input.commandId, input.versionId, input.contactPointId || null, input.runId || null, input.ackProofId || null, input.requestId]);
      const value = result.rows[0]?.value;
      if (!value || value.action !== input.action || value.contentItemId !== input.itemId || value.contentVersionId !== input.versionId
          || ![value.changed, value.remaining, value.blocked, value.inFlight].every(count) || typeof value.replayed !== 'boolean'
          || ![null, 'not_permitted', 'already_enrolled', 'older_version_open'].includes(value.reason)) throw new Error('Invalid PP follow-up command result');
      return value;
    } catch (error) { return failure(error); }
  }
  async unsubscribe(contactPointId: string): Promise<{ known: boolean; recorded: boolean; stopped: number }> {
    if (!uuid(contactPointId)) throw new Error('Invalid unsubscribe subject');
    const result = await this.commands.query<{ value: { known?: unknown; recorded?: unknown; stopped?: unknown } }>('SELECT app_private.pp_followup_unsubscribe($1) AS value', [contactPointId]);
    const value = result.rows[0]?.value;
    if (!value || typeof value.known !== 'boolean' || typeof value.recorded !== 'boolean' || !count(value.stopped)) throw new Error('Invalid unsubscribe result');
    return { known: value.known, recorded: value.recorded, stopped: Number(value.stopped) };
  }
}

export interface PpFollowupLease { readonly id: string; readonly leaseId: string; readonly leaseUntil: string }
export interface PpFollowupPrepared {
  readonly id: string; readonly leaseId: string; readonly leaseUntil: string; readonly proofId: string; readonly runId: string; readonly step: number;
  readonly contactPointId: string; readonly email: string; readonly displayName: string | null; readonly contentVersionId: string;
  readonly canonicalContent: string; readonly contentSha256: string;
}
export interface PpFollowupQueue {
  claim(limit: number, leaseSeconds: number, onlyEmails: readonly string[] | null): Promise<readonly PpFollowupLease[]>;
  prepare(lease: PpFollowupLease): Promise<PpFollowupPrepared | null>;
  settle(lease: PpFollowupLease, accepted: boolean, reference: string | null): Promise<void>;
  unknown(lease: PpFollowupLease): Promise<void>;
}
export function parsePpFollowupLeases(jobs: unknown, limit: number): readonly PpFollowupLease[] {
  if (!Array.isArray(jobs) || jobs.length > limit || !jobs.every(job => record(job) && uuid(job.id) && uuid(job.leaseId) && time(job.leaseUntil))) throw new Error('Invalid PP follow-up lease batch');
  return jobs as PpFollowupLease[];
}
export function parsePpFollowupPrepared(value: unknown, lease: PpFollowupLease): PpFollowupPrepared | null {
  if (value === null || value === undefined) return null;
  if (!record(value) || value.id !== lease.id || value.leaseId !== lease.leaseId || !uuid(value.proofId) || !uuid(value.runId) || !count(value.step)
      || !time(value.leaseUntil) || Date.parse(String(value.leaseUntil)) !== Date.parse(lease.leaseUntil) || !uuid(value.contactPointId)
      || typeof value.email !== 'string' || !(value.displayName === null || typeof value.displayName === 'string') || !uuid(value.contentVersionId)
      || typeof value.canonicalContent !== 'string' || typeof value.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.contentSha256))
    throw new Error('Invalid PP follow-up dispatch proof');
  return value as unknown as PpFollowupPrepared;
}
/** Table-blind dispatch capabilities on the r72_identity_command identity; never an owner context. */
export class PgPpFollowupQueue implements PpFollowupQueue {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}
  async claim(limit: number, leaseSeconds: number, onlyEmails: readonly string[] | null) {
    const result = await this.pool.query<{ jobs: unknown }>('SELECT app_private.pp_followup_claim($1,$2,$3) AS jobs', [limit, leaseSeconds, onlyEmails ? [...onlyEmails] : null]);
    return parsePpFollowupLeases(result.rows[0]?.jobs, limit);
  }
  async prepare(lease: PpFollowupLease) {
    const result = await this.pool.query<{ prepared: unknown }>('SELECT app_private.pp_followup_prepare($1,$2) AS prepared', [lease.id, lease.leaseId]);
    return parsePpFollowupPrepared(result.rows[0]?.prepared, lease);
  }
  async settle(lease: PpFollowupLease, accepted: boolean, reference: string | null) {
    await this.pool.query('SELECT app_private.pp_followup_settle($1,$2,$3,$4)', [lease.id, lease.leaseId, accepted, reference]);
  }
  async unknown(lease: PpFollowupLease) { await this.pool.query('SELECT app_private.pp_followup_unknown($1,$2)', [lease.id, lease.leaseId]); }
}
