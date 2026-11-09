import type { CompanyContentService, CompanyContentTransactionRunner, CompanyContentExactReview } from '../company-content-pg/index.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import type { MhpOwnerEmailService } from '../mhp/owner-email-service.js';
import { canonicalFlowMessage, flowMessageContract, readFlowMessage, type FlowMessageDraft } from './channel-drafts.js';
import { FOLLOWUP_SEQUENCE_UUID, followupSequenceSha, type FollowupBrand, type FollowupChannel } from './definition.js';
import { flowMessageVersionCommand } from './content.js';
import type { FlowInlineMessage } from './composition.js';
import type { FlowMessageChoice } from './editor-view.js';
import { checkedFlowLocalManifest, FlowLocalStore, publishFlowLocal, type FlowStoredLocal } from './local-store.js';
import { FlowWorkspaceError, type FlowBrandSnapshot } from './workspace.js';
export interface FlowMessageReview { readonly review: CompanyContentExactReview; readonly channel: FollowupChannel; readonly payload: FlowMessageDraft;
  readonly valid: boolean; readonly manifestSha256: string | null; readonly local: FlowStoredLocal | null }
export class LocalFlowMessages {
  constructor(private readonly dependencies: {
    brand: FollowupBrand; authorize(identity: PortalSessionIdentity, requestId: string): Promise<DatabaseRequestContext>;
    brandSnapshot(context: DatabaseRequestContext, identity: PortalSessionIdentity): Promise<FlowBrandSnapshot>;
    reader: Pick<CompanyContentService, 'listCatalog' | 'getExactReview'>; adapter: Pick<CompanyContentService, 'createVersion' | 'refreshSourceAttestation'>;
    approvals: Pick<CompanyContentService, 'requestApproval' | 'decideApproval'>; transactions: CompanyContentTransactionRunner; local: FlowLocalStore;
    mhpEmail?: Pick<MhpOwnerEmailService, 'review' | 'save' | 'publish'>;
  }) {}
  async choices(identity: PortalSessionIdentity, requestId: string): Promise<readonly FlowMessageChoice[]> {
    const context = await this.dependencies.authorize(identity, requestId), choices: FlowMessageChoice[] = [];
    for (const channel of ['email', 'sms', 'whatsapp'] as const) {
      const catalog = await this.dependencies.reader.listCatalog(context, { sourceSystem: flowMessageContract(this.dependencies.brand, channel).source, limit: 50 });
      for (const item of catalog.items) choices.push({ channel, itemId: item.contentItemId, versionId: item.contentVersionId, sha256: item.contentSha256,
        label: `${item.title} · v${item.versionNumber}${item.approvalStatus === 'approved' && !item.approvalStale ? ' · locally published' : ' · draft'}` });
    }
    return choices;
  }
  async review(identity: PortalSessionIdentity, requestId: string, channel: FollowupChannel, itemId: string, versionId: string): Promise<FlowMessageReview> {
    if (!FOLLOWUP_SEQUENCE_UUID.test(itemId) || !FOLLOWUP_SEQUENCE_UUID.test(versionId)) throw new FlowWorkspaceError(400, 'Choose an exact saved message.');
    const context = await this.dependencies.authorize(identity, requestId), contract = flowMessageContract(this.dependencies.brand, channel);
    if (this.dependencies.brand === 'mhp' && channel === 'email') {
      if (!this.dependencies.mhpEmail) throw new FlowWorkspaceError(503, 'The existing MHP email editor is unavailable.');
      const email = await this.dependencies.mhpEmail.review(identity, requestId, itemId, versionId);
      return { review: email.review, channel, payload: readFlowMessage(channel, email.review.canonicalContent), valid: email.local.valid,
        manifestSha256: email.local.exact?.manifestSha256 ?? null, local: null };
    }
    const [review, local, brand] = await Promise.all([this.dependencies.reader.getExactReview(context, { contentItemId: itemId, contentVersionId: versionId }),
      this.dependencies.local.local(context, contract.source, versionId, null), this.dependencies.brandSnapshot(context, identity)]);
    if (!review || !local || review.contentItemId !== itemId || review.contentVersionId !== versionId || review.source.system !== contract.source
        || review.kind !== contract.kind || review.contentMimeType !== contract.mime) throw new FlowWorkspaceError(404, 'That exact message is not in this brand’s local library.');
    const payload = readFlowMessage(channel, review.canonicalContent); let valid = true, manifestSha256: string | null = null;
    try { manifestSha256 = checkedFlowLocalManifest({ local, review, snapshot: brand, metadataKey: this.dependencies.brand === 'mhp' ? 'mhpChannelDraft' : 'flowMessage',
      schema: this.dependencies.brand === 'mhp' ? 'mhp.channel-draft-local/v1' : 'growthhq.local-message/v1', manifestSchema: this.dependencies.brand === 'mhp' ? 'mhp.channel-draft-source/v1' : 'pp.owner-message-source/v1', workspaceId: context.workspaceId, channel }); }
    catch (error) { if (error instanceof FlowWorkspaceError && error.status === 409) valid = false; else throw error; }
    return { review, channel, payload, valid, manifestSha256, local };
  }
  async save(identity: PortalSessionIdentity, requestId: string, commandId: string, input: FlowInlineMessage, now = Date.now()) {
    if (!FOLLOWUP_SEQUENCE_UUID.test(commandId)) throw new FlowWorkspaceError(400, 'Refresh the inline message form.');
    const context = await this.dependencies.authorize(identity, requestId), canonical = canonicalFlowMessage(input.channel, input.payload), sha = followupSequenceSha(canonical);
    if (Boolean(input.contentItemId) !== Boolean(input.previousVersionId)) throw new FlowWorkspaceError(400, 'Choose the exact message predecessor.');
    if (this.dependencies.brand === 'mhp' && input.channel === 'email') {
      if (!this.dependencies.mhpEmail || !('subject' in input.payload)) throw new FlowWorkspaceError(503, 'The existing MHP email editor is unavailable.');
      const saved = await this.dependencies.mhpEmail.save(identity, requestId, { commandId, title: input.title, subject: input.payload.subject, bodyText: input.payload.bodyText,
        contentItemId: input.contentItemId, previousVersionId: input.previousVersionId }, now);
      return { ...saved, contentSha256: sha };
    }
    const source = flowMessageContract(this.dependencies.brand, input.channel).source;
    const replay = async () => {
      const row = await this.dependencies.local.local(context, source, null, `edit:${commandId}`); if (!row) return null;
      if (row.canonicalContent !== canonical || row.title !== input.title || row.previousVersionId !== (input.previousVersionId || null)
          || input.contentItemId && row.contentItemId !== input.contentItemId) throw new FlowWorkspaceError(409, 'This message command already has different text.');
      return { contentItemId: row.contentItemId, contentVersionId: row.contentVersionId, contentSha256: row.contentSha256, replayed: true };
    };
    const saved = await replay(); if (saved) return saved;
    const old = input.contentItemId ? await this.review(identity, requestId, input.channel, input.contentItemId, input.previousVersionId) : null;
    if (old && !old.review.isLatest) throw new FlowWorkspaceError(409, 'Open the latest message before editing it.');
    const brand = await this.dependencies.brandSnapshot(context, identity), command = flowMessageVersionCommand({ brand: this.dependencies.brand, workspaceId: context.workspaceId,
      snapshot: brand, channel: input.channel, commandId, title: input.title, payload: input.payload,
      previous: old ? { contentItemId: old.review.contentItemId, contentVersionId: old.review.contentVersionId, sourceItemId: old.review.source.itemId } : null, now });
    try { const result = await this.dependencies.adapter.createVersion(context, command);
      if (result.contentSha256 !== sha) throw new FlowWorkspaceError(503, 'The saved message hash could not be verified.');
      return { contentItemId: result.contentItemId, contentVersionId: result.contentVersionId, contentSha256: result.contentSha256, replayed: result.disposition === 'replayed' };
    } catch (error) { const winner = await replay(); if (winner) return winner; throw error; }
  }
  async publish(identity: PortalSessionIdentity, requestId: string, channel: FollowupChannel, itemId: string, versionId: string, commandId: string, now = Date.now()): Promise<void> {
    const context = await this.dependencies.authorize(identity, requestId), detail = await this.review(identity, requestId, channel, itemId, versionId);
    if (!detail.valid || !detail.review.isLatest) throw new FlowWorkspaceError(409, 'Review a current message version with the current brand before publishing the flow.');
    if (this.dependencies.brand === 'mhp' && channel === 'email') { await this.dependencies.mhpEmail!.publish(identity, requestId, itemId, versionId, commandId, now); return; }
    if (!detail.local || !detail.manifestSha256) throw new FlowWorkspaceError(409, 'This message is missing its exact local source manifest.');
    await publishFlowLocal({ context, review: detail.review, local: detail.local, snapshot: await this.dependencies.brandSnapshot(context, identity), manifestSha256: detail.manifestSha256,
      commandId, now, adapter: this.dependencies.adapter, approvals: this.dependencies.approvals, transactions: this.dependencies.transactions });
  }
}
