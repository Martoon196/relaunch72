import { canonicalCompanyContentJson, type CreateCompanyContentVersionCommand } from '../company-content-pg/index.js';
import { FOLLOWUP_SEQUENCE_MIME, FOLLOWUP_SEQUENCE_UUID, canonicalFollowupSequence, followupSequenceSha, type FollowupBrand, type FollowupChannel, type FollowupSequenceDefinition } from './definition.js';
import { canonicalFlowMessage, flowMessageContract } from './channel-drafts.js';
import { FlowWorkspaceError, type FlowBrandSnapshot } from './workspace.js';
export interface FlowContentPrevious { readonly contentItemId: string; readonly contentVersionId: string; readonly sourceItemId: string }
export interface FlowLocalMetadata { readonly schema: string; readonly authoredBy: 'native-owner'; readonly brandCanonical: string; readonly manifestCanonical: string; readonly manifestSha256: string }
function uuid(value: string): void { if (!FOLLOWUP_SEQUENCE_UUID.test(value)) throw new FlowWorkspaceError(400, 'Refresh the flow form before saving.'); }
function title(value: string): void { if (value !== value.trim() || value.length < 1 || value.length > 180 || /[\u0000-\u001f\u007f]/u.test(value)) throw new FlowWorkspaceError(400, 'Give the message a name of 1–180 characters.'); }
export function flowMessageVersionCommand(input: { brand: FollowupBrand; workspaceId: string; snapshot: FlowBrandSnapshot; channel: FollowupChannel;
  commandId: string; title: string; payload: unknown; previous: FlowContentPrevious | null; now: number }): CreateCompanyContentVersionCommand {
  uuid(input.commandId); uuid(input.workspaceId); title(input.title);
  if (input.brand === 'mhp' && input.channel === 'email') throw new FlowWorkspaceError(400, 'MHP email uses its existing native email editor command.');
  const contract = flowMessageContract(input.brand, input.channel), canonical = canonicalFlowMessage(input.channel, input.payload), sha = followupSequenceSha(canonical);
  const item = input.previous?.sourceItemId ?? `owner-${input.channel}:${input.commandId}`, version = `edit:${input.commandId}`, storage = `inline:${contract.source}:${sha}`;
  const manifest = canonicalCompanyContentJson({ schema: input.brand === 'mhp' ? 'mhp.channel-draft-source/v1' : 'pp.owner-message-source/v1', workspaceId: input.workspaceId,
    sourceSystem: contract.source, sourceItemId: item, sourceVersion: version, contentSha256: sha, blobStorageKey: storage, blobSha256: sha,
    brandSnapshotRef: input.snapshot.ref, brandSha256: input.snapshot.sha256, channel: input.channel });
  const metadata: FlowLocalMetadata = { schema: input.brand === 'mhp' ? 'mhp.channel-draft-local/v1' : 'growthhq.local-message/v1', authoredBy: 'native-owner',
    brandCanonical: input.snapshot.canonical, manifestCanonical: manifest, manifestSha256: followupSequenceSha(manifest) };
  return { commandKey: `${input.brand}.flow.message.${input.commandId}`, contentItemId: input.previous?.contentItemId ?? null,
    previousVersionId: input.previous?.contentVersionId ?? null, origin: input.previous ? 'edited' : 'imported', kind: contract.kind, title: input.title,
    contentMimeType: contract.mime, content: canonical, source: { system: contract.source, itemId: item, version }, blob: { storageKey: storage, sha256: sha },
    brand: { snapshotRef: input.snapshot.ref, sha256: input.snapshot.sha256 }, attestation: { catalogSha256: followupSequenceSha(manifest), checkedAt: new Date(input.now).toISOString(), expiresAt: new Date(input.now + 900_000).toISOString() },
    metadata: { [input.brand === 'mhp' ? 'mhpChannelDraft' : 'flowMessage']: metadata } };
}
export function ppFlowVersionCommand(input: { workspaceId: string; snapshot: FlowBrandSnapshot; commandId: string; definition: FollowupSequenceDefinition; previous: FlowContentPrevious | null; now: number }): CreateCompanyContentVersionCommand {
  uuid(input.commandId); uuid(input.workspaceId);
  if (input.definition.brand !== 'pp' || input.definition.campaign !== 'pp-owner-followup') throw new FlowWorkspaceError(400, 'This blueprint belongs to another brand or audience.');
  const canonical = canonicalFollowupSequence(input.definition), sha = followupSequenceSha(canonical), item = input.previous?.sourceItemId ?? `sequence:${input.commandId}`;
  const version = `edit:${input.commandId}`, storage = `inline:pp.followup-sequence:${sha}`;
  const manifest = canonicalCompanyContentJson({ schema: 'pp.followup-sequence-source/v1', workspaceId: input.workspaceId, sourceSystem: 'pp.followup-sequence',
    sourceItemId: item, sourceVersion: version, contentSha256: sha, blobStorageKey: storage, blobSha256: sha,
    brandSnapshotRef: input.snapshot.ref, brandSha256: input.snapshot.sha256, audienceCampaign: input.definition.campaign });
  return { commandKey: `pp.flow.save.${input.commandId}`, contentItemId: input.previous?.contentItemId ?? null, previousVersionId: input.previous?.contentVersionId ?? null,
    origin: input.previous ? 'edited' : 'imported', kind: 'other', title: input.definition.title, contentMimeType: FOLLOWUP_SEQUENCE_MIME, content: canonical,
    source: { system: 'pp.followup-sequence', itemId: item, version }, blob: { storageKey: storage, sha256: sha }, brand: { snapshotRef: input.snapshot.ref, sha256: input.snapshot.sha256 },
    attestation: { catalogSha256: followupSequenceSha(manifest), checkedAt: new Date(input.now).toISOString(), expiresAt: new Date(input.now + 900_000).toISOString() },
    metadata: { flowSequence: { schema: 'growthhq.local-sequence/v1', authoredBy: 'native-owner', brandCanonical: input.snapshot.canonical, manifestCanonical: manifest, manifestSha256: followupSequenceSha(manifest) } } };
}
