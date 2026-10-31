import { canonicalCompanyContentJson, type CompanyContentExactReview, type CompanyContentService, type CompanyContentTransactionRunner } from '../company-content-pg/index.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import { FOLLOWUP_SEQUENCE_UUID, followupSequenceSha } from './definition.js';
import { FlowWorkspaceError, type FlowBrandSnapshot } from './workspace.js';
export interface FlowStoredLocal {
  readonly contentItemId: string; readonly contentVersionId: string; readonly sourceItemId: string; readonly sourceVersion: string;
  readonly previousVersionId: string | null; readonly canonicalContent: string; readonly contentSha256: string;
  readonly title: string;
  readonly authorAllowed: boolean;
  readonly blobStorageKey: string; readonly brandSnapshotRef: string; readonly metadata: Record<string, unknown>;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Existing0021rows only. Role/RLS/session authorization is supplied by the brand's native transaction runner. */
export class FlowLocalStore {
  constructor(private readonly reader: CompanyContentTransactionRunner) {}
  async local(context: DatabaseRequestContext, source: string, version: string | null, revision: string | null): Promise<FlowStoredLocal | null> {
    if ((version === null) === (revision === null) || version !== null && !FOLLOWUP_SEQUENCE_UUID.test(version)
        || revision !== null && !/^edit:[0-9a-f-]{36}$/u.test(revision) || !/^(?:mhp|pp)\.(?:owner-(?:email|sms|whatsapp)|followup-sequence)$/u.test(source)) throw new FlowWorkspaceError(400, 'Choose an exact saved local version.');
    return this.reader.run(context, async transaction => {
      const result = await transaction.query<FlowStoredLocal & Record<string, unknown>>(`/* followup-flow.local-version */
       SELECT content_item_id::text AS "contentItemId",id::text AS "contentVersionId",source_item_id AS "sourceItemId",source_version AS "sourceVersion",
        previous_version_id::text AS "previousVersionId",title,content_body AS "canonicalContent",encode(content_sha256,'hex') AS "contentSha256",
        blob_storage_key AS "blobStorageKey",brand_snapshot_ref AS "brandSnapshotRef",metadata,
        app_private.can_manage_workspace(created_by_user_id,workspace_id) AS "authorAllowed"
       FROM app.company_content_versions WHERE workspace_id=app_private.current_workspace_id() AND source_system=$1
        AND (($2::uuid IS NOT NULL AND id=$2) OR ($3::text IS NOT NULL AND source_version=$3))`, [source, version, revision]);
      if (!result.rows.length) return null;
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row || !FOLLOWUP_SEQUENCE_UUID.test(row.contentItemId) || !FOLLOWUP_SEQUENCE_UUID.test(row.contentVersionId)
          || typeof row.canonicalContent !== 'string' || followupSequenceSha(row.canonicalContent) !== row.contentSha256 || !record(row.metadata)
          || typeof row.authorAllowed !== 'boolean' || !/^edit:[0-9a-f-]{36}$/u.test(row.sourceVersion)
          || !row.sourceItemId.startsWith(`${source.endsWith('followup-sequence') ? 'sequence' : source.split('.').at(-1)}:`)) throw new FlowWorkspaceError(503, 'The exact local content could not be verified.');
      return row;
    }, { readOnly: true });
  }
}
export function checkedFlowLocalManifest(input: { local: FlowStoredLocal; review: CompanyContentExactReview; snapshot: FlowBrandSnapshot;
  metadataKey: 'flowMessage' | 'flowSequence' | 'mhpChannelDraft'; schema: string; manifestSchema: string; workspaceId: string; channel?: string; campaign?: string }): string {
  const { local, review, snapshot } = input, meta = local.metadata[input.metadataKey];
  if (!record(meta) || meta.schema !== input.schema || meta.authoredBy !== 'native-owner' || !local.authorAllowed || meta.brandCanonical !== snapshot.canonical
      || typeof meta.manifestCanonical !== 'string' || meta.manifestSha256 !== followupSequenceSha(meta.manifestCanonical)
      || local.contentItemId !== review.contentItemId || local.contentVersionId !== review.contentVersionId || local.canonicalContent !== review.canonicalContent
      || local.contentSha256 !== review.contentSha256 || review.blobSha256 !== review.contentSha256 || review.brandSha256 !== snapshot.sha256
      || local.brandSnapshotRef !== snapshot.ref || local.blobStorageKey !== `inline:${review.source.system}:${review.contentSha256}`) throw new FlowWorkspaceError(409, 'The message or flow needs a fresh local version with the current brand.');
  const manifest = canonicalCompanyContentJson({ schema: input.manifestSchema, workspaceId: input.workspaceId,
    sourceSystem: review.source.system, sourceItemId: review.source.itemId, sourceVersion: review.source.version,
    contentSha256: review.contentSha256, blobStorageKey: local.blobStorageKey, blobSha256: review.blobSha256,
    brandSnapshotRef: snapshot.ref, brandSha256: snapshot.sha256, ...(input.channel ? { channel: input.channel } : { audienceCampaign: input.campaign }) });
  if (manifest !== meta.manifestCanonical) throw new FlowWorkspaceError(409, 'The local source manifest does not match this exact content.');
  return followupSequenceSha(manifest);
}
export async function publishFlowLocal(input: { context: DatabaseRequestContext; review: CompanyContentExactReview; local: FlowStoredLocal;
  snapshot: FlowBrandSnapshot; manifestSha256: string; commandId: string; now: number;
  adapter: Pick<CompanyContentService, 'refreshSourceAttestation'>; approvals: Pick<CompanyContentService, 'requestApproval' | 'decideApproval'>; transactions: CompanyContentTransactionRunner }): Promise<void> {
  const { review, context } = input;
  if (!FOLLOWUP_SEQUENCE_UUID.test(input.commandId) || !review.isLatest) throw new FlowWorkspaceError(409, 'Review the latest saved version before publishing.');
  if (review.approvalStatus === 'approved' && !review.approvalStale) return;
  const prefix = `flow.publish.${input.commandId}`, refresh = `${prefix}.refresh`;
  const recorded = () => input.transactions.run(context, async transaction => {
    const rows = await transaction.query<{ status: string; result: { contentItemId?: string; contentVersionId?: string } }>(`SELECT status,result FROM app.command_receipts
     WHERE workspace_id=app_private.current_workspace_id() AND actor_user_id=app_private.current_user_id()
      AND command_name='companyContent.refreshSourceAttestation' AND idempotency_key=$1`, [refresh]);
    const row = rows.rows[0]; if (!row) return false;
    if (row.status !== 'succeeded' || row.result.contentItemId !== review.contentItemId || row.result.contentVersionId !== review.contentVersionId) throw new FlowWorkspaceError(409, 'This publication command belongs to different content.');
    return true;
  }, { readOnly: true });
  if (!await recorded()) try {
    await input.adapter.refreshSourceAttestation(context, { commandKey: refresh, contentItemId: review.contentItemId, contentVersionId: review.contentVersionId,
      expected: { source: review.source, contentSha256: review.contentSha256, blobSha256: review.blobSha256, brandSha256: input.snapshot.sha256 },
      attestation: { catalogSha256: input.manifestSha256, checkedAt: new Date(input.now).toISOString(), expiresAt: new Date(input.now + 900_000).toISOString() } });
  } catch (error) { if (!await recorded()) throw error; }
  const request = await input.approvals.requestApproval(context, { commandKey: `${prefix}.request`, contentItemId: review.contentItemId, contentVersionId: review.contentVersionId,
    reviewNote: 'Native owner reviewed this exact local flow/message blueprint. No provider approval, enrolment or send effect.' });
  await input.approvals.decideApproval(context, { commandKey: `${prefix}.approve`, approvalRequestId: request.approvalRequestId, decision: 'approved',
    decisionNote: 'Exact local intent approved by native owner. Provider and recipient readiness remain separate.' });
}
