import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { CompanyContentService, canonicalCompanyContentJson, type CompanyContentTransactionRunner, type CreateCompanyContentVersionCommand } from '../company-content-pg/index.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import { MHP_OPAQUE_TOKEN } from './auth-service.js';
import { MhpCommerceError } from './commerce-service.js';
import { MHP_MARKETING_WORKSPACE_ID, type PgMhpMarketingWorkspaceService } from './marketing-workspace-service.js';
import { mhpOwnerEmailContentRunner, type MhpOwnerEmailService, type MhpOwnerEmailLocalVersion } from './owner-email-service.js';
import { parseMhpOwnerEmailBrand } from './owner-email-content.js';
import { canonicalFollowupSequence, FOLLOWUP_SEQUENCE_MIME, FOLLOWUP_SEQUENCE_SOURCE, FOLLOWUP_SEQUENCE_UUID, followupActivationBlockers,
  followupSequenceSha, followupTimeline, followupEntryIntent, parseFollowupSequence, readCanonicalFollowupSequence, type FollowupMessage, type FollowupSequenceDefinition, type FollowupSequenceReadiness } from '../followup-sequences/definition.js';
import type { FollowupRunState } from '../followup-sequences/state.js';
import { flowCommandUuid, parseFlowComposition, resolveFlowComposition, type FlowSavedMessageRef } from '../followup-sequences/composition.js';
import { previewFlowMessage } from '../followup-sequences/channel-drafts.js';
import { LocalFlowMessages, type FlowMessageReview } from '../followup-sequences/messages.js';
import { FlowLocalStore } from '../followup-sequences/local-store.js';
import { FlowWorkspaceError } from '../followup-sequences/workspace.js';
import { simulateFollowupFlow, flowSimulationPreset } from '../followup-sequences/simulation.js';
import type { FollowupEntryRule } from '../followup-sequences/entry.js';

const hash = (value: string): Buffer => createHash('sha256').update(value).digest();
const uuid = (value: string): boolean => FOLLOWUP_SEQUENCE_UUID.test(value);
export interface MhpSequenceRun {
  id: string; contentItemId: string; contentVersionId: string; email: string; firstName: string | null;
  state: FollowupRunState; position: number; dueAt: string; reason: string | null; createdAt: string;
  lastAcceptedAt: string | null; inFlight: boolean; unknownProofId: string | null;
  definitionSchema?: string;
  steps: readonly { position: number; acceptedAt: string | null; dueAt: string; expiresAt: string; cancelled: boolean; failed: boolean; held: boolean; inFlight: boolean | null }[];
}
export interface MhpSequenceDatabaseSnapshot { brand: unknown; campaign: string; eligible: number; blocked: number; runs: readonly MhpSequenceRun[]; runCount: number; entryRules?: readonly FollowupEntryRule[] }
export interface MhpSequenceExact {
  contentItemId: string; contentVersionId: string; sourceItemId: string; sourceVersion: string; canonicalContent: string;
  contentSha256: string; blobSha256: string; brand: unknown; manifestSha256: string; approvalDecisionId: string | null;
  definition: FollowupSequenceDefinition; campaign: string;
}
export interface MhpSequenceLocal extends Omit<MhpOwnerEmailLocalVersion, 'exact'> { exact: MhpSequenceExact | null }
export interface MhpSequenceAction {
  action: 'enrol' | 'pause' | 'resume' | 'cancel' | 'stop'; commandId: string; itemId: string; versionId: string;
  runId: string; ackProofId: string;
}
export interface MhpSequenceActionResult { action: MhpSequenceAction['action']; contentItemId: string; contentVersionId: string;
  changed: number; remaining: number; blocked: number; inFlight: number; replayed: boolean }
export interface MhpEntryAction { action: 'activate' | 'off'; commandId: string; itemId: string; versionId: string; ruleId: string; expiresAt: string }
export interface MhpEntryActionResult { action: MhpEntryAction['action']; contentItemId: string; contentVersionId: string; ruleId: string;
  state: 'active' | 'off'; expiresAt: string; watermark: string; replayed: boolean }
export interface MhpSequenceRepository {
  snapshot(identity: PortalSessionIdentity, campaign: string): Promise<MhpSequenceDatabaseSnapshot>;
  local(identity: PortalSessionIdentity, versionId: string | null, revision: string | null): Promise<MhpSequenceLocal | null>;
  command(identity: PortalSessionIdentity, input: MhpSequenceAction & { campaign: string; requestId: string }): Promise<MhpSequenceActionResult>;
  entryCommand?(identity: PortalSessionIdentity, input: MhpEntryAction & { campaign: string; requestId: string }): Promise<MhpEntryActionResult>;
}
function failure(error: unknown): never {
  if (error instanceof MhpCommerceError) throw error;
  const code = (error as { code?: string })?.code;
  if (code === '42501') throw new MhpCommerceError(403, 'Open the MHP marketing workspace with your owner account.');
  if (['23514', '23505', '40001'].includes(code ?? '')) throw new MhpCommerceError(409, 'The sequence, its content or its approval changed. Refresh before continuing.');
  if (code === '22023') throw new MhpCommerceError(400, 'Check the sequence and selected action.');
  throw new MhpCommerceError(503, 'Sequence controls are temporarily unavailable.');
}
export class PgMhpSequenceRepository implements MhpSequenceRepository {
  constructor(private readonly web: Pick<Pool, 'query'>, private readonly commands: Pick<Pool, 'query'>) {}
  private token(identity: PortalSessionIdentity): Buffer {
    if (!MHP_OPAQUE_TOKEN.test(identity.sessionToken) || identity.workspaceId !== MHP_MARKETING_WORKSPACE_ID) throw new MhpCommerceError(403, 'Open the MHP marketing workspace first.');
    return hash(identity.sessionToken);
  }
  async snapshot(identity: PortalSessionIdentity, campaign: string): Promise<MhpSequenceDatabaseSnapshot> {
    try {
      const result = await this.web.query<{ value: MhpSequenceDatabaseSnapshot }>('SELECT app_private.mhp_sequence_snapshot($1,$2) AS value', [this.token(identity), campaign]);
      const value = result.rows[0]?.value;
      if (!value || value.campaign !== campaign || ![value.eligible, value.blocked, value.runCount].every(n => Number.isSafeInteger(n) && n >= 0)
          || !Array.isArray(value.runs) || value.runs.length > 100) throw new Error('Invalid sequence snapshot');
      if (value.entryRules !== undefined && (!Array.isArray(value.entryRules) || value.entryRules.length > 50 || value.entryRules.some(rule =>
        !uuid(rule.id) || !uuid(rule.contentItemId) || !uuid(rule.contentVersionId) || !['active', 'held', 'off', 'expired'].includes(rule.state)
        || ![rule.processed, rule.enrolled, rule.skipped, rule.blocked].every(n => Number.isSafeInteger(n) && n >= 0)
        || !/^\d{1,19}$/u.test(rule.cursorSequence) || !Number.isFinite(Date.parse(rule.activatedAt)) || !Number.isFinite(Date.parse(rule.expiresAt))
        || ![null, 'newer_sequence', 'content_changed', 'recovery'].includes(rule.heldReason)
        || (rule.cursorSignupId !== null && !uuid(rule.cursorSignupId))
        || [rule.cursorAt, rule.lastSweptAt].some(at => at !== null && !Number.isFinite(Date.parse(at)))))) throw new Error('Invalid entry rule snapshot');
      parseMhpOwnerEmailBrand(value.brand); return value;
    } catch (error) { return failure(error); }
  }
  async local(identity: PortalSessionIdentity, versionId: string | null, revision: string | null): Promise<MhpSequenceLocal | null> {
    try {
      const result = await this.web.query<{ value: MhpSequenceLocal | null }>('SELECT app_private.mhp_sequence_local_version($1,$2,$3) AS value', [this.token(identity), versionId, revision]);
      const value = result.rows[0]?.value;
      if (value === null) return null;
      if (!value || !uuid(value.contentItemId) || !uuid(value.contentVersionId) || followupSequenceSha(value.canonicalContent) !== value.contentSha256
          || typeof value.valid !== 'boolean' || (versionId && value.contentVersionId !== versionId) || (revision && value.sourceVersion !== revision)) throw new Error('Invalid sequence version');
      readCanonicalFollowupSequence(value.canonicalContent); return value;
    } catch (error) { return failure(error); }
  }
  async command(identity: PortalSessionIdentity, input: MhpSequenceAction & { campaign: string; requestId: string }): Promise<MhpSequenceActionResult> {
    try {
      const result = await this.commands.query<{ value: MhpSequenceActionResult }>('SELECT app_private.mhp_sequence_command($1,$2,$3,$4,$5,$6,$7,$8) AS value',
        [this.token(identity), input.action, input.commandId, input.versionId, input.campaign, input.runId || null, input.ackProofId || null, input.requestId]);
      const value = result.rows[0]?.value;
      if (!value || value.action !== input.action || value.contentItemId !== input.itemId || value.contentVersionId !== input.versionId
          || ![value.changed, value.remaining, value.blocked, value.inFlight].every(n => Number.isSafeInteger(n) && n >= 0) || typeof value.replayed !== 'boolean') throw new Error('Invalid sequence result');
      return value;
    } catch (error) { return failure(error); }
  }
  async entryCommand(identity: PortalSessionIdentity, input: MhpEntryAction & { campaign: string; requestId: string }): Promise<MhpEntryActionResult> {
    try {
      const result = await this.commands.query<{ value: MhpEntryActionResult }>('SELECT app_private.mhp_sequence_entry_command($1,$2,$3,$4,$5,$6,$7,$8) AS value',
        [this.token(identity), input.action, input.commandId, input.versionId, input.campaign, input.ruleId || null, input.action === 'activate' ? input.expiresAt : null, input.requestId]);
      const value = result.rows[0]?.value;
      if (!value || value.action !== input.action || value.contentItemId !== input.itemId || value.contentVersionId !== input.versionId
          || !uuid(value.ruleId) || value.state !== (input.action === 'activate' ? 'active' : 'off') || !/^\d{1,19}$/u.test(value.watermark)
          || !Number.isFinite(Date.parse(value.expiresAt)) || typeof value.replayed !== 'boolean') throw new Error('Invalid entry command result');
      return value;
    } catch (error) { return failure(error); }
  }
}
export interface MhpSequenceSaveInput { commandId: string; contentItemId: string; previousVersionId: string; definition: unknown; inlineMessages?: unknown }
export class MhpSequenceService {
  constructor(private readonly dependencies: {
    marketingWorkspace: Pick<PgMhpMarketingWorkspaceService, 'snapshot'>; repository: MhpSequenceRepository;
    reader: Pick<CompanyContentService, 'listCatalog' | 'getExactReview'>;
    adapter: Pick<CompanyContentService, 'createVersion' | 'refreshSourceAttestation'>;
    approvals: Pick<CompanyContentService, 'requestApproval' | 'decideApproval'>; adapterTransactions: CompanyContentTransactionRunner;
    emails: Pick<MhpOwnerEmailService, 'snapshot' | 'status' | 'review'>; campaign: string; messages?: Pick<LocalFlowMessages, 'choices' | 'review' | 'save' | 'publish'>;
  }) {}
  async contentContext(identity: PortalSessionIdentity, requestId: string): Promise<DatabaseRequestContext> {
    const workspace = await this.dependencies.marketingWorkspace.snapshot(identity);
    if (!MHP_OPAQUE_TOKEN.test(identity.sessionToken) || identity.workspaceId !== MHP_MARKETING_WORKSPACE_ID || workspace.userId !== identity.userId
        || workspace.selectedWorkspaceId !== identity.workspaceId || !workspace.marketingSelected) throw new MhpCommerceError(403, 'Open the MHP marketing workspace first.');
    return requestDatabaseContext({ userId: identity.userId, workspaceId: identity.workspaceId, requestId, portalSessionTokenHash: hash(identity.sessionToken) });
  }
  private context(identity: PortalSessionIdentity, requestId: string) { return this.contentContext(identity, requestId); }
  private checked(value: unknown): FollowupSequenceDefinition {
    let definition: FollowupSequenceDefinition;
    try { definition = parseFollowupSequence(value); } catch (error) { throw new MhpCommerceError(400, (error as Error).message); }
    if (definition.brand !== 'mhp' || definition.campaign !== this.dependencies.campaign) throw new MhpCommerceError(400, 'Use the current MHP webinar audience.');
    return definition;
  }
  get readiness(): FollowupSequenceReadiness {
    const status = this.dependencies.emails.status;
    return { email: status.providerReady && status.mode !== 'off', sms: false, whatsapp: false, reply: false, booked: false, purchased: false };
  }
  async snapshot(identity: PortalSessionIdentity, requestId: string) {
    const context = await this.context(identity, requestId);
    const [database, catalog, emails] = await Promise.all([this.dependencies.repository.snapshot(identity, this.dependencies.campaign),
      this.dependencies.reader.listCatalog(context, { limit: 50, sourceSystem: FOLLOWUP_SEQUENCE_SOURCE }), this.dependencies.emails.snapshot(identity, requestId)]);
    return { database, catalog, emailCatalog: emails.catalog, readiness: this.readiness, mode: this.dependencies.emails.status.mode,
      entryAvailable: Boolean(this.dependencies.repository.entryCommand),
      ...(this.dependencies.messages ? { messageChoices: await this.dependencies.messages.choices(identity, requestId) } : {}) };
  }
  async review(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string) {
    if (!uuid(itemId) || !uuid(versionId)) throw new MhpCommerceError(400, 'Choose a saved sequence.');
    const context = await this.context(identity, requestId);
    const [review, local] = await Promise.all([this.dependencies.reader.getExactReview(context, { contentItemId: itemId, contentVersionId: versionId }), this.dependencies.repository.local(identity, versionId, null)]);
    if (!review || review.kind !== 'other' || review.source.system !== FOLLOWUP_SEQUENCE_SOURCE || !local || local.contentItemId !== itemId || local.contentSha256 !== review.contentSha256)
      throw new MhpCommerceError(404, 'This sequence was not found in the MHP workspace.');
    const definition = this.checked(readCanonicalFollowupSequence(review.canonicalContent));
    const blockers = new Set(followupActivationBlockers(definition, this.readiness));
    const selected = new Map(definition.steps.filter((step): step is FollowupMessage => step.kind !== 'wait' && (Boolean(this.dependencies.messages) || step.kind === 'email')).map(step => [step.contentVersionId, step]));
    const messages: FlowMessageReview[] = [];
    for (const step of selected.values()) {
      try {
        if (this.dependencies.messages) {
          const message = await this.dependencies.messages.review(identity, requestId, step.kind, step.contentItemId, step.contentVersionId); messages.push(message);
          if (!message.review.isLatest || message.review.approvalStatus !== 'approved' || message.review.approvalStale || !message.valid || message.review.contentSha256 !== step.contentSha256) blockers.add('email_version_not_ready');
        } else {
          const email = await this.dependencies.emails.review(identity, requestId, step.contentItemId, step.contentVersionId);
          if (!email.review.isLatest || email.review.approvalStatus !== 'approved' || email.review.approvalStale || !email.local.valid || email.review.contentSha256 !== step.contentSha256) blockers.add('email_version_not_ready');
        }
      } catch (error) { if ((error instanceof MhpCommerceError || error instanceof FlowWorkspaceError) && [404, 409].includes(error.status)) blockers.add('email_version_not_ready'); else throw error; }
    }
    return { review, local, definition, blockers: [...blockers], timeline: followupTimeline(definition), ...(this.dependencies.messages ? { messages } : {}) };
  }
  async preview(identity: PortalSessionIdentity, requestId: string, value: unknown, inlineMessages?: unknown) {
    await this.context(identity, requestId); const composition = inlineMessages === undefined ? null : parseFlowComposition(value, inlineMessages), definition = this.checked(composition?.definition ?? value);
    const previews: ReturnType<typeof previewFlowMessage>[] = [];
    for (const step of definition.steps) if (step.kind !== 'wait') {
      const inline = composition?.inlineMessages[step.key];
      if (inline) previews.push(previewFlowMessage(step.kind, inline.payload));
      else if (this.dependencies.messages) {
        const message = await this.dependencies.messages.review(identity, requestId, step.kind, step.contentItemId, step.contentVersionId);
        if (message.review.contentSha256 !== step.contentSha256) throw new MhpCommerceError(409, 'Choose the exact saved message version before previewing.');
        previews.push(previewFlowMessage(step.kind, message.payload));
      }
    }
    return { definition, timeline: followupTimeline(definition), blockers: followupActivationBlockers(definition, this.readiness),
      ...(composition || this.dependencies.messages ? { messagePreviews: previews } : {}) };
  }
  async simulate(identity: PortalSessionIdentity, requestId: string, value: unknown, inlineMessages?: unknown, simulationCase = 'happy') {
    const preview = await this.preview(identity, requestId, value, inlineMessages);
    return { ...preview, simulation: simulateFollowupFlow(preview.definition, this.readiness, flowSimulationPreset(simulationCase, preview.definition)) };
  }
  async message(identity: PortalSessionIdentity, requestId: string, channel: 'email' | 'sms' | 'whatsapp', itemId: string, versionId: string) {
    await this.context(identity, requestId);
    if (!this.dependencies.messages) throw new MhpCommerceError(503, 'The inline message library is unavailable.');
    const detail = await this.dependencies.messages.review(identity, requestId, channel, itemId, versionId);
    return { channel, title: detail.review.title, contentItemId: detail.review.contentItemId, contentVersionId: detail.review.contentVersionId, contentSha256: detail.review.contentSha256, payload: detail.payload };
  }
  async save(identity: PortalSessionIdentity, requestId: string, input: MhpSequenceSaveInput, now = Date.now()) {
    if (!uuid(input.commandId) || Boolean(input.contentItemId) !== Boolean(input.previousVersionId)) throw new MhpCommerceError(400, 'Refresh the sequence form before saving.');
    const context = await this.context(identity, requestId), composition = input.inlineMessages === undefined ? null : parseFlowComposition(input.definition, input.inlineMessages);
    let definition = this.checked(composition?.definition ?? input.definition);
    if (composition && Object.keys(composition.inlineMessages).length) {
      if (!this.dependencies.messages) throw new MhpCommerceError(503, 'The inline message editor is unavailable.');
      const saved: Record<string, FlowSavedMessageRef> = {};
      for (const [key, message] of Object.entries(composition.inlineMessages)) saved[key] = await this.dependencies.messages.save(identity, requestId, flowCommandUuid(input.commandId, key), message, now);
      definition = this.checked(resolveFlowComposition(composition, saved));
    }
    const canonical = canonicalFollowupSequence(definition);
    const replay = async () => {
      const saved = await this.dependencies.repository.local(identity, null, `edit:${input.commandId}`);
      if (!saved) return null;
      if (saved.canonicalContent !== canonical || saved.previousVersionId !== (input.previousVersionId || null) || (input.contentItemId && saved.contentItemId !== input.contentItemId))
        throw new MhpCommerceError(409, 'This save command already has different sequence details. Refresh the editor.');
      return { contentItemId: saved.contentItemId, contentVersionId: saved.contentVersionId, replayed: true };
    };
    const prior = await replay(); if (prior) return prior;
    const old = input.contentItemId ? await this.review(identity, requestId, input.contentItemId, input.previousVersionId) : null;
    if (old && !old.review.isLatest) throw new MhpCommerceError(409, 'Open the latest sequence draft before editing.');
    const snapshot = await this.dependencies.repository.snapshot(identity, this.dependencies.campaign), brand = parseMhpOwnerEmailBrand(snapshot.brand);
    const sha = followupSequenceSha(canonical), item = old?.review.source.itemId ?? `sequence:${input.commandId}`, revision = `edit:${input.commandId}`, storageKey = `inline:mhp.followup-sequence:${sha}`;
    const manifest = canonicalCompanyContentJson({ schema: 'mhp.followup-sequence-source/v1', workspaceId: MHP_MARKETING_WORKSPACE_ID,
      sourceSystem: FOLLOWUP_SEQUENCE_SOURCE, sourceItemId: item, sourceVersion: revision, contentSha256: sha, blobStorageKey: storageKey, blobSha256: sha,
      brandSnapshotRef: brand.ref, brandSha256: brand.sha256, audienceCampaign: this.dependencies.campaign });
    const command: CreateCompanyContentVersionCommand = { commandKey: `mhp.sequence.save.${input.commandId}`, contentItemId: old?.review.contentItemId ?? null,
      previousVersionId: old?.review.contentVersionId ?? null, origin: old ? 'edited' : 'imported', kind: 'other', title: definition.title, contentMimeType: FOLLOWUP_SEQUENCE_MIME,
      content: canonical, source: { system: FOLLOWUP_SEQUENCE_SOURCE, itemId: item, version: revision }, blob: { storageKey, sha256: sha }, brand: { snapshotRef: brand.ref, sha256: brand.sha256 },
      attestation: { catalogSha256: followupSequenceSha(manifest), checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900_000).toISOString() },
      metadata: { mhpSequence: { schema: 'mhp.followup-sequence-local/v1', brandCanonical: brand.canonical, manifestCanonical: manifest, manifestSha256: followupSequenceSha(manifest), authoredBy: 'native-owner' } } };
    try { const result = await this.dependencies.adapter.createVersion(context, command); return { contentItemId: result.contentItemId, contentVersionId: result.contentVersionId, replayed: result.disposition === 'replayed' }; }
    catch (error) { const winner = await replay(); if (winner) return winner; return failure(error); }
  }
  async publish(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string, commandId: string, now = Date.now()): Promise<void> {
    if (!uuid(commandId)) throw new MhpCommerceError(400, 'Refresh the sequence form.');
    const context = await this.context(identity, requestId), detail = await this.review(identity, requestId, itemId, versionId), exact = detail.local.exact;
    if (!detail.review.isLatest || !detail.local.valid || !exact) throw new MhpCommerceError(409, 'Save a fresh sequence with the current brand before publishing.');
    if (this.dependencies.messages) {
      const selected = detail.definition.steps.filter((step): step is FollowupMessage => step.kind !== 'wait');
      if ((detail.messages?.length ?? 0) !== new Set(selected.map(step => step.contentVersionId)).size
          || detail.messages?.some(message => !message.valid || !message.review.isLatest)) throw new MhpCommerceError(409, 'Choose current exact local message versions before publishing this blueprint.');
      const done = new Set<string>();
      for (const step of selected) if (!done.has(step.contentVersionId)) { await this.dependencies.messages.publish(identity, requestId, step.kind, step.contentItemId, step.contentVersionId, flowCommandUuid(commandId, step.key), now); done.add(step.contentVersionId); }
    }
    if (detail.review.approvalStatus === 'approved' && !detail.review.approvalStale) return;
    const key = `mhp.sequence.publish.${commandId}.refresh`, brand = parseMhpOwnerEmailBrand(exact.brand);
    const recorded = () => this.dependencies.adapterTransactions.run(context, async transaction => {
      const result = await transaction.query<{ status: string; result: { contentItemId?: string; contentVersionId?: string } }>(`SELECT status,result FROM app.command_receipts
       WHERE workspace_id=app_private.current_workspace_id() AND actor_user_id=app_private.current_user_id() AND command_name='companyContent.refreshSourceAttestation' AND idempotency_key=$1`, [key]);
      if (!result.rows[0]) return false; const row = result.rows[0];
      if (row.status !== 'succeeded' || row.result.contentItemId !== itemId || row.result.contentVersionId !== versionId) throw new MhpCommerceError(409, 'This publication check changed. Refresh the sequence.');
      return true;
    }, { readOnly: true });
    try {
      if (!await recorded()) try { await this.dependencies.adapter.refreshSourceAttestation(context, { commandKey: key, contentItemId: itemId, contentVersionId: versionId,
        expected: { source: { system: FOLLOWUP_SEQUENCE_SOURCE, itemId: exact.sourceItemId, version: exact.sourceVersion }, contentSha256: exact.contentSha256,
          blobSha256: exact.blobSha256, brandSha256: brand.sha256 }, attestation: { catalogSha256: exact.manifestSha256, checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900_000).toISOString() } }); }
      catch (error) { if (!await recorded()) throw error; }
      const requested = await this.dependencies.approvals.requestApproval(context, { commandKey: `mhp.sequence.publish.${commandId}.request`, contentItemId: itemId, contentVersionId: versionId, reviewNote: 'Native owner reviewed this exact follow-up sequence. No enrolment or send effect.' });
      await this.dependencies.approvals.decideApproval(context, { commandKey: `mhp.sequence.publish.${commandId}.approve`, approvalRequestId: requested.approvalRequestId, decision: 'approved', decisionNote: 'Published by native MHP owner; starting a sequence remains an explicit separate action.' });
    } catch (error) { const after = await this.review(identity, requestId, itemId, versionId); if (after.review.isLatest && after.review.approvalStatus === 'approved' && !after.review.approvalStale && after.local.valid) return; return failure(error); }
  }
  async command(identity: PortalSessionIdentity, requestId: string, input: MhpSequenceAction): Promise<MhpSequenceActionResult> {
    if (!uuid(input.commandId) || !uuid(input.versionId) || !uuid(input.itemId) || (input.runId && !uuid(input.runId)) || (input.ackProofId && !uuid(input.ackProofId))) throw new MhpCommerceError(400, 'Refresh the sequence controls before continuing.');
    const detail = await this.review(identity, requestId, input.itemId, input.versionId);
    if (['enrol', 'resume'].includes(input.action) && detail.blockers.length) throw new MhpCommerceError(409, 'This sequence is not ready to start. Publish the selected email versions and review any connection notes.');
    return this.dependencies.repository.command(identity, { ...input, campaign: this.dependencies.campaign, requestId });
  }
  async entryCommand(identity: PortalSessionIdentity, requestId: string, input: MhpEntryAction, now = Date.now()): Promise<MhpEntryActionResult> {
    if (!uuid(input.commandId) || !uuid(input.itemId) || !uuid(input.versionId) || (input.ruleId && !uuid(input.ruleId))
        || (input.action === 'activate' ? Boolean(input.ruleId) : !input.ruleId || Boolean(input.expiresAt))) throw new MhpCommerceError(400, 'Refresh the future-signup controls before continuing.');
    const detail = await this.review(identity, requestId, input.itemId, input.versionId);
    if (input.action === 'activate') {
      const expires = Date.parse(input.expiresAt);
      if (!Number.isFinite(expires) || expires <= now || new Date(expires).toISOString() !== input.expiresAt) throw new MhpCommerceError(400, 'Choose a valid future stop time in UTC.');
      if (!detail.review.isLatest || detail.review.approvalStatus !== 'approved' || detail.review.approvalStale || !detail.local.valid
          || detail.blockers.length || followupEntryIntent(detail.definition).mode !== 'webinar_signup') {
        throw new MhpCommerceError(409, 'Publish the latest ready sequence with future webinar entry selected before enabling its rule.');
      }
    }
    if (!this.dependencies.repository.entryCommand) throw new MhpCommerceError(503, 'Future webinar entry is not connected yet.');
    return this.dependencies.repository.entryCommand(identity, { ...input, campaign: this.dependencies.campaign, requestId });
  }
}
export function createMhpSequenceService(input: { web: Pool; identity: Pool; adapter: Pool; approvals: Pool; marketingWorkspace: Pick<PgMhpMarketingWorkspaceService, 'snapshot'>; emails: MhpOwnerEmailService; campaign: string }): MhpSequenceService {
  const transactions = mhpOwnerEmailContentRunner(input.adapter), webTransactions = mhpOwnerEmailContentRunner(input.web);
  const repository = new PgMhpSequenceRepository(input.web, input.identity), reader = new CompanyContentService({ transactionRunner: webTransactions });
  const adapter = new CompanyContentService({ transactionRunner: transactions }), approvals = new CompanyContentService({ transactionRunner: mhpOwnerEmailContentRunner(input.approvals) });
  let service!: MhpSequenceService;
  const messages = new LocalFlowMessages({ brand: 'mhp', authorize: (identity, requestId) => service.contentContext(identity, requestId),
    brandSnapshot: async (_context, identity) => parseMhpOwnerEmailBrand((await repository.snapshot(identity, input.campaign)).brand),
    reader, adapter, approvals, transactions, local: new FlowLocalStore(webTransactions), mhpEmail: input.emails });
  service = new MhpSequenceService({ marketingWorkspace: input.marketingWorkspace, repository, reader, adapter, approvals,
    adapterTransactions: transactions, emails: input.emails, campaign: input.campaign, messages });
  return service;
}
export type MhpSequenceSnapshot = Awaited<ReturnType<MhpSequenceService['snapshot']>>;
export type MhpSequenceReview = Awaited<ReturnType<MhpSequenceService['review']>>;
