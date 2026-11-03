/** Adapter for the reviewed image coordinator and SQL-owned media boundaries. */
import { createHash } from 'node:crypto';
import { canonicalCompanyContentJson } from '../company-content-pg/validation.js';
import { prepareImageGenerationRequest, type ImageGenerationCommand, type ImageGenerationReceipt } from './image-generation.js';
import { type CommittedImageReceipt, type ImageJobDependencies, type ImageJobHoldCode } from './image-jobs.js';
import { IMAGE_PROPOSAL_SCHEMA, isImageJob, type ArticleImageProposal, type ArticleImageService } from './image-campaign.js';
import { imageCommandFromSource, imageIntentSha } from './image-intent.js';
import { imageResultMessage, runStoredImageJob } from './image-worker.js';
import type { PgSeoBlogMediaStore } from './media-store.js';
import type { SeoImageReceiptResult, SeoMediaAsset } from './media-types.js';
import type { PgSeoBlogPrincipal } from './pg-store.js';
import type { SeoBlogStore } from './store.js';
import { SeoBlogError, type Article, type Job } from './types.js';

type MediaPort = Pick<PgSeoBlogMediaStore, 'recoverImageIntentRequest' | 'readImagePolicy' | 'readImageSourceSnapshot' | 'initializeImageIntent' | 'commitImageAttempt'
  | 'commitImageAttemptReceipt' | 'loadPrivateAsset' | 'commitPreparation' | 'applyPreparedImageBoundary'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
function commandId(value: string): string {
  const sha = createHash('sha256').update(value).digest('hex');
  return `${sha.slice(0, 8)}-${sha.slice(8, 12)}-5${sha.slice(13, 16)}-8${sha.slice(17, 20)}-${sha.slice(20, 32)}`;
}
function holdCode(value: string | null): ImageJobHoldCode {
  const codes: Readonly<Record<string, ImageJobHoldCode>> = {
    provider_unconfigured: 'provider_unconfigured', policy_disabled: 'policy_disabled', policy_changed: 'policy_changed',
    image_allowance_exhausted: 'budget_exceeded', budget_exceeded: 'budget_exceeded', operator_budget_exhausted: 'budget_exceeded',
    concurrency_exhausted: 'concurrency_exhausted', programme_paused: 'paused', source_changed: 'source_changed',
    global_concurrency: 'concurrency_exhausted', global_cost_reservation: 'budget_exceeded', brand_image_allowance: 'budget_exceeded',
    operator_policy_changed: 'policy_changed', operator_policy_disabled: 'policy_disabled', operator_model_mismatch: 'policy_changed', claim_or_intent_changed: 'source_changed',
    source_missing: 'source_changed', profile_unconfirmed: 'source_changed', profile_facts_changed: 'source_changed', sponsor_changed: 'sponsor_revoked',
    sponsor_ineligible: 'sponsor_revoked', claim_changed: 'source_changed', image_generation_disabled: 'not_ready', ongoing_production_disabled: 'paused',
  };
  return codes[value ?? ''] ?? 'not_ready';
}
function receipt(result: SeoImageReceiptResult, reservedRequestSha256: string): CommittedImageReceipt {
  const value = result.receipt;
  const actual = value.requestSha256;
  if (typeof actual !== 'string' || !SHA.test(actual) || !['not_started', 'candidate_received', 'rejected', 'outcome_unknown'].includes(String(value.outcome))) throw new Error('Image receipt could not be confirmed.');
  return { commitAcknowledged: true, attemptId: result.attemptId, nonce: result.nonce, reservedRequestSha256,
    receivedRequestSha256: actual, outcome: value.outcome as ImageGenerationReceipt['outcome'],
    candidate: result.candidate ? { assetId: result.candidate.id, sha256: result.candidate.sha256 } : null,
    applyEligible: result.applyEligible, ...(result.hold ? { holdCode: holdCode(result.hold) } : {}) };
}
function proposedVariant(asset: SeoMediaAsset): ArticleImageProposal['variants'][number] {
  if (asset.kind !== 'variant' || asset.validation !== 'prepared_jpeg' || !asset.recipe || !asset.width || !asset.height) throw new Error('Prepared image metadata is unavailable.');
  return { assetId: asset.id, sha256: asset.sha256, profile: asset.recipe.profile, width: asset.width, height: asset.height };
}

export function createPgArticleImageService(input: {
  readonly media: MediaPort;
  readonly store: SeoBlogStore;
  readonly principal: PgSeoBlogPrincipal;
  readonly providerConfigured: boolean;
  generate(command: ImageGenerationCommand, signal?: AbortSignal): Promise<ImageGenerationReceipt>;
  readonly now?: () => string;
}): ArticleImageService {
  const now = input.now ?? (() => new Date().toISOString());
  return { configured: input.providerConfigured,
    async request(request) {
      if (!UUID.test(request.commandId) || !UUID.test(request.sponsorUserId)) throw new SeoBlogError(400, 'Invalid image intent.');
      if (request.origin === 'owner' ? input.principal.kind !== 'user' || input.principal.userId !== request.sponsorUserId : input.principal.kind !== 'worker') throw new SeoBlogError(403, 'Image intent authority does not match the actual session or worker.');
      const replay = await input.media.recoverImageIntentRequest(request.brandId, { commandId: request.commandId, articleId: request.articleId, articleVersionId: request.expectedVersionId, origin: request.origin });
      if (replay) return { kind: 'job', job: replay };
      const existing = await input.store.getJob(request.brandId, request.commandId);
      if (existing) {
        if (!isImageJob(existing)) throw new SeoBlogError(409, 'This command belongs to another task.');
        const image = existing.payload.image as Record<string, unknown>;
        if (image.articleId !== request.articleId || image.articleVersionId !== request.expectedVersionId) throw new SeoBlogError(409, 'This command belongs to different article inputs.');
        return { kind: 'job', job: existing };
      }
      const source = await input.media.readImageSourceSnapshot(request.brandId, request.articleId);
      if (source.articleVersionId !== request.expectedVersionId) throw new SeoBlogError(409, 'The article changed before this image intent was saved.');
      const [version, profile, knowledge, policy] = await Promise.all([input.store.getVersion(request.brandId, request.expectedVersionId), input.store.latestProfile(request.brandId), input.store.listKnowledge(request.brandId), input.media.readImagePolicy()]);
      if (!version || !profile) throw new SeoBlogError(409, 'A current article and confirmed profile are required.');
      const privateCommand = imageCommandFromSource({ source, version, profile, knowledge, sponsorUserId: request.sponsorUserId });
      const prepared = prepareImageGenerationRequest(privateCommand);
      const intentSha256 = imageIntentSha({ commandId: request.commandId, origin: request.origin, sponsorUserId: request.sponsorUserId,
        source, requestSha256: prepared.requestSha256, policyVersion: policy.version, policySha256: policy.sha256,
        confirmedNewIntent: request.confirmedNewIntent, replacesIntentId: request.replacesIntentId ?? null });
      const initialized = await input.media.initializeImageIntent(request.brandId, { commandId: request.commandId, jobId: request.commandId, intentId: request.commandId,
        intentSha256, requestSha256: prepared.requestSha256, expectedPolicyVersion: policy.version, expectedPolicySha256: policy.sha256,
        model: 'gpt-image-2', quality: 'medium', sponsorUserId: request.sponsorUserId, privateCommand, source,
        confirmedNewIntent: request.confirmedNewIntent, replacesIntentId: request.replacesIntentId ?? null });
      if ('kind' in initialized && initialized.kind === 'held') return { kind: 'held', code: initialized.reason,
        detail: initialized.reason === 'new_intent_confirmation_required' ? 'An earlier generation already started. Review its saved result or uncertain outcome, then explicitly confirm a separate paid intent.'
          : imageResultMessage({ state: 'held', code: holdCode(initialized.reason), transportInvocations: 0, receiptPersisted: false, candidateAssetId: null, variantAssetIds: [] }),
        ...(initialized.replacesIntentId ? { replacesIntentId: initialized.replacesIntentId } : {}) };
      return { kind: 'job', job: initialized };
    },
    async run(job) {
      if (input.principal.kind !== 'worker') throw new SeoBlogError(403, 'Image processing requires the actual content worker.');
      let candidate: Readonly<{ assetId: string; sha256: string }> | null = null;
      let transportInvocations: 0 | 1 = 0;
      const dependencies: ImageJobDependencies = { providerConfigured: input.providerConfigured,
        async admitCommitted(claim, request) {
          const decision = await input.media.commitImageAttempt({ workspaceId: claim.workspaceId, jobId: claim.jobId, intentId: claim.intentId, nonce: request.nonce,
            leaseOwner: claim.leaseOwner, leaseAttempt: claim.leaseAttempt, expectedPolicyVersion: claim.expectedPolicyVersion, expectedPolicySha256: claim.expectedPolicySha256,
            requestSha256: claim.requestSha256, intentSha256: claim.intentSha256, providerConfigured: request.providerConfigured,
            sourceSha256: claim.sourceSha256, profileSha256: claim.profileSha256, visualSha256: claim.visualSha256,
            articleId: claim.articleId, articleVersionId: claim.articleVersionId, articleContentSha256: claim.articleContentSha256,
            sponsorUserId: claim.sponsorUserId, sourceSnapshotVersion: claim.sourceSnapshotVersion });
          if (decision.kind === 'admitted') return { kind: 'admitted', commitAcknowledged: true, attemptId: decision.attemptId, nonce: decision.nonce };
          if (decision.kind === 'existing_started') return decision;
          if (decision.kind === 'held') return { kind: 'held', reason: holdCode(decision.reason) };
          const known = receipt(decision, claim.requestSha256); candidate = known.candidate;
          return { kind: 'existing_receipt', attemptId: decision.attemptId, nonce: decision.nonce, receipt: known };
        },
        async generate(command, signal) { transportInvocations = 1; return input.generate(command, signal); },
        async persistReceiptCommitted(claim, attempt, envelope) {
          const value = envelope.receipt;
          const saved = await input.media.commitImageAttemptReceipt({ workspaceId: claim.workspaceId, attemptId: attempt.attemptId, nonce: attempt.nonce,
            requestSha256: attempt.reservedRequestSha256, leaseOwner: claim.leaseOwner, leaseAttempt: claim.leaseAttempt,
            receipt: { outcome: value.outcome, code: value.code, requestSha256: value.requestSha256, providerRequestIdSha256: value.providerRequestIdSha256, httpStatus: value.httpStatus, usage: value.usage },
            observedCandidateSha256: envelope.observedCandidateSha256,
            ...(value.candidate ? { candidate: { bytes: value.candidate.bytes, provenance: { kind: 'generated' as const, brandSha256: claim.profileSha256,
              sourceName: 'Editorial image generated from the saved brand and article intent.', generation: { intentId: claim.intentId, nonce: attempt.nonce, requestSha256: attempt.reservedRequestSha256 } } } } : {}) });
          const known = receipt(saved, attempt.reservedRequestSha256); candidate = known.candidate; return known;
        },
        async loadCandidate(claim, id, sha) { return (await input.media.loadPrivateAsset(claim.workspaceId, id, sha)).bytes; },
        async commitPreparation(claim, attempt, saved, prepared) {
          const value = await input.media.commitPreparation(claim.workspaceId, { commandId: commandId(`seo-image-prepare/v1:${attempt.attemptId}:${saved.candidate!.sha256}`),
            sourceAssetId: saved.candidate!.assetId, sourceSha256: saved.candidate!.sha256, outcome: 'prepared', sourceDimensions: { width: prepared.original.width, height: prepared.original.height }, detail: null,
            variants: prepared.variants.map(v => { if (!v.recipe) throw new Error('Prepared recipe missing.'); return { bytes: v.bytes, recipe: v.recipe }; }) });
          return { commitAcknowledged: true, candidateAssetId: value.sourceAssetId, sourceSha256: value.sourceSha256,
            variants: value.variants.map(v => ({ assetId: v.id, sha256: v.sha256, profile: proposedVariant(v).profile })) };
        },
        async recordPreparationFailure(claim, attempt, saved, failure) {
          if (!failure.retryable) await input.media.commitPreparation(claim.workspaceId, { commandId: commandId(`seo-image-rejected/v1:${attempt.attemptId}:${failure.code}`),
            sourceAssetId: saved.candidate!.assetId, sourceSha256: saved.candidate!.sha256, outcome: 'rejected', sourceDimensions: null, variants: [], detail: 'The paid candidate could not be prepared as a supported editorial JPEG.' });
          await input.store.recordActivity({ brandId: claim.workspaceId, at: now(), actor: 'system', kind: failure.retryable ? 'image.preparation.retry' : 'image.preparation.rejected',
            subjectId: claim.articleId, message: failure.retryable ? 'Saved image needs local preparation recovery. No new generation was requested.' : 'Saved image is unsupported. The private receipt is retained; no new generation was requested.' });
        },
        async applyPreparedCommitted(claim, attempt, prepared) {
          const applied = await input.media.applyPreparedImageBoundary({ workspaceId: claim.workspaceId, attemptId: attempt.attemptId, nonce: attempt.nonce,
            leaseOwner: claim.leaseOwner, leaseAttempt: claim.leaseAttempt, candidateAssetId: prepared.candidateAssetId, candidateSha256: prepared.sourceSha256, variants: prepared.variants }, async (t, snapshot) => {
            const row = (await t.query<{ data: Omit<Article, 'rowVersion'>; row_version: string }>('SELECT data,row_version FROM app.seo_blog_articles WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [claim.workspaceId, claim.articleId])).rows[0];
            if (!row || row.data.currentVersionId !== claim.articleVersionId) throw new SeoBlogError(409, 'The image parent changed before application.');
            const at = new Date((await t.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at).toISOString();
            const proposal: ArticleImageProposal = { schema: IMAGE_PROPOSAL_SCHEMA, intentId: claim.intentId, attemptId: attempt.attemptId, articleVersionId: claim.articleVersionId,
              articleContentSha256: claim.articleContentSha256, sourceSha256: claim.sourceSha256, candidateAssetId: snapshot.preparation.candidate.id,
              candidateSha256: snapshot.preparation.candidate.sha256, variants: snapshot.preparation.variants.map(proposedVariant), preparedAt: at };
            const previous = row.data.imageProposals ?? [];
            const retained = previous.find(p => p.intentId === claim.intentId);
            if (retained && (retained.attemptId !== proposal.attemptId || retained.candidateSha256 !== proposal.candidateSha256 || retained.sourceSha256 !== proposal.sourceSha256
              || retained.articleVersionId !== proposal.articleVersionId || retained.articleContentSha256 !== proposal.articleContentSha256
              || canonicalCompanyContentJson(retained.variants) !== canonicalCompanyContentJson(proposal.variants))) throw new SeoBlogError(409, 'An image intent already has different prepared bytes.');
            if (!retained && previous.length >= 128) throw new SeoBlogError(409, 'Image preparation history is full; retained evidence has not been discarded.');
            if (!retained) {
              const updated = await t.query('UPDATE app.seo_blog_articles SET data=$3,row_version=row_version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND row_version=$4',
                [claim.workspaceId, claim.articleId, JSON.stringify({ ...row.data, imageProposals: [...previous, proposal] }), row.row_version]);
              if (updated.rowCount !== 1) throw new SeoBlogError(409, 'The article changed before its private image proposal was saved.');
            }
            const { rowVersion, ...data } = snapshot.job;
            const image = data.payload.image as Record<string, unknown>;
            const result = { state: 'prepared' as const, code: 'prepared' as const, transportInvocations, receiptPersisted: true, candidateAssetId: proposal.candidateAssetId, variantAssetIds: proposal.variants.map(v => v.assetId) };
            const completed = await t.query(`UPDATE app.seo_blog_jobs SET state='done',lease_expires_at=NULL,data=$3,row_version=row_version+1,updated_at=clock_timestamp()
              WHERE workspace_id=$1 AND id=$2 AND row_version=$4`, [claim.workspaceId, claim.jobId, JSON.stringify({ ...data, state: 'done', leaseOwner: null, leaseExpiresAt: null,
                payload: { ...data.payload, image: { ...image, candidate: { assetId: proposal.candidateAssetId, sha256: proposal.candidateSha256 }, result } }, progress: imageResultMessage(result), error: null, updatedAt: at }), rowVersion]);
            if (completed.rowCount !== 1) throw new SeoBlogError(409, 'The worker claim changed before the image result was committed.');
          });
          return applied.applied ? { applied: true } : { applied: false, holdCode: holdCode(applied.hold) };
        },
      };
      return runStoredImageJob(job, { store: input.store, dependencies, now, candidate: () => candidate });
    },
    async retryPreparation({ brandId, jobId, actorId }) {
      if (input.principal.kind !== 'user' || input.principal.userId !== actorId) throw new SeoBlogError(403, 'A genuine owner session is required.');
      const job = await input.store.getJob(brandId, jobId);
      if (!job || !isImageJob(job)) throw new SeoBlogError(404, 'Image task not found.');
      if (!['blocked', 'failed'].includes(job.state)) return job;
      const image = job.payload.image as Record<string, unknown>;
      const candidate = image.candidate as { assetId?: string; sha256?: string } | undefined;
      const start = image.start as { nonce?: string; attemptId?: string } | undefined;
      if (!candidate?.assetId || !candidate.sha256 || !start?.nonce || !start.attemptId || !UUID.test(candidate.assetId) || !SHA.test(candidate.sha256)) throw new SeoBlogError(409, 'No confirmed saved candidate is available for local preparation. This action cannot repeat an image call.');
      const saved = await input.media.loadPrivateAsset(brandId, candidate.assetId, candidate.sha256);
      const generation = saved.asset.provenance.generation;
      if (saved.asset.kind !== 'candidate' || !generation || generation.intentId !== image.intentId || generation.nonce !== start.nonce || generation.requestSha256 !== image.requestSha256) throw new SeoBlogError(409, 'The saved candidate does not match this original image attempt.');
      // Never reset the start, nonce or lease epoch. A fresh worker claim can
      // recover only the existing durable attempt/receipt, never a new grant.
      return input.store.updateJob({ ...job, state: 'queued', maxAttempts: job.attempts + 3, leaseOwner: null, leaseExpiresAt: null, runAfter: now(),
        progress: 'Saved candidate queued for local preparation; no new image generation requested.', error: null, updatedAt: now() });
    },
  };
}
