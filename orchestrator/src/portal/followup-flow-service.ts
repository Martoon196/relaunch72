import type { Pool } from 'pg';
import { CompanyContentService, type CompanyContentTransactionRunner } from '../company-content-pg/index.js';
import type { PortalSessionIdentity } from './auth-service.js';
import { createPortalFlowContext, ppFlowContentRunner, type PortalFlowContext } from './followup-flow-context.js';
import { FOLLOWUP_SEQUENCE_MIME, FOLLOWUP_SEQUENCE_V2_SCHEMA, FOLLOWUP_SEQUENCE_UUID, canonicalFollowupSequence, followupActivationBlockers, followupTimeline,
  parseFollowupSequence, readCanonicalFollowupSequence, type FollowupChannel, type FollowupMessage, type FollowupSequenceDefinition, type FollowupSequenceReadiness } from '../followup-sequences/definition.js';
import { canonicalFlowMessage, previewFlowMessage } from '../followup-sequences/channel-drafts.js';
import { flowCommandUuid, parseFlowComposition, resolveFlowComposition, type FlowSavedMessageRef } from '../followup-sequences/composition.js';
import { ppFlowVersionCommand } from '../followup-sequences/content.js';
import { FlowLocalStore, checkedFlowLocalManifest, publishFlowLocal } from '../followup-sequences/local-store.js';
import { LocalFlowMessages, type FlowMessageReview } from '../followup-sequences/messages.js';
import { FlowWorkspaceError } from '../followup-sequences/workspace.js';
import { flowSimulationPreset, simulateFollowupFlow } from '../followup-sequences/simulation.js';
export const PP_FOLLOWUP_ROUTE = '/portal/follow-ups';
export const PP_FOLLOWUP_SOURCE = 'pp.followup-sequence';
export const PP_FOLLOWUP_CAMPAIGN = 'pp-owner-followup';
export interface PortalFlowSaveInput { readonly commandId: string; readonly contentItemId: string; readonly previousVersionId: string; readonly definition: unknown; readonly inlineMessages?: unknown }
const messageSteps = (definition: FollowupSequenceDefinition): readonly FollowupMessage[] => definition.steps.filter((step): step is FollowupMessage => step.kind !== 'wait');
/** Durable blueprint-only facade. Deliberately contains no enrol/activation/provider dependency. */
export class PortalFollowupFlowService {
  constructor(private readonly dependencies: {
    context: Pick<PortalFlowContext, 'authorize' | 'brand' | 'workspaceId'>;
    reader: Pick<CompanyContentService, 'listCatalog' | 'getExactReview'>; adapter: Pick<CompanyContentService, 'createVersion' | 'refreshSourceAttestation'>;
    approvals: Pick<CompanyContentService, 'requestApproval' | 'decideApproval'>; transactions: CompanyContentTransactionRunner; local: FlowLocalStore;
    messages: Pick<LocalFlowMessages, 'choices' | 'review' | 'save' | 'publish'>;
  }) {}
  readonly readiness: FollowupSequenceReadiness = Object.freeze({ email: false, sms: false, whatsapp: false, reply: false, booked: false, purchased: false });
  private context(identity: PortalSessionIdentity, requestId: string) { return this.dependencies.context.authorize({ sessionToken: identity.sessionToken, requestId }); }
  private checked(value: unknown) {
    const definition = parseFollowupSequence(value);
    if (definition.brand !== 'pp' || definition.campaign !== PP_FOLLOWUP_CAMPAIGN || definition.entry && definition.entry.mode !== 'manual') throw new FlowWorkspaceError(400, 'Use the Property Predator manual blueprint workspace.');
    return definition;
  }
  async snapshot(identity: PortalSessionIdentity, requestId: string) {
    const context = await this.context(identity, requestId);
    const [brand, catalog, messageChoices] = await Promise.all([this.dependencies.context.brand(context),
      this.dependencies.reader.listCatalog(context, { sourceSystem: PP_FOLLOWUP_SOURCE, limit: 50 }), this.dependencies.messages.choices(identity, requestId)]);
    return { brand, catalog, messageChoices, readiness: this.readiness, executable: false as const, workspaceId: context.workspaceId, campaign: PP_FOLLOWUP_CAMPAIGN };
  }
  async review(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string) {
    if (!FOLLOWUP_SEQUENCE_UUID.test(itemId) || !FOLLOWUP_SEQUENCE_UUID.test(versionId)) throw new FlowWorkspaceError(400, 'Choose an exact saved PP blueprint.');
    const context = await this.context(identity, requestId);
    const [review, local, brand] = await Promise.all([this.dependencies.reader.getExactReview(context, { contentItemId: itemId, contentVersionId: versionId }),
      this.dependencies.local.local(context, PP_FOLLOWUP_SOURCE, versionId, null), this.dependencies.context.brand(context)]);
    if (!review || !local || review.contentItemId !== itemId || review.contentVersionId !== versionId || review.source.system !== PP_FOLLOWUP_SOURCE || review.kind !== 'other'
        || review.contentMimeType !== FOLLOWUP_SEQUENCE_MIME) throw new FlowWorkspaceError(404, 'This blueprint is not in the selected PP workspace.');
    const definition = this.checked(readCanonicalFollowupSequence(review.canonicalContent)); let valid = true, manifestSha256: string | null = null;
    try { manifestSha256 = checkedFlowLocalManifest({ local, review, snapshot: brand, metadataKey: 'flowSequence', schema: 'growthhq.local-sequence/v1', manifestSchema: 'pp.followup-sequence-source/v1', workspaceId: context.workspaceId, campaign: PP_FOLLOWUP_CAMPAIGN }); }
    catch (error) { if (error instanceof FlowWorkspaceError && error.status === 409) valid = false; else throw error; }
    const blockers = new Set(followupActivationBlockers(definition, this.readiness)), messages: FlowMessageReview[] = [];
    for (const step of new Map(messageSteps(definition).map(step => [step.contentVersionId, step])).values()) try {
      const message = await this.dependencies.messages.review(identity, requestId, step.kind, step.contentItemId, step.contentVersionId); messages.push(message);
      if (!message.valid || !message.review.isLatest || message.review.contentSha256 !== step.contentSha256) blockers.add('message_needs_review');
    } catch (error) { if (error instanceof FlowWorkspaceError && [404, 409].includes(error.status)) blockers.add('message_needs_review'); else throw error; }
    return { review, local, brand, definition, valid, manifestSha256, messages, blockers: [...blockers], timeline: followupTimeline(definition) };
  }
  async preview(identity: PortalSessionIdentity, requestId: string, value: unknown, inlineValue?: unknown) {
    const context = await this.context(identity, requestId); await this.dependencies.context.brand(context);
    const composition = inlineValue === undefined ? null : parseFlowComposition(value, inlineValue), definition = this.checked(composition?.definition ?? value);
    const previews: ReturnType<typeof previewFlowMessage>[] = [];
    for (const step of messageSteps(definition)) {
      const inline = composition?.inlineMessages[step.key];
      if (inline) previews.push(previewFlowMessage(step.kind, inline.payload));
      else {
        const message = await this.dependencies.messages.review(identity, requestId, step.kind, step.contentItemId, step.contentVersionId);
        if (message.review.contentSha256 !== step.contentSha256) throw new FlowWorkspaceError(409, 'The selected message hash changed.');
        previews.push(previewFlowMessage(step.kind, message.payload));
      }
    }
    return { definition, timeline: followupTimeline(definition), blockers: followupActivationBlockers(definition, this.readiness), messagePreviews: previews };
  }
  async simulate(identity: PortalSessionIdentity, requestId: string, value: unknown, inlineValue?: unknown, scenario = 'happy') {
    const preview = await this.preview(identity, requestId, value, inlineValue);
    return { ...preview, simulation: simulateFollowupFlow(preview.definition, this.readiness, flowSimulationPreset(scenario, preview.definition)) };
  }
  async save(identity: PortalSessionIdentity, requestId: string, input: PortalFlowSaveInput, now = Date.now()) {
    if (!FOLLOWUP_SEQUENCE_UUID.test(input.commandId) || Boolean(input.contentItemId) !== Boolean(input.previousVersionId)) throw new FlowWorkspaceError(400, 'Refresh the PP flow form before saving.');
    const context = await this.context(identity, requestId), brand = await this.dependencies.context.brand(context);
    const composition = input.inlineMessages === undefined ? null : parseFlowComposition(input.definition, input.inlineMessages);
    let definition = this.checked(composition?.definition ?? input.definition);
    if (composition) {
      const actual: Record<string, FlowSavedMessageRef> = {};
      for (const [key, message] of Object.entries(composition.inlineMessages)) actual[key] = await this.dependencies.messages.save(identity, requestId, flowCommandUuid(input.commandId, key), message, now);
      definition = this.checked(resolveFlowComposition(composition, actual));
    }
    // Every durable reference must resolve actual same-brand0021content, even while the blueprint is not executable.
    for (const step of messageSteps(definition)) {
      const message = await this.dependencies.messages.review(identity, requestId, step.kind, step.contentItemId, step.contentVersionId);
      if (message.review.contentSha256 !== step.contentSha256 || canonicalFlowMessage(step.kind, message.payload) !== message.review.canonicalContent) throw new FlowWorkspaceError(409, 'Choose the exact saved message version for this step.');
    }
    const canonical = canonicalFollowupSequence(definition), replay = async () => {
      const saved = await this.dependencies.local.local(context, PP_FOLLOWUP_SOURCE, null, `edit:${input.commandId}`); if (!saved) return null;
      if (saved.canonicalContent !== canonical || saved.previousVersionId !== (input.previousVersionId || null) || input.contentItemId && saved.contentItemId !== input.contentItemId) throw new FlowWorkspaceError(409, 'This flow save command already has different details.');
      return { contentItemId: saved.contentItemId, contentVersionId: saved.contentVersionId, replayed: true };
    };
    const existing = await replay(); if (existing) return existing;
    const previous = input.contentItemId ? await this.review(identity, requestId, input.contentItemId, input.previousVersionId) : null;
    if (previous && !previous.review.isLatest) throw new FlowWorkspaceError(409, 'Open the latest blueprint before editing it.');
    const command = ppFlowVersionCommand({ workspaceId: context.workspaceId, snapshot: brand, commandId: input.commandId, definition,
      previous: previous ? { contentItemId: previous.review.contentItemId, contentVersionId: previous.review.contentVersionId, sourceItemId: previous.review.source.itemId } : null, now });
    try { const result = await this.dependencies.adapter.createVersion(context, command); return { contentItemId: result.contentItemId, contentVersionId: result.contentVersionId, replayed: result.disposition === 'replayed' }; }
    catch (error) { const winner = await replay(); if (winner) return winner; throw error; }
  }
  async publish(identity: PortalSessionIdentity, requestId: string, itemId: string, versionId: string, commandId: string, now = Date.now()): Promise<void> {
    if (!FOLLOWUP_SEQUENCE_UUID.test(commandId)) throw new FlowWorkspaceError(400, 'Refresh the blueprint Publish action.');
    const context = await this.context(identity, requestId), detail = await this.review(identity, requestId, itemId, versionId), selected = messageSteps(detail.definition);
    if (!detail.valid || !detail.review.isLatest || !detail.manifestSha256 || detail.messages.length !== new Set(selected.map(step => step.contentVersionId)).size
        || detail.messages.some(message => !message.valid || !message.review.isLatest)
        || selected.some(step => !detail.messages.some(message => message.review.contentVersionId === step.contentVersionId && message.review.contentItemId === step.contentItemId && message.review.contentSha256 === step.contentSha256))) throw new FlowWorkspaceError(409, 'Review the latest exact local message bundle before publishing this blueprint.');
    const done = new Set<string>();
    for (const step of selected) if (!done.has(step.contentVersionId)) { await this.dependencies.messages.publish(identity, requestId, step.kind, step.contentItemId, step.contentVersionId, flowCommandUuid(commandId, step.key), now); done.add(step.contentVersionId); }
    await publishFlowLocal({ context, review: detail.review, local: detail.local, snapshot: detail.brand, manifestSha256: detail.manifestSha256,
      commandId, now, adapter: this.dependencies.adapter, approvals: this.dependencies.approvals, transactions: this.dependencies.transactions });
  }
  async message(identity: PortalSessionIdentity, requestId: string, channel: FollowupChannel, itemId: string, versionId: string) {
    const detail = await this.dependencies.messages.review(identity, requestId, channel, itemId, versionId);
    return { channel, title: detail.review.title, contentItemId: detail.review.contentItemId, contentVersionId: detail.review.contentVersionId, contentSha256: detail.review.contentSha256, payload: detail.payload };
  }
}
export function ppNewFlow(commandId: string): PortalFlowSaveInput {
  return { commandId, contentItemId: '', previousVersionId: '', definition: { schema: FOLLOWUP_SEQUENCE_V2_SCHEMA, brand: 'pp', campaign: PP_FOLLOWUP_CAMPAIGN,
    title: 'New PP follow-up flow', expiryHours: 24, entry: { mode: 'manual', source: 'manual_owner' }, stopOn: { reply: false, booked: false, purchased: false }, steps: [] } };
}
export function createPortalFollowupFlowService(input: { webPool: Pool; adapterPool: Pool; commandPool: Pool; workspaceId: string }) {
  const native = createPortalFlowContext(input.webPool, input.workspaceId), web = ppFlowContentRunner(input.webPool, input.workspaceId), transactions = ppFlowContentRunner(input.adapterPool, input.workspaceId);
  const reader = new CompanyContentService({ transactionRunner: web }), adapter = new CompanyContentService({ transactionRunner: transactions });
  const approvals = new CompanyContentService({ transactionRunner: ppFlowContentRunner(input.commandPool, input.workspaceId) }), local = new FlowLocalStore(web);
  const messages = new LocalFlowMessages({ brand: 'pp', authorize: (identity, requestId) => native.authorize({ sessionToken: identity.sessionToken, requestId }),
    brandSnapshot: context => native.brand(context), reader, adapter, approvals, transactions, local });
  return new PortalFollowupFlowService({ context: native, reader, adapter, approvals, transactions, local, messages });
}
export type PortalFlowSnapshot = Awaited<ReturnType<PortalFollowupFlowService['snapshot']>>;
export type PortalFlowReview = Awaited<ReturnType<PortalFollowupFlowService['review']>>;
