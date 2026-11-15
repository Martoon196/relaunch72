/**
 * One-shot, worker-only paid-media submission. Uses the canonical PostgreSQL
 * admission ledger (migration 0158), not a second scheduler or tenant store.
 * A claimed job is NEVER automatically re-claimed or retried after HTTP starts.
 * The caller supplies a server-side, immutable reviewed job request; no browser
 * API accepts this runner and no provider is contacted by import or construction.
 */
import { providerAdmission, type ClaimedMediaJob, type PgVideoAdmissionWorker } from './media-admission-pg-store.js';
import {
  assertExactMediaJob, validateMediaAdmission, MediaProviderError,
  type ClipJobRequest, type RenderJobRequest, type MediaWorkKind,
  type VizardVideoProvider, type ShotstackVideoProvider,
} from './media-providers.js';

export type MediaSubmission =
  | Readonly<{kind:'vizard_clip'; request:ClipJobRequest}>
  | Readonly<{kind:'shotstack_render'; request:RenderJobRequest}>;

export interface MediaSubmissionPorts {
  /** Worker SQL role only; claim is atomic and one-shot. */
  readonly ledger: Pick<PgVideoAdmissionWorker,'claim'|'submitted'|'failed'|'unknown'>;
  readonly vizard: Pick<VizardVideoProvider,'submit'>;
  readonly shotstack: Pick<ShotstackVideoProvider,'submit'>;
}

export type MediaSubmissionOutcome =
  | Readonly<{state:'submitted';jobId:string;providerJobId:string}>
  | Readonly<{state:'failed'|'outcome_unknown';jobId:string;reason:string}>;

function reviewedSubmission(claim:ClaimedMediaJob):MediaSubmission {
  let request:unknown;
  try{request=JSON.parse(claim.reviewedRequestJson);}catch{
    throw new MediaProviderError('admission','Reviewed request is missing or corrupt');
  }
  if(!request || typeof request!=='object' || Array.isArray(request))
    throw new MediaProviderError('admission','Reviewed request must be a stored object');
  // No caller-supplied plan: the SQL claim contains the exact owner-reviewed bytes.
  return claim.kind==='vizard_clip'
    ?{kind:'vizard_clip',request:request as ClipJobRequest}
    :{kind:'shotstack_render',request:request as RenderJobRequest};
}
function checkClaim(claim:ClaimedMediaJob,workspaceId:string, submission:MediaSubmission):void {
  if (claim.kind!==submission.kind || submission.request.workspaceId!==workspaceId)
    throw new MediaProviderError('admission','Video request does not match the workspace lease and kind');
  const admission=providerAdmission(claim,workspaceId);
  validateMediaAdmission(admission,workspaceId,submission.request.commandId,submission.kind);
  assertExactMediaJob(submission.request,admission);
}

/**
 * Never call this from an HTTP route; the plan is loaded from the atomic
 * SQL claim of the owner's immutable reviewed request, not new client JSON.
 * After a transport attempt all ambiguous failures hold the reservation for
 * operator reconciliation, so repeated worker invocations cannot double spend.
 */
export async function submitApprovedMediaJob(
  workspaceId:string,jobId:string,
  ports:MediaSubmissionPorts,
):Promise<MediaSubmissionOutcome> {
  const claim=await ports.ledger.claim(workspaceId,jobId); // SQL refuses duplicate claims.
  let submission:MediaSubmission;
  try {
    submission=reviewedSubmission(claim);
    checkClaim(claim,workspaceId,submission);
  } catch(error) {
    // No provider call was made. A tampered/stale plan cannot be substituted.
    await ports.ledger.failed(workspaceId,jobId,claim.claimToken);
    return {state:'failed',jobId,reason:error instanceof Error?error.message:'Rejected unreviewed request'};
  }
  const admission=providerAdmission(claim,workspaceId);
  let providerJobId:string;
  try{
    providerJobId=submission.kind==='vizard_clip'
      ?await ports.vizard.submit(submission.request,admission)
      :await ports.shotstack.submit(submission.request,admission);
  } catch(error) {
    // A provider response, interrupted socket or timeout may have incurred cost.
    // Only purely local validation/configuration errors can be refunded safely.
    const local=error instanceof MediaProviderError
      && ['disabled','admission','source','request'].includes(error.code);
    if(local) {
      await ports.ledger.failed(workspaceId,jobId,claim.claimToken);
      return {state:'failed',jobId,reason:(error as Error).message};
    }
    await ports.ledger.unknown(workspaceId,jobId,claim.claimToken);
    return {state:'outcome_unknown',jobId,reason:'External submission outcome needs manual reconciliation'};
  }
  try{
    await ports.ledger.submitted(workspaceId,jobId,claim.claimToken,providerJobId);
  }catch{
    // Provider accepted the job, but the database receipt is not confirmed.
    // Never issue another provider submission; hold the full reservation.
    await ports.ledger.unknown(workspaceId,jobId,claim.claimToken);
    return {state:'outcome_unknown',jobId,reason:'Provider accepted work but receipt requires reconciliation'};
  }
  return {state:'submitted',jobId,providerJobId};
}
