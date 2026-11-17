/**
 * "Before You Buy" book sign-ups into the MHP brand CRM (workspace "Martin Howard Property · Marketing").
 *
 * Every book sign-up is first committed exactly as before by the public form (app_private.mhp_capture_signup_v3). Then,
 * best-effort and never in the visitor's way, it is copied into the CRM through the CRM's own command (crm.createLead),
 * the same command and "New enquiry" lookup the webinar import uses (./signup-leads.ts):
 *   - a contact (name; the email address, never marked verified; marketing permission recorded from the sign-up),
 *   - an enquiry "Before You Buy book enquiry · <name>" in the default enquiries pipeline's first open stage,
 *   - one open task "Follow up Before You Buy book enquiry", due in one working day, assigned to the lead owner,
 *   - the mobile number as an unverified phone point when one was given and no other contact already has it,
 *   - the sign-up evidence on the contact (custom field mhpSignup) and one timeline entry (activity mhp.book.signup).
 *
 * Who acts: the MHP brand's configured lead owner, the same user the Group HQ inbox bridge and the LeadRelay feed
 * create MHP enquiries as (R72_GROUP_HQ_INBOX_SCOPES "mhp" ownerUserId, re-checked in every transaction with
 * can_manage_workspace). Without that setting the automatic copy is off and an owner's own visit or button press brings
 * the sign-ups in, acting as that owner (the webinar import's rule).
 *
 * One book enquiry per contact, ever: under the same per-email advisory lock the 17 Nov 2026 trigger takes, a contact
 * with this email that already has a book enquiry (by name, by the trigger's "Book signup received" stage history, by
 * our own timeline entry or by our own receipt) is never given a second one, and its stage, owner and tasks are never
 * touched. Only what the trigger skipped is filled in: phone point, marketing permission (only from "unknown", or an
 * unsubscribe turning "opted in" into "opted out"), sign-up evidence. Several records with the same email, or one that is
 * archived, deleted, shared or quarantined, are skipped and reported for the owner. Addresses ending ".invalid" are
 * skipped. Nothing here sends, queues or enrols anything, and no consent ledger event is written.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import { CrmCommandService } from '../crm-pg/commands.js';
import { CrmPgRepository } from '../crm-pg/repository.js';
import type { CreateLeadResult, CrmTransactionRunner, SqlExecutor } from '../crm-pg/types.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import { MHP_BOOK_INTEREST_LABEL } from './book-interest.js';
import { MHP_CONSENT_VERSION, type MhpCapturedSignup, type MhpRegistrantRecord, type MhpSignup } from './growth-service.js';
import { MHP_MARKETING_WORKSPACE_ID } from './marketing-workspace-service.js';
import { createOrReplaySignupLead, newEnquiryStage, readSignupLeadCursor, signSignupLeadCursor, SIGNUP_LEAD_BATCH_SIZE,
  SIGNUP_LEAD_UUID, type SignupLeadAudience } from './signup-leads.js';

export const MHP_BOOK_MODULE = 'book-before-you-buy';
export const MHP_BOOK_SOURCE = 'mhp:book-before-you-buy';
export const MHP_BOOK_ENQUIRY_PREFIX = 'Before You Buy book enquiry';
export const MHP_BOOK_TASK_TITLE = 'Follow up Before You Buy book enquiry';
export const MHP_BOOK_ACTIVITY = 'mhp.book.signup';
/** The stage-history note the 17 Nov 2026 trigger wrote on each enquiry it made. */
export const MHP_BOOK_TRIGGER_NOTE = 'Book signup received';
const AUDIENCE: SignupLeadAudience = { tag: 'book', cursorDomain: 'mhp.book-import.cursor.v1', cursorScope: MHP_BOOK_MODULE,
  refreshMessage: 'Refresh the book sign-up import before continuing.' };

/** Exactly the sign-ups the public book form sends (and exactly what the 17 Nov 2026 trigger reacted to). */
export function isBookSignup(signup: Pick<MhpSignup, 'kind' | 'label' | 'module'>): boolean {
  return signup.kind === 'waitlist' && signup.label === MHP_BOOK_INTEREST_LABEL && signup.module === MHP_BOOK_MODULE;
}

/** One book sign-up as it reaches the CRM. `recordedFrom` says where the evidence came from. */
export interface MhpBookLeadCandidate {
  prospectId: string;
  signupId: string | null;
  email: string;
  firstName: string | null;
  /** Unverified mobile number as typed; never a verified number. */
  phone: string | null;
  /** The sign-up's own tick-box (null when only the owner list was available). */
  consentGiven: boolean | null;
  consentVersion: string | null;
  /** "Tips emails: Yes" — ticked and not unsubscribed. */
  marketingEmails: boolean;
  label: string;
  module: string | null;
  link: string | null;
  signedUpAt: string;
  recordedFrom: 'sign-up' | 'owner-list';
}

export type MhpBookLeadOutcome =
  | { outcome: 'created' | 'enriched' | 'present'; contactId: string; opportunityId: string | null; phone: 'added' | 'present' | 'other_contact' | 'none' }
  | { outcome: 'skipped'; reason: MhpBookSkipReason };
export type MhpBookSkipReason = 'test_address' | 'several_contacts' | 'archived_contact' | 'deleted_contact' | 'shared_contact' | 'contact_without_email';

export type MhpBookLeadStatus =
  | { state: 'in_leads'; contactId: string; opportunityId: string | null; stage: string | null; status: string | null; complete: boolean }
  | { state: 'not_yet' }
  | { state: 'needs_you'; reason: MhpBookSkipReason };
export interface MhpBookLeadStatuses { available: boolean; byProspect: ReadonlyMap<string, MhpBookLeadStatus>; inLeads: number; total: number }

export interface MhpBookLeadBatch { added: number; alreadyIn: number; completed: number; needYou: number; failed: boolean; processed: number; hasMore: boolean; cursor: string | null }

export const MHP_BOOK_SKIP_TEXT: Readonly<Record<MhpBookSkipReason, string>> = Object.freeze({
  test_address: 'Test address, not copied.',
  several_contacts: 'More than one record in Leads has this email. Merge them, then bring book sign-ups in again.',
  archived_contact: 'The record in Leads with this email is archived. Restore it to add the book enquiry.',
  deleted_contact: 'A deleted record in Leads still holds this email. Restore or remove it first.',
  shared_contact: 'This email is marked shared or held for review in Leads. Resolve it first.',
  contact_without_email: 'The book lead made earlier no longer has this email address. Check it in Leads.',
});

const normalEmail = (value: string): string => value.trim().toLowerCase();
/** The CRM command's own phone normalisation, so a match means the same thing in both places. */
export function bookLeadPhone(value: string | null): string | null {
  let number = (value ?? '').trim().replace(/[\s().-]/gu, '');
  if (number.startsWith('00')) number = `+${number.slice(2)}`;
  return /^\+?\d{7,15}$/u.test(number) ? number : null;
}

/**
 * The task text, in plain words: what they asked for, their mobile if they gave one (the form promises a quick call to
 * anyone who adds it) and whether they may be sent marketing emails.
 */
export function bookTaskDescription(candidate: Pick<MhpBookLeadCandidate, 'marketingEmails' | 'phone'>): string {
  const typed = (candidate.phone ?? '').trim().slice(0, 40);
  const mobile = !typed ? 'No mobile given.'
    : bookLeadPhone(typed) ? `Mobile: ${typed} (they asked for a call). The number has not been checked.`
      : `Mobile: ${typed} (they asked for a call, but this does not look like a complete number). The number has not been checked.`;
  return ['Registered interest in the book Before You Buy on the book page: asked for Chapter One and the launch updates.'
    + (typed ? ' Added a mobile for a quick call about the book and the property they are looking at.' : ''),
  mobile,
  candidate.marketingEmails ? 'Marketing emails: yes (they ticked the box on the form).' : 'Marketing emails: no. Contact them about the book only.'].join('\n');
}

/** One working day after `now` (Saturday and Sunday move to Monday, UK calendar; bank holidays are not known here). */
export function bookTaskDue(now: number): string {
  const due = new Date(now + 24 * 60 * 60_000);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short' }).format(due);
  const extra = day === 'Sat' ? 2 : day === 'Sun' ? 1 : 0;
  return new Date(due.getTime() + extra * 24 * 60 * 60_000).toISOString();
}

/** The sign-up evidence stored on the contact (custom field mhpSignup) and on its timeline entry. */
export function bookEvidence(candidate: MhpBookLeadCandidate): Record<string, string | boolean | null> {
  return { form: candidate.label, module: candidate.module, link: candidate.link, signedUpAt: candidate.signedUpAt,
    consentGiven: candidate.consentGiven, consentVersion: candidate.consentVersion, marketingEmails: candidate.marketingEmails,
    signupId: candidate.signupId, prospectId: candidate.prospectId, recordedFrom: candidate.recordedFrom };
}

/** The candidate for a sign-up the form has just committed: the request is the evidence. */
export function bookCandidateFromCapture(signup: MhpSignup, captured: Pick<MhpCapturedSignup, 'prospectId' | 'signupId'>, now: number): MhpBookLeadCandidate {
  return { prospectId: captured.prospectId, signupId: captured.signupId, email: normalEmail(signup.email), firstName: signup.firstName,
    phone: signup.phone ?? null, consentGiven: signup.consent, consentVersion: MHP_CONSENT_VERSION,
    // The capture clears an earlier unsubscribe when the box is ticked, so a ticked box is "Tips emails: Yes".
    marketingEmails: signup.consent, label: signup.label, module: signup.module, link: signup.link,
    signedUpAt: new Date(now).toISOString(), recordedFrom: 'sign-up' };
}

/** The candidate for a person in the owner's registrant list (the book filter the Book interest page uses). */
export function bookCandidateFromRegistrant(person: MhpRegistrantRecord): MhpBookLeadCandidate {
  return { prospectId: person.id, signupId: null, email: normalEmail(person.email), firstName: person.firstName, phone: person.phone,
    consentGiven: null, consentVersion: null, marketingEmails: person.marketingConsent && !person.unsubscribed,
    label: MHP_BOOK_INTEREST_LABEL, module: MHP_BOOK_MODULE, link: null, signedUpAt: person.lastSignupAt, recordedFrom: 'owner-list' };
}

type Classified =
  | { kind: 'create' }
  | { kind: 'existing'; contactId: string; opportunityId: string | null; viaEmail: boolean }
  | { kind: 'blocked'; reason: MhpBookSkipReason };

interface EmailRow extends Record<string, unknown> {
  contactId: string; dedupeState: string; deleted: boolean; lifecycle: string; opportunityId: string | null; recorded: boolean;
}

/** Serialise every writer of this person's CRM record: the same key the 17 Nov 2026 trigger locks. */
async function lockPerson(tx: SqlExecutor, email: string): Promise<void> {
  await tx.query(`/* mhp.book-lead-lock */ SELECT pg_advisory_xact_lock(hashtextextended('mhp:book-contact:'||$1::text,121))`, [email]);
}

/** Who this sign-up already is in the CRM. Reads only; runs under the person lock. */
async function classify(tx: SqlExecutor, candidate: MhpBookLeadCandidate, actorUserId: string): Promise<Classified> {
  const rows = (await tx.query<EmailRow>(`/* mhp.book-lead-classify */
    SELECT cp.contact_id AS "contactId", cp.dedupe_state AS "dedupeState", c.deleted_at IS NOT NULL AS deleted, c.lifecycle_status AS lifecycle,
      (SELECT o.id FROM app.opportunities o WHERE o.workspace_id=cp.workspace_id AND o.contact_id=cp.contact_id
        AND (o.name LIKE $2||'%' OR EXISTS(SELECT 1 FROM app.opportunity_stage_history h WHERE h.workspace_id=o.workspace_id
          AND h.opportunity_id=o.id AND h.actor_kind='system' AND h.note=$3))
       ORDER BY o.created_at,o.id LIMIT 1) AS "opportunityId",
      EXISTS(SELECT 1 FROM app.activities a WHERE a.workspace_id=cp.workspace_id AND a.contact_id=cp.contact_id AND a.activity_type=$4) AS recorded
    FROM app.contact_points cp JOIN app.contacts c ON c.workspace_id=cp.workspace_id AND c.id=cp.contact_id
    WHERE cp.workspace_id=app_private.current_workspace_id() AND cp.kind='email' AND lower(cp.normalized_value)=$1 AND cp.deleted_at IS NULL
    ORDER BY cp.id`, [candidate.email, MHP_BOOK_ENQUIRY_PREFIX, MHP_BOOK_TRIGGER_NOTE, MHP_BOOK_ACTIVITY])).rows;
  if (rows.length > 1) return { kind: 'blocked', reason: 'several_contacts' };
  const receipt = (await tx.query<{ result: { contactId?: unknown; opportunityId?: unknown } | null }>(`/* mhp.book-lead-receipt */
    SELECT result FROM app.command_receipts WHERE workspace_id=app_private.current_workspace_id() AND actor_user_id=$1
      AND command_name='crm.createLead' AND idempotency_key=$2 AND status='succeeded'`, [actorUserId, bookLeadKey(candidate.prospectId)])).rows[0];
  const receiptOpportunity = typeof receipt?.result?.opportunityId === 'string' ? receipt.result.opportunityId : null;
  const row = rows[0];
  if (row) {
    if (row.deleted) return { kind: 'blocked', reason: 'deleted_contact' };
    if (row.dedupeState !== 'normal') return { kind: 'blocked', reason: 'shared_contact' };
    if (row.lifecycle === 'archived') return { kind: 'blocked', reason: 'archived_contact' };
    if (row.opportunityId || row.recorded || receipt?.result?.contactId === row.contactId) {
      return { kind: 'existing', contactId: row.contactId, opportunityId: row.opportunityId ?? receiptOpportunity, viaEmail: true };
    }
    return { kind: 'create' };
  }
  // No record holds the email now. A book lead made for this sign-up earlier (by the trigger or by us) whose email was
  // removed is the owner's to sort out: never make a second person.
  const earlier = (await tx.query<{ id: string; deleted: boolean }>(`/* mhp.book-lead-earlier */
    SELECT c.id, c.deleted_at IS NOT NULL AS deleted FROM app.contacts c WHERE c.workspace_id=app_private.current_workspace_id()
      AND c.source=$1 AND c.custom_fields->>'mhpProspectId'=$2 ORDER BY c.created_at,c.id LIMIT 1`, [MHP_BOOK_SOURCE, candidate.prospectId])).rows[0];
  if (earlier || receipt) return { kind: 'blocked', reason: 'contact_without_email' };
  return { kind: 'create' };
}

export const bookLeadKey = (prospectId: string): string => `mhp.book.${prospectId}`;

/**
 * The MHP marketing workspace's one active owner, read at run time on the web login as the viewing person (who must
 * be a member: the membership policy shows nothing otherwise). Null when there is not exactly one active owner.
 */
export async function readMhpWorkspaceOwner(webPool: Pick<Pool, 'connect'>, identity: PortalSessionIdentity): Promise<string | null> {
  const context = requestDatabaseContext({ workspaceId: MHP_MARKETING_WORKSPACE_ID, userId: identity.userId, requestId: `mhp-book-owner:${randomUUID()}` });
  const rows = await withTransaction(webPool, context, async tx => (await tx.query<{ userId: string }>(`/* mhp.book-lead-workspace-owner */
    SELECT m.user_id AS "userId" FROM app.workspace_memberships m WHERE m.workspace_id=app_private.current_workspace_id()
      AND m.role='owner' AND m.status='active' ORDER BY m.user_id LIMIT 2`)).rows, { readOnly: true });
  return rows.length === 1 && SIGNUP_LEAD_UUID.test(rows[0]!.userId) ? rows[0]!.userId : null;
}

class ProjectionChanged extends Error {}

/**
 * Fill in what is missing on a book lead, inside the caller's locked transaction. Never touches the enquiry's stage,
 * owner, tasks or name, or the contact's name, owner or lifecycle. Returns what it did.
 */
async function enrich(tx: SqlExecutor, context: DatabaseRequestContext, contactId: string, opportunityId: string | null,
  candidate: MhpBookLeadCandidate, now: Date): Promise<{ changed: boolean; phone: 'added' | 'present' | 'other_contact' | 'none' }> {
  const contact = (await tx.query<{ fields: Record<string, unknown> }>(`/* mhp.book-lead-contact */
    SELECT custom_fields AS fields FROM app.contacts WHERE workspace_id=app_private.current_workspace_id() AND id=$1::uuid FOR UPDATE`, [contactId])).rows[0];
  if (!contact) throw new ProjectionChanged();
  const patch: Record<string, unknown> = {};
  if (!('mhpProspectId' in contact.fields)) patch.mhpProspectId = candidate.prospectId;
  if (!('bookInterest' in contact.fields)) patch.bookInterest = 'Before You Buy';
  if (!('mhpSignup' in contact.fields)) patch.mhpSignup = bookEvidence(candidate);
  const changes: string[] = [];
  if (Object.keys(patch).length > 0) {
    await tx.query(`/* mhp.book-lead-evidence */ UPDATE app.contacts SET custom_fields=custom_fields||$2::jsonb, row_version=row_version+1,
      updated_at=greatest(updated_at,clock_timestamp()) WHERE workspace_id=app_private.current_workspace_id() AND id=$1::uuid`, [contactId, JSON.stringify(patch)]);
    if ('mhpSignup' in patch) changes.push('sign-up details');
  }
  // Marketing permission, truthfully: known from the sign-up, never left "unknown"; an unsubscribe always wins; a later
  // tick never overrides an opt-out recorded in the CRM.
  const point = (await tx.query<{ id: string; consent: string; primary: boolean; hasPrimary: boolean }>(`/* mhp.book-lead-email */
    SELECT p.id, p.consent_status AS consent, p.is_primary AS primary,
      EXISTS(SELECT 1 FROM app.contact_points q WHERE q.workspace_id=p.workspace_id AND q.contact_id=p.contact_id AND q.kind='email'
        AND q.is_primary AND q.deleted_at IS NULL) AS "hasPrimary"
    FROM app.contact_points p WHERE p.workspace_id=app_private.current_workspace_id() AND p.contact_id=$1::uuid AND p.kind='email'
      AND lower(p.normalized_value)=$2 AND p.deleted_at IS NULL AND p.dedupe_state='normal' FOR UPDATE`, [contactId, candidate.email])).rows[0];
  if (point) {
    const consent = point.consent === 'unknown' ? (candidate.marketingEmails ? 'opted_in' : 'opted_out')
      : point.consent === 'opted_in' && !candidate.marketingEmails && candidate.recordedFrom === 'owner-list' ? 'opted_out' : point.consent;
    const primary = point.primary || !point.hasPrimary;
    if (consent !== point.consent || primary !== point.primary) {
      await tx.query(`/* mhp.book-lead-email-permission */ UPDATE app.contact_points SET consent_status=$2, is_primary=$3, row_version=row_version+1,
        updated_at=greatest(updated_at,clock_timestamp()) WHERE workspace_id=app_private.current_workspace_id() AND id=$1::uuid`, [point.id, consent, primary]);
      if (consent !== point.consent) changes.push(`marketing emails ${consent === 'opted_in' ? 'yes' : 'no'}`);
    }
  }
  // The mobile is added only as an unverified phone point, and only if no other record already holds that number:
  // a visitor must not be able to attach their sign-up to someone else's record by typing that person's number.
  // Through the CRM's own repository, exactly as crm.createLead and the Group HQ inbox "link" command add a point:
  // never verified, first phone of the contact becomes its primary, an existing primary is never replaced.
  const repository = new CrmPgRepository(tx);
  let phone: 'added' | 'present' | 'other_contact' | 'none' = 'none';
  const number = bookLeadPhone(candidate.phone);
  if (number) {
    const holder = await repository.findContactPoint('phone', number);
    if (holder) phone = holder.contactId === contactId ? 'present' : 'other_contact';
    else {
      const inserted = await repository.insertContactPoint({ id: randomUUID(), contactId, kind: 'phone', label: 'Mobile (unverified)',
        value: candidate.phone!.trim().slice(0, 320), normalizedValue: number,
        isPrimary: !(await repository.hasPrimaryContactPoint(contactId, 'phone')), consentStatus: 'unknown', createdAt: now.toISOString() });
      phone = inserted ? 'added' : 'other_contact';
      if (phone === 'added') changes.push('mobile number (unverified)');
    }
  }
  if (changes.length > 0) {
    const id = randomUUID();
    const signed = new Date(candidate.signedUpAt);
    const occurredAt = Number.isFinite(signed.getTime()) && signed <= now ? signed : now;
    await repository.insertActivity({ id, contactId, opportunityId, taskId: null, activityType: MHP_BOOK_ACTIVITY,
      actorUserId: context.userId ?? null, actorKind: 'user', subject: 'Before You Buy book sign-up',
      body: `${bookTaskDescription(candidate)}\nRecorded in Leads: ${changes.join(', ')}.${phone === 'other_contact' ? '\nThe mobile number already belongs to another record in Leads, so it was not added here.' : ''}`,
      metadata: { source: MHP_BOOK_SOURCE, ...bookEvidence(candidate), phone }, requestId: context.requestId, correlationId: id,
      causationId: null, occurredAt: occurredAt.toISOString() });
  }
  return { changed: changes.length > 0, phone };
}

export interface MhpBookLeadDependencies {
  /** The CRM command identity's runner that re-checks, in every transaction, that the acting user manages the workspace. */
  transactions: CrmTransactionRunner;
  /** The owner-only registrant read the Book interest page already uses. */
  registrants: (sessionToken: string) => Promise<readonly MhpRegistrantRecord[]>;
  /**
   * The MHP brand's lead owner by the existing rule: the user the Group HQ inbox bridge and the LeadRelay feed create
   * MHP enquiries as. Null when that is not configured; the workspace owner is then resolved at run time.
   */
  ownerUserId: string | null;
  /**
   * The MHP marketing workspace's one active owner, read at run time as the viewing owner (used only when ownerUserId is
   * null). Never a stored id; null when there is not exactly one.
   */
  workspaceOwner?: (identity: PortalSessionIdentity) => Promise<string | null>;
  cursorSecret: string;
  commands?: (runner: CrmTransactionRunner) => Pick<CrmCommandService, 'createLead'>;
  now?: () => number;
  /** Plain words, no personal data. */
  log?: (line: string) => void;
  /** Retries after a failed automatic copy; the owner's next visit or button press is the durable catch-up. */
  retryDelaysMs?: readonly number[];
  schedule?: (run: () => void, delayMs: number) => void;
}

export class MhpBookLeadService {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly commands: (runner: CrmTransactionRunner) => Pick<CrmCommandService, 'createLead'>;
  private warnedOff = false;
  private catchingUp: Promise<unknown> | null = null;
  /** The workspace owner last resolved on an owner's visit (only when no lead owner is configured). */
  private resolvedOwner: string | null = null;

  constructor(private readonly deps: MhpBookLeadDependencies) {
    if (deps.ownerUserId !== null && !SIGNUP_LEAD_UUID.test(deps.ownerUserId)) throw new Error('Invalid MHP book lead owner');
    if (deps.cursorSecret.length < 32) throw new Error('Invalid book import configuration');
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (line => console.warn(line));
    this.commands = deps.commands ?? (runner => new CrmCommandService({ transactionRunner: runner }));
  }

  /** Whether a sign-up is copied the moment it is saved (an owner is known), rather than at the next visit. */
  get automatic(): boolean { return (this.deps.ownerUserId ?? this.resolvedOwner) !== null; }

  private context(actorUserId: string, requestId = `mhp-book-lead:${randomUUID()}`): DatabaseRequestContext {
    return requestDatabaseContext({ workspaceId: MHP_MARKETING_WORKSPACE_ID, userId: actorUserId, requestId });
  }

  /** Copy one sign-up into the CRM as `actorUserId` (who also owns the enquiry and its task). */
  async project(actorUserId: string, candidate: MhpBookLeadCandidate, requestId?: string): Promise<MhpBookLeadOutcome> {
    if (!SIGNUP_LEAD_UUID.test(candidate.prospectId)) throw new Error('Invalid book sign-up');
    if (candidate.email.endsWith('.invalid')) return { outcome: 'skipped', reason: 'test_address' };
    const context = this.context(actorUserId, requestId);
    const { transactions } = this.deps;
    for (let attempt = 0; attempt < 3; attempt++) {
      const decided = await transactions.run(context, async tx => {
        await lockPerson(tx, candidate.email);
        const state = await classify(tx, candidate, actorUserId);
        if (state.kind === 'blocked') return { outcome: 'skipped', reason: state.reason } as const;
        if (state.kind === 'create') return null;
        if (!state.viaEmail) return { outcome: 'present', contactId: state.contactId, opportunityId: state.opportunityId, phone: 'none' } as const;
        const done = await enrich(tx, context, state.contactId, state.opportunityId, candidate, new Date(this.now()));
        return { outcome: done.changed ? 'enriched' : 'present', contactId: state.contactId, opportunityId: state.opportunityId, phone: done.phone } as const;
      });
      if (decided) return decided;
      const stage = await newEnquiryStage(transactions, context, AUDIENCE);
      let phone: 'added' | 'present' | 'other_contact' | 'none' = 'none';
      // The same lock and check again, in the transaction that creates the lead: a trigger, another instance, a
      // second tab or the owner may have made this person's book enquiry since the check above.
      const guarded: CrmTransactionRunner = { run: (ctx, operation) => transactions.run(ctx, async tx => {
        await lockPerson(tx, candidate.email);
        if ((await classify(tx, candidate, actorUserId)).kind !== 'create') throw new ProjectionChanged();
        const result = await operation(tx);
        const created = result as unknown as CreateLeadResult;
        phone = (await enrich(tx, ctx, created.contactId, created.opportunityId, candidate, new Date(this.now()))).phone;
        return result;
      }) };
      const name = (candidate.firstName?.trim() || candidate.email).slice(0, 200);
      try {
        const created = await createOrReplaySignupLead({ transactions, commands: this.commands(guarded), context, audience: AUDIENCE, command: {
          commandKey: bookLeadKey(candidate.prospectId), displayName: name, ownerUserId: actorUserId, source: MHP_BOOK_SOURCE,
          contactPoints: [{ kind: 'email', value: candidate.email, isPrimary: true, consentStatus: candidate.marketingEmails ? 'opted_in' : 'opted_out' }],
          pipelineId: stage.pipelineId, stageId: stage.stageId,
          opportunityName: `${MHP_BOOK_ENQUIRY_PREFIX} · ${name}`.slice(0, 200), valueMinor: 0, currency: 'GBP',
          task: { title: MHP_BOOK_TASK_TITLE, description: bookTaskDescription(candidate), assigneeUserId: actorUserId, dueAt: bookTaskDue(this.now()) },
        } });
        return { outcome: created.disposition === 'applied' ? 'created' : 'present', contactId: created.contactId, opportunityId: created.opportunityId, phone };
      } catch (error) {
        if (!(error instanceof ProjectionChanged)) throw error;
      }
    }
    throw new Error('Book lead kept changing while it was being copied');
  }

  /**
   * After the public form has committed a sign-up. Never awaited by the form and never throws: a failure is logged,
   * retried in this process, and otherwise picked up by the owner's next visit or button press.
   */
  afterCapture(signup: MhpSignup, captured: Pick<MhpCapturedSignup, 'prospectId' | 'signupId'>, now = this.now()): void {
    if (!isBookSignup(signup)) return;
    const owner = this.deps.ownerUserId ?? this.resolvedOwner;
    if (!owner) {
      if (!this.warnedOff) {
        this.warnedOff = true;
        this.log('mhp book leads: a book sign-up was saved but not copied into Leads yet, because no MHP lead owner is configured and no owner has opened the marketing pages since this process started; it is brought in at the next owner visit to Book interest or Growth CRM, or with "Bring book sign-ups into Leads".');
      }
      return;
    }
    const candidate = bookCandidateFromCapture(signup, captured, now);
    const delays = this.deps.retryDelaysMs ?? [60_000, 300_000];
    const schedule = this.deps.schedule ?? ((run, delay) => { setTimeout(run, delay).unref(); });
    const attempt = (index: number): void => {
      void this.project(owner, candidate).then(result => {
        if (result.outcome === 'skipped' && result.reason !== 'test_address') {
          this.log(`mhp book leads: a book sign-up was saved but not copied into Leads (${result.reason}); it is listed for the owner on Book interest.`);
        }
      }, error => {
        const code = (error as { code?: unknown })?.code;
        const next = delays[index];
        this.log(`mhp book leads: a book sign-up was saved but its lead was not created in Leads${typeof code === 'string' ? ` (${code.slice(0, 40)})` : ''}; ${next !== undefined ? `retrying in ${Math.round(next / 1000)} s` : 'it will be brought in at the owner\'s next visit to Book interest'}.`);
        if (next !== undefined) schedule(() => attempt(index + 1), next);
      });
    };
    attempt(0);
  }

  /** Who owns (and creates) book enquiries: the configured lead owner, else the workspace owner resolved now. */
  private async actorFor(identity: PortalSessionIdentity): Promise<string | null> {
    if (this.deps.ownerUserId) return this.deps.ownerUserId;
    let owner: string | null = null;
    try { owner = (await this.deps.workspaceOwner?.(identity)) ?? null; }
    catch { this.log('mhp book leads: the MHP marketing workspace owner could not be looked up; book sign-ups were not copied into Leads on this visit.'); return null; }
    if (owner === null || !SIGNUP_LEAD_UUID.test(owner)) {
      this.log('mhp book leads: the MHP marketing workspace has no single active owner to assign book enquiries to; book sign-ups were not copied into Leads.');
      return null;
    }
    this.resolvedOwner = owner;
    return owner;
  }

  /** Whether each book registrant is in Leads yet, read as the viewing owner. */
  async statuses(identity: PortalSessionIdentity, registrants: readonly MhpRegistrantRecord[]): Promise<MhpBookLeadStatuses> {
    const people = registrants.map(bookCandidateFromRegistrant);
    const empty = { available: false, byProspect: new Map<string, MhpBookLeadStatus>(), inLeads: 0, total: people.length };
    if (!people.length) return { ...empty, available: true };
    try {
      const phones = [...new Set(people.map(p => bookLeadPhone(p.phone)).filter((n): n is string => n !== null))];
      const { rows, held } = await this.deps.transactions.run(this.context(identity.userId), async tx => ({ rows: await tx.query<EmailRow & { email: string; stage: string | null; status: string | null; complete: boolean }>(`/* mhp.book-lead-status */
        SELECT lower(cp.normalized_value) AS email, cp.contact_id AS "contactId", cp.dedupe_state AS "dedupeState", c.deleted_at IS NOT NULL AS deleted,
          c.lifecycle_status AS lifecycle, o.id AS "opportunityId", s.name AS stage, o.status, c.custom_fields ? 'mhpSignup' AS complete,
          EXISTS(SELECT 1 FROM app.activities a WHERE a.workspace_id=cp.workspace_id AND a.contact_id=cp.contact_id AND a.activity_type=$4) AS recorded
        FROM app.contact_points cp JOIN app.contacts c ON c.workspace_id=cp.workspace_id AND c.id=cp.contact_id
        LEFT JOIN LATERAL (SELECT o.id,o.status,o.stage_id FROM app.opportunities o WHERE o.workspace_id=cp.workspace_id AND o.contact_id=cp.contact_id
          AND (o.name LIKE $2||'%' OR EXISTS(SELECT 1 FROM app.opportunity_stage_history h WHERE h.workspace_id=o.workspace_id
            AND h.opportunity_id=o.id AND h.actor_kind='system' AND h.note=$3)) ORDER BY o.created_at,o.id LIMIT 1) o ON true
        LEFT JOIN app.pipeline_stages s ON s.workspace_id=cp.workspace_id AND s.id=o.stage_id
        WHERE cp.workspace_id=app_private.current_workspace_id() AND cp.kind='email' AND cp.deleted_at IS NULL
          AND lower(cp.normalized_value)=ANY($1::text[])`, [people.map(p => p.email), MHP_BOOK_ENQUIRY_PREFIX, MHP_BOOK_TRIGGER_NOTE, MHP_BOOK_ACTIVITY]),
        // A mobile given at sign-up that no record in Leads holds yet still has to be added (the trigger never added one).
        held: new Set((await tx.query<{ n: string }>(`/* mhp.book-lead-status-phones */ SELECT normalized_value AS n FROM app.contact_points
          WHERE workspace_id=app_private.current_workspace_id() AND kind='phone' AND deleted_at IS NULL AND normalized_value=ANY($1::text[])`, [phones])).rows.map(r => r.n)) }));
      const byEmail = new Map<string, typeof rows.rows>();
      for (const row of rows.rows) byEmail.set(row.email, [...(byEmail.get(row.email) ?? []), row]);
      const byProspect = new Map<string, MhpBookLeadStatus>();
      let inLeads = 0;
      for (const person of people) {
        const found = byEmail.get(person.email) ?? [];
        let status: MhpBookLeadStatus;
        if (person.email.endsWith('.invalid')) status = { state: 'needs_you', reason: 'test_address' };
        else if (found.length > 1) status = { state: 'needs_you', reason: 'several_contacts' };
        else if (found.length === 0) status = { state: 'not_yet' };
        else {
          const row = found[0]!;
          if (row.deleted) status = { state: 'needs_you', reason: 'deleted_contact' };
          else if (row.dedupeState !== 'normal') status = { state: 'needs_you', reason: 'shared_contact' };
          else if (row.lifecycle === 'archived') status = { state: 'needs_you', reason: 'archived_contact' };
          else if (row.opportunityId || row.recorded) {
            const number = bookLeadPhone(person.phone);
            status = { state: 'in_leads', contactId: row.contactId, opportunityId: row.opportunityId, stage: row.stage, status: row.status,
              complete: (row.complete === true || row.recorded === true) && (number === null || held.has(number)) };
          }
          else status = { state: 'not_yet' };
        }
        if (status.state === 'in_leads') inLeads += 1;
        byProspect.set(person.prospectId, status);
      }
      return { available: true, byProspect, inLeads, total: people.length };
    } catch {
      this.log('mhp book leads: whether book sign-ups are in Leads could not be read; the page says so and nothing was changed.');
      return empty;
    }
  }

  /**
   * The catch-up on an owner's visit: anyone not yet in Leads, or in Leads without what the trigger skipped, is brought
   * in now (bounded). Never throws; the page shows whatever is true afterwards.
   */
  async catchUp(identity: PortalSessionIdentity, registrants?: readonly MhpRegistrantRecord[], options: { limit?: number; budgetMs?: number } = {}): Promise<{ processed: number; failed: number }> {
    if (this.catchingUp) await this.catchingUp.catch(() => undefined);
    const run = (async () => {
      const people = (registrants ?? await this.deps.registrants(identity.sessionToken))
        .filter(person => person.signups.includes(MHP_BOOK_INTEREST_LABEL) && SIGNUP_LEAD_UUID.test(person.id));
      const statuses = await this.statuses(identity, people);
      if (!statuses.available) return { processed: 0, failed: 0 };
      const due = people.filter(person => {
        const status = statuses.byProspect.get(person.id);
        return status?.state === 'not_yet' || (status?.state === 'in_leads' && !status.complete);
      }).slice(0, options.limit ?? SIGNUP_LEAD_BATCH_SIZE);
      if (!due.length) return { processed: 0, failed: 0 };
      const actor = await this.actorFor(identity);
      if (!actor) return { processed: 0, failed: due.length };
      const deadline = this.now() + (options.budgetMs ?? 3_000);
      let processed = 0, failed = 0;
      for (const person of due) {
        if (this.now() > deadline) break;
        try { await this.project(actor, bookCandidateFromRegistrant(person)); processed += 1; }
        catch { failed += 1; }
      }
      if (failed > 0) this.log(`mhp book leads: ${failed} book sign-up(s) could not be copied into Leads on the owner's visit; they are retried at the next visit or button press.`);
      return { processed, failed };
    })();
    this.catchingUp = run;
    try { return await run; }
    catch {
      this.log('mhp book leads: the catch-up on the owner\'s visit could not read the book sign-ups; nothing was changed.');
      return { processed: 0, failed: 0 };
    } finally { if (this.catchingUp === run) this.catchingUp = null; }
  }

  /** The owner's button: up to 25 book sign-ups per press, in prospect order, from a signed cursor. */
  async importBatch(identity: PortalSessionIdentity, requestId: string, cursor: string, now = this.now()): Promise<MhpBookLeadBatch> {
    const after = readSignupLeadCursor(this.deps.cursorSecret, AUDIENCE, identity, cursor, now);
    const people = [...(await this.deps.registrants(identity.sessionToken))]
      .filter(person => person.signups.includes(MHP_BOOK_INTEREST_LABEL) && SIGNUP_LEAD_UUID.test(person.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .filter(person => after === null || person.id > after);
    const page = people.slice(0, SIGNUP_LEAD_BATCH_SIZE);
    const hasMore = people.length > page.length;
    const actor = page.length ? await this.actorFor(identity) : null;
    if (page.length && !actor) throw new MhpCommerceError(503, 'Book sign-ups cannot be brought in yet: the MHP marketing workspace needs exactly one active owner to assign them to.');
    let added = 0, alreadyIn = 0, completed = 0, needYou = 0, last = after;
    for (const person of page) {
      try {
        const result = await this.project(actor!, bookCandidateFromRegistrant(person), `${requestId}:${person.id}`.slice(0, 128));
        if (result.outcome === 'created') added += 1;
        else if (result.outcome === 'enriched') completed += 1;
        else if (result.outcome === 'present') alreadyIn += 1;
        else if (result.outcome === 'skipped' && result.reason !== 'test_address') needYou += 1;
        last = person.id;
      } catch {
        this.log('mhp book leads: the owner\'s book sign-up import stopped before one sign-up; pressing the button again continues from there.');
        return { added, alreadyIn, completed, needYou, failed: true, processed: added + alreadyIn + completed + needYou, hasMore: true,
          cursor: signSignupLeadCursor(this.deps.cursorSecret, AUDIENCE, identity, last, now) };
      }
    }
    return { added, alreadyIn, completed, needYou, failed: false, processed: added + alreadyIn + completed + needYou, hasMore,
      cursor: hasMore ? signSignupLeadCursor(this.deps.cursorSecret, AUDIENCE, identity, page.at(-1)!.id, now) : null };
  }
}
