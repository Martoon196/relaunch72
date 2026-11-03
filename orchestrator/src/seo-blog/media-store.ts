/** SQL-owned media authority. No provider, decoder, scheduler, environment or HTTP effects. */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, InactivePortalSessionError, type DbTransaction } from '../db/transaction.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import type { PgSeoBlogPrincipal } from './pg-store.js';
import { SeoBlogError, type Job } from './types.js';
import type {
  SeoMediaAsset, SeoMediaAuthorizationInput, SeoMediaCandidateInput, SeoMediaCanonicalManifest,
  SeoMediaOwnerAuthorization, SeoMediaPreparation, SeoMediaPreparationInput, SeoMediaPrivateBytes,
  SeoMediaPublicRelease, SeoMediaReleasedBytes, SeoMediaReleaseInput, SeoMediaUseInput, SeoMediaUseReservation,
  SeoMediaWithdrawal, SeoMediaWithdrawalInput,
  SeoImageSourceSnapshot, SeoImageIntentInput, SeoImageOperatorPolicy, SeoImageAttemptInput, SeoImageAttemptDecision,
  SeoImageAttemptReceiptInput, SeoImageReceiptResult,
  SeoImageApplyInput,SeoImageVerifiedPreparation,
  SeoMediaAssetManifestInput,SeoMediaSocialUseInput,SeoMediaSocialAuthorization,
  SeoImageRequestAlias,SeoImageRequestLookup,
  SeoCampaignQueueInput,SeoCampaignQueueInstruction,SeoCampaignQueueResult,
} from './media-types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA = /^[0-9a-f]{64}$/u;
const READER_WORKSPACE = '00000000-0000-4000-8000-000000000000';
/** Exact UTF-8 alt digest; independent of JSON serializer ordering and prospective use IDs. */
export function canonicalImageSourceVersion(manifest: SeoMediaCanonicalManifest): string {
  return `media:v1:${manifest.byteSha256}:${manifest.presentation.profile}:${createHash('sha256').update(manifest.presentation.alt, 'utf8').digest('hex')}`;
}
function identity(value: string): void { if (!UUID.test(value)) throw new SeoBlogError(400, 'Invalid media identity.'); }
function digest(value: string): void { if (!SHA.test(value)) throw new SeoBlogError(400, 'Invalid media digest.'); }
function bytes(value: Uint8Array, maximum: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum) throw new SeoBlogError(400, 'Media byte limit exceeded.');
  return Buffer.from(value);
}
function origin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.port || (url.pathname !== '/' && url.pathname !== '') || !/^[a-z0-9.-]+$/u.test(url.hostname)) throw new SeoBlogError(400, 'A plain public HTTPS origin is required.');
  return url.origin;
}
function safeReceipt(raw: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const outcomes = ['not_started','candidate_received','rejected','outcome_unknown','uploaded'];
  const codes = ['aborted','candidate_received','provider_rejected','transport_interrupted','invalid_response','response_limit','uploaded'];
  if (!outcomes.includes(String(raw.outcome)) || !codes.includes(String(raw.code))) throw new SeoBlogError(400, 'Invalid safe media receipt.');
  const usageKeys = ['inputTokens','outputTokens','totalTokens','inputTextTokens','inputImageTokens','outputImageTokens'];
  let usage: Record<string, number | null> | null = null;
  if (raw.usage !== null && raw.usage !== undefined) {
    if (typeof raw.usage !== 'object' || Array.isArray(raw.usage)) throw new SeoBlogError(400, 'Invalid usage evidence.');
    usage = {};
    for (const key of usageKeys) {
      const value = (raw.usage as Record<string, unknown>)[key];
      if (value !== null && value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)) throw new SeoBlogError(400, 'Invalid usage evidence.');
      usage[key] = value === null || value === undefined ? null : Number(value);
    }
  }
  const requestSha256 = raw.requestSha256 === undefined || raw.requestSha256 === null ? null : String(raw.requestSha256);
  const providerRequestIdSha256 = raw.providerRequestIdSha256 === undefined || raw.providerRequestIdSha256 === null ? null : String(raw.providerRequestIdSha256);
  if ((requestSha256 !== null && !SHA.test(requestSha256)) || (providerRequestIdSha256 !== null && !SHA.test(providerRequestIdSha256))
    || (raw.httpStatus !== null && raw.httpStatus !== undefined && (!Number.isInteger(raw.httpStatus) || Number(raw.httpStatus) < 100 || Number(raw.httpStatus) > 599))) {
    throw new SeoBlogError(400, 'Invalid safe media receipt.');
  }
  return { outcome: raw.outcome, code: raw.code, requestSha256, providerRequestIdSha256, httpStatus: raw.httpStatus ?? null, usage };
}

export class PgSeoBlogMediaStore {
  private readonly sessionHash: Buffer | null;
  private readonly publicOrigin: string;
  constructor(private readonly pool: Pick<Pool, 'connect'>, private readonly principal: PgSeoBlogPrincipal, options: Readonly<{ publicOrigin: string }>) {
    this.sessionHash = principal.kind === 'user' ? createHash('sha256').update(principal.sessionToken).digest() : null;
    this.publicOrigin = origin(options.publicOrigin);
  }

  private context(workspaceId: string): DatabaseRequestContext {
    const p = this.principal;
    return p.kind === 'user' ? { actorKind: 'user', workspaceId, userId: p.userId, requestId: p.requestId }
      : { actorKind: 'worker', workspaceId, requestId: p.requestId };
  }
  private async tx<T>(workspaceId: string, run: (t: DbTransaction) => Promise<T>): Promise<T> {
    identity(workspaceId);
    return withTransaction(this.pool, this.context(workspaceId), async (t) => {
      if (this.principal.kind === 'user') {
        const guard = await t.query<{ ok: boolean }>('SELECT app_private.lock_active_portal_session($1,$2,$3) AS ok',
          [this.sessionHash, this.principal.userId, this.principal.selectedWorkspaceId]);
        if (guard.rows[0]?.ok !== true) throw new InactivePortalSessionError();
      }
      return run(t);
    });
  }
  private owner(): Buffer {
    if (this.principal.kind !== 'user' || !this.sessionHash) throw new SeoBlogError(403, 'A genuine owner session is required.');
    return Buffer.from(this.sessionHash);
  }
  private async result<T>(t: DbTransaction, sql: string, values: readonly unknown[]): Promise<T> {
    const row = (await t.query<{ result: T }>(sql, [...values])).rows[0];
    if (!row || row.result === null) throw new SeoBlogError(404, 'Media record not found.');
    return row.result;
  }

  async persistCandidateReceipt(workspaceId: string, input: SeoMediaCandidateInput): Promise<SeoMediaAsset> {
    identity(input.commandId); digest(input.provenance.brandSha256);
    const ownedBytes = bytes(input.bytes, 8 * 1024 * 1024);
    const provenance = JSON.stringify(input.provenance), receipt = JSON.stringify(safeReceipt(input.receipt));
    return this.tx(workspaceId, (t) => this.result(t, 'SELECT app_private.seo_media_store_candidate($1,$2,$3,$4,$5,$6) AS result',
      [workspaceId, this.sessionHash, input.commandId, ownedBytes, provenance, receipt]));
  }

  async loadPrivateAsset(workspaceId: string, assetId: string, expectedSha256: string): Promise<SeoMediaPrivateBytes> {
    identity(assetId); digest(expectedSha256);
    return this.tx(workspaceId, async (t) => {
      const row = (await t.query<{ asset: SeoMediaAsset; bytes: Buffer }>('SELECT * FROM app_private.seo_media_read_private($1,$2,$3,$4)',
        [workspaceId, this.sessionHash, assetId, expectedSha256])).rows[0];
      if (!row) throw new SeoBlogError(404, 'Media record not found.');
      return { asset: row.asset, bytes: Buffer.from(row.bytes) };
    });
  }

  async commitPreparation(workspaceId: string, input: SeoMediaPreparationInput): Promise<SeoMediaPreparation> {
    identity(input.commandId); identity(input.sourceAssetId); digest(input.sourceSha256);
    if (input.variants.length > 3) throw new SeoBlogError(400, 'At most three sequential variants are supported.');
    const variantBytes = input.variants.map((variant) => bytes(variant.bytes, 600_000));
    const recipes = JSON.stringify(input.variants.map((variant) => variant.recipe));
    const parameters = [workspaceId, this.sessionHash, input.commandId, input.sourceAssetId, input.sourceSha256, input.outcome,
      input.detail, variantBytes, recipes, JSON.stringify(input.sourceDimensions)];
    return this.tx(workspaceId, (t) => this.result(t, 'SELECT app_private.seo_media_prepare($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
      parameters));
  }

  /** Allocate the URL before ArticleVersion/body/target/delivery hashing. This does NOT release bytes. */
  async reserveMediaUse(workspaceId: string, input: SeoMediaUseInput): Promise<SeoMediaUseReservation> {
    const session = this.owner(); identity(input.commandId); identity(input.articleId); identity(input.assetId); digest(input.assetSha256);
    const parameters = [workspaceId, session, input.commandId, input.articleId, input.assetId, input.assetSha256, this.publicOrigin, JSON.stringify(input.presentation)];
    return this.tx(workspaceId, (t) => this.result(t, 'SELECT app_private.seo_media_reserve_use($1,$2,$3,$4,$5,$6,$7,$8) AS result',
      parameters));
  }

  async getCanonicalManifest(workspaceId: string, reservationCommandId: string): Promise<SeoMediaCanonicalManifest> {
    const session = this.owner(); identity(reservationCommandId);
    return this.tx(workspaceId, (t) => this.result(t, 'SELECT app_private.seo_media_review_manifest($1,$2,$3) AS result',
      [workspaceId, session, reservationCommandId]));
  }

  async getAssetCanonicalManifest(workspaceId:string,input:SeoMediaAssetManifestInput):Promise<SeoMediaCanonicalManifest> {
    const session=this.owner();identity(input.assetId);digest(input.assetSha256);
    const parameters=[workspaceId,session,input.assetId,input.assetSha256,input.profile,input.alt];
    return this.tx(workspaceId,(t)=>this.result(t,'SELECT app_private.seo_media_review_asset($1,$2,$3,$4,$5,$6) AS result',parameters));
  }

  async recordOwnerSocialImageAuthorization(workspaceId:string,input:SeoMediaSocialUseInput):Promise<SeoMediaSocialAuthorization> {
    const session=this.owner();for(const id of [input.commandId,input.useId,input.articleId,input.articleVersionId,input.variantId,input.variantRevisionId,input.assetId,
      input.canonical.contentItemId,input.canonical.contentVersionId,input.canonical.approvalRequestId,input.canonical.approvalDecisionId])identity(id);
    for(const hash of [input.articleContentSha,input.variantSha256,input.assetSha256,input.canonical.contentSha256])digest(hash);
    const payload=JSON.stringify(input);
    return this.tx(workspaceId,(t)=>this.result(t,'SELECT app_private.seo_media_authorize_social_use($1,$2,$3) AS result',[workspaceId,session,payload]));
  }

  async refreshSocialImageAttestation(workspaceId:string,input:Readonly<{useId:string;commandId:string}>):Promise<Readonly<{sourceAttestationId:string;expiresAt:string}>> {
    const session=this.owner();identity(input.useId);identity(input.commandId);
    const parameters=[workspaceId,session,input.useId,input.commandId];
    return this.tx(workspaceId,(t)=>this.result(t,'SELECT app_private.seo_media_refresh_social_image_attestation($1,$2,$3,$4) AS result',parameters));
  }

  async recordOwnerCampaignQueue(workspaceId:string,input:SeoCampaignQueueInput,
    onQueued?:(t:DbTransaction,instruction:SeoCampaignQueueInstruction)=>Promise<void>):Promise<SeoCampaignQueueInstruction> {
    const session=this.owner();for(const id of [input.commandId,input.articleId,input.articleVersionId,input.variantId,input.variantRevisionId,input.contentVersionId,input.bindingId])identity(id);
    digest(input.articleContentSha);digest(input.variantSha256);const payload=JSON.stringify(input);
    return this.tx(workspaceId,async(t)=>{const instruction=await this.result<SeoCampaignQueueInstruction>(t,
      'SELECT app_private.seo_media_authorize_campaign_queue($1,$2,$3) AS result',[workspaceId,session,payload]);
      if(onQueued)await onQueued(t,instruction);return instruction;});
  }

  async cancelOwnerCampaignQueue(workspaceId:string,input:Readonly<{queueIntentId:string;commandId:string}>):Promise<Readonly<{queueIntentId:string;cancelled:true}>> {
    const session=this.owner();identity(input.queueIntentId);identity(input.commandId);
    return this.tx(workspaceId,(t)=>this.result(t,'SELECT app_private.seo_media_cancel_campaign_queue($1,$2,$3,$4) AS result',[workspaceId,session,input.queueIntentId,input.commandId]));
  }

  /** A committed DB receipt; this capability never invokes a provider or adopts the owner identity. */
  async materializeCampaignQueue(workspaceId:string,queueIntentId:string):Promise<SeoCampaignQueueResult> {
    if(this.principal.kind!=='worker')throw new SeoBlogError(403,'The content worker is required.');
    identity(workspaceId);identity(queueIntentId);
    const receipt=await this.tx(workspaceId,async(t)=>(await t.query<{result:SeoCampaignQueueResult|null}>(
      'SELECT app_private.seo_media_campaign_queue_receipt($1,$2) AS result',[workspaceId,queueIntentId])).rows[0]?.result??null);
    if(receipt)return receipt;
    // This must ACK COMMIT before the brand-first transaction below:133 terminal updates take a source advisory lock.
    await this.retireCancelledCampaignJobs(workspaceId);
    return withTransaction(this.pool,this.context(workspaceId),(t)=>this.result(t,
      'SELECT app_private.seo_blog_materialize_campaign_queue($1,$2) AS result',[workspaceId,queueIntentId]),{isolation:'serializable'});
  }

  async retireCancelledCampaignJobs(workspaceId:string):Promise<number>{
    if(this.principal.kind!=='worker')throw new SeoBlogError(403,'The content worker is required.');
    return this.tx(workspaceId,async(t)=>(await t.query<{count:number}>('SELECT app_private.seo_blog_retire_cancelled_campaign_jobs($1) AS count',[workspaceId])).rows[0]!.count);
  }

  async listPendingCampaignQueues(workspaceId:string,options:Readonly<{afterId?:string;limit?:number}>={}):Promise<readonly string[]> {
    if(this.principal.kind!=='worker')throw new SeoBlogError(403,'The content worker is required.');
    return this.tx(workspaceId,(t)=>this.listPendingCampaignQueuesOnTransaction(t,workspaceId,undefined,options));
  }

  /** Current caller already owns the publication/queue transaction; never opens another client. */
  async listPendingCampaignQueuesOnTransaction(t:DbTransaction,workspaceId:string,articleId?:string,options:Readonly<{afterId?:string;limit?:number}>={}):Promise<readonly string[]> {
    identity(workspaceId);if(articleId)identity(articleId);if(options.afterId)identity(options.afterId);
    const limit=options.limit??50;if(!Number.isInteger(limit)||limit<1||limit>100)throw new SeoBlogError(400,'A bounded campaign discovery page is required.');
    return(await t.query<{id:string}>('SELECT app_private.seo_media_pending_campaign_queues($1,$2,$3,$4) AS id',[workspaceId,articleId??null,options.afterId??null,limit])).rows.map((row)=>row.id);
  }

  async listCampaignQueueWorkspaces(options:Readonly<{afterId?:string;limit?:number}>={}):Promise<readonly string[]> {
    if(this.principal.kind!=='worker')throw new SeoBlogError(403,'The content worker is required.');
    if(options.afterId)identity(options.afterId);const limit=options.limit??50;
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new SeoBlogError(400,'A bounded campaign discovery page is required.');
    return withTransaction(this.pool,this.context(READER_WORKSPACE),async(t)=>(await t.query<{id:string}>('SELECT app_private.seo_blog_campaign_queue_workspaces($1,$2) AS id',[options.afterId??null,limit])).rows.map((row)=>row.id),{readOnly:true});
  }

  async recordOwnerImageAuthorization(workspaceId: string, input: SeoMediaAuthorizationInput): Promise<SeoMediaOwnerAuthorization> {
    const session = this.owner(); identity(input.commandId); identity(input.reservationCommandId); identity(input.articleVersionId);
    digest(input.articleContentSha256); digest(input.reviewedIntentSha256);
    for (const id of [input.canonical.contentItemId,input.canonical.contentVersionId,input.canonical.approvalRequestId,input.canonical.approvalDecisionId]) identity(id);
    digest(input.canonical.contentSha256);
    const payload = JSON.stringify(input);
    return this.tx(workspaceId, (t) => this.result(t, 'SELECT app_private.seo_media_authorize($1,$2,$3) AS result', [workspaceId, session, payload]));
  }

  /** Caller owns the current publication transaction/client and lock order. Never opens another transaction. */
  async assertPublicationMediaEffect(t:DbTransaction,workspaceId:string,input:SeoMediaReleaseInput):Promise<void>{
    identity(workspaceId);identity(input.publicationId);identity(input.ownerAuthorizationId);digest(input.reviewedIntentSha256);
    await t.query('SELECT app_private.seo_media_assert_publication_effect($1,$2,$3,$4,$5)',
      [workspaceId,this.sessionHash,input.publicationId,input.ownerAuthorizationId,input.reviewedIntentSha256]);
  }

  /** Receipt-first history/release hook; fresh begin/resend MUST call assertPublicationMediaEffect first. */
  async releaseForPublication(t: DbTransaction, workspaceId: string, input: SeoMediaReleaseInput): Promise<SeoMediaPublicRelease> {
    identity(workspaceId); identity(input.publicationId); identity(input.ownerAuthorizationId); digest(input.reviewedIntentSha256);
    return this.result(t, 'SELECT app_private.seo_media_release($1,$2,$3,$4,$5) AS result',
      [workspaceId, this.sessionHash, input.publicationId, input.ownerAuthorizationId, input.reviewedIntentSha256]);
  }

  async withdrawAssetOrRelease(workspaceId: string, input: SeoMediaWithdrawalInput): Promise<SeoMediaWithdrawal> {
    const session = this.owner(); identity(input.commandId); digest(input.assetSha256);
    identity(input.scope === 'asset' ? input.assetId : input.releaseId);
    const payload=JSON.stringify(input);
    return this.tx(workspaceId, (t) => this.result(t, 'SELECT app_private.seo_media_withdraw($1,$2,$3) AS result', [workspaceId, session, payload]));
  }

  async readImagePolicy(): Promise<SeoImageOperatorPolicy> {
    const workspace = this.principal.kind === 'user' ? this.principal.selectedWorkspaceId : READER_WORKSPACE;
    return this.tx(workspace, (t) => this.result(t, 'SELECT app_private.seo_image_read_policy() AS result', []));
  }

  async readImageSourceSnapshot(workspaceId: string, articleId: string): Promise<SeoImageSourceSnapshot> {
    identity(articleId);
    return this.tx(workspaceId, (t) => this.result(t, 'SELECT app_private.seo_image_read_source($1,$2,$3) AS result', [workspaceId,this.sessionHash,articleId]));
  }

  private async recoverImageRequestTx(t:DbTransaction,workspaceId:string,input:SeoImageRequestLookup):Promise<Job|null>{
    const expected=this.principal.kind==='user'?'owner':'programme';
    if(input.origin!==expected)throw new SeoBlogError(403,'Image request origin does not match the genuine actor.');
    const base=(await t.query<{allowed:boolean}>(this.principal.kind==='user'
      ?'SELECT app_private.can_manage_workspace(app_private.current_user_id(),$1) AS allowed'
      :"SELECT pg_has_role(session_user,'r72_content_command','MEMBER') AS allowed",this.principal.kind==='user'?[workspaceId]:[])).rows[0];
    if(base?.allowed!==true)throw new SeoBlogError(403,'Current brand image access required.');
    const rows=(await t.query<{data:Omit<Job,'rowVersion'>;row_version:string;alias:SeoImageRequestAlias|null}>(
      `SELECT j.data,j.row_version,a AS alias FROM app.seo_blog_jobs j
       LEFT JOIN LATERAL jsonb_array_elements(coalesce(j.data#>'{payload,image,requestAliases}','[]'::jsonb)) a ON a->>'commandId'=$2
       WHERE j.workspace_id=$1 AND j.kind='write' AND j.data#>>'{payload,stage}'='image'
         AND (a IS NOT NULL OR j.data#>>'{payload,image,commandId}'=$2)`,[workspaceId,input.commandId])).rows;
    // An initial command can join all aliases through LEFT JOIN only at its matching alias; missing legacy alias is derived from its original input.
    if(!rows.length)return null;
    const row=rows[0]!;const image=row.data.payload.image as Record<string,unknown>;
    const alias=row.alias??{commandId:String(image.commandId),requestedBy:String(row.data.payload.requestedBy),
      origin:image.automatic===true?'programme' as const:'owner' as const,articleId:String(image.articleId),articleVersionId:String(image.articleVersionId)};
    if(rows.length!==1||alias.articleId!==input.articleId||alias.articleVersionId!==input.articleVersionId||alias.origin!==expected
      ||(this.principal.kind==='user'&&alias.requestedBy!==this.principal.userId))throw new SeoBlogError(409,'Image command already belongs to another requester or article version.');
    return{...row.data,rowVersion:Number(row.row_version)};
  }

  /** Receipt lookup before rebuilding a now-stale/unconfirmed prompt/source. Never grants an effect or mutates a nonce. */
  async recoverImageIntentRequest(workspaceId:string,input:SeoImageRequestLookup):Promise<Job|null>{
    identity(input.commandId);identity(input.articleId);identity(input.articleVersionId);
    const snapshot={...input};
    return this.tx(workspaceId,(t)=>this.recoverImageRequestTx(t,workspaceId,snapshot));
  }

  /** Initialise a private write/image job using EXISTING command grants; it cannot grant a paid start. */
  async initializeImageIntent(workspaceId: string, input: SeoImageIntentInput): Promise<Job | Readonly<{ kind: 'held'; reason: string;replacesIntentId?:string }>> {
    identity(input.commandId);identity(input.jobId); identity(input.intentId); identity(input.sponsorUserId);
    digest(input.requestSha256); digest(input.intentSha256); digest(input.expectedPolicySha256);
    if(input.replacesIntentId!==undefined&&input.replacesIntentId!==null)identity(input.replacesIntentId);
    if (input.privateCommand.brandId !== workspaceId || input.privateCommand.actorId !== input.sponsorUserId
      || typeof input.privateCommand.prompt !== 'string' || !input.privateCommand.prompt.trim()
      || [...input.privateCommand.prompt].length>8000 || Buffer.byteLength(input.privateCommand.prompt)>32768) throw new SeoBlogError(400,'Invalid private image command.');
    // Snapshot before await: caller changes cannot alter the frozen source/command during session/row-lock waits.
    const payload = JSON.parse(JSON.stringify(input)) as SeoImageIntentInput;
    return this.tx(workspaceId, async (t) => {
      await t.query('SELECT workspace_id FROM app.seo_blog_brands WHERE workspace_id=$1 FOR UPDATE',[workspaceId]);
      const original=await this.recoverImageRequestTx(t,workspaceId,{commandId:payload.commandId,articleId:payload.source.articleId,
        articleVersionId:payload.source.articleVersionId,origin:this.principal.kind==='user'?'owner':'programme'});
      if(original)return original;
      const actor=await this.result<{requestedBy:string;origin:'owner'|'programme'}|{kind:'held';reason:string}>(t,
        'SELECT app_private.seo_image_alias_actor($1,$2,$3) AS result',[workspaceId,this.sessionHash,payload.sponsorUserId]);
      if('kind' in actor)return actor;
      const alias:SeoImageRequestAlias={commandId:payload.commandId,requestedBy:actor.requestedBy,origin:actor.origin,
        articleId:payload.source.articleId,articleVersionId:payload.source.articleVersionId};
      const appendAlias=async(job:Job):Promise<Job|Readonly<{kind:'held';reason:string}>>=>{
        const image=job.payload.image as Record<string,unknown>;
        const retained=Array.isArray(image.requestAliases)?image.requestAliases as SeoImageRequestAlias[]:[];
        if(retained.length>=128)return{kind:'held',reason:'command_alias_limit'};
        const updated=(await t.query<{data:Omit<Job,'rowVersion'>;row_version:string}>(`UPDATE app.seo_blog_jobs
          SET data=jsonb_set(data,'{payload,image,requestAliases}',$3::jsonb),row_version=row_version+1,updated_at=clock_timestamp()
          WHERE workspace_id=$1 AND id=$2 RETURNING data,row_version`,[workspaceId,job.id,JSON.stringify([...retained,alias])])).rows[0];
        if(!updated)throw new SeoBlogError(409,'Image task changed before its receipt could be saved.');
        return{...updated.data,rowVersion:Number(updated.row_version)};
      };
      const recover=async ():Promise<Job|null>=>{
        const existing=(await t.query<{data:Omit<Job,'rowVersion'>;row_version:string;matches:boolean}>(
          `SELECT data,row_version,(data#>'{payload,image}') @> $4::jsonb AS matches FROM app.seo_blog_jobs
           WHERE workspace_id=$1 AND (id=$2 OR idempotency_key=$3)`,[workspaceId,payload.jobId,`seo-image:${payload.intentId}`,JSON.stringify(payload)])).rows[0];
        if(!existing)return null;
        if(existing.data.id!==payload.jobId||existing.matches!==true)throw new SeoBlogError(409,'Image intent already exists with different inputs.');
        return {...existing.data,rowVersion:Number(existing.row_version)};
      };
      // Recover immutable identity before current admission checks; then serialise insertion against the brand.
      const replay=await recover();if(replay)return appendAlias(replay);
      const readiness = await this.result<{ kind:'ready'|'held'|'existing_job';reason?:string;automatic?:boolean;job?:Job;replacesIntentId?:string }>(t,
        'SELECT app_private.seo_image_check_intent($1,$2,$3) AS result',[workspaceId,this.sessionHash,JSON.stringify(payload)]);
      if(readiness.kind==='existing_job')return appendAlias(readiness.job!);
      if (readiness.kind==='held') return { kind:'held',reason:readiness.reason!,...(readiness.replacesIntentId?{replacesIntentId:readiness.replacesIntentId}:{}) };
      const now = (await t.query<{ now:string }>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
      const data: Omit<Job,'rowVersion'> = { id:payload.jobId,brandId:workspaceId,kind:'write',idempotencyKey:`seo-image:${payload.intentId}`,
        payload:{stage:'image',requestedBy:payload.sponsorUserId,image:{...payload,...payload.source,sourceSnapshot:payload.source.snapshot,
          schema:'relaunch72.seo-image-intent/v1',sourceSnapshotVersion:'seo-image-source-v1',automatic:readiness.automatic===true,requestAliases:[alias]}},
        state:'queued',attempts:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,runAfter:now,progress:'Image intent queued; paid admission not started.',error:null,createdAt:now,updatedAt:now };
      const row = (await t.query<{data:Omit<Job,'rowVersion'>;row_version:string}>(
        `INSERT INTO app.seo_blog_jobs(workspace_id,id,kind,idempotency_key,state,run_after,data) VALUES($1,$2,'write',$3,'queued',$4,$5)
         RETURNING data,row_version`,[workspaceId,payload.jobId,data.idempotencyKey,now,JSON.stringify(data)])).rows[0]!;
      return {...row.data,rowVersion:Number(row.row_version)};
    });
  }

  /** Provisional, SAME-client reservation. Its caller MUST NOT invoke a supplier before its COMMIT acknowledgement. */
  async reserveImageAttempt(t: DbTransaction, input: SeoImageAttemptInput): Promise<SeoImageAttemptDecision> {
    if (this.principal.kind!=='worker') throw new SeoBlogError(403,'Image starts require the content worker.');
    identity(input.workspaceId); identity(input.jobId); identity(input.intentId); identity(input.nonce);
    digest(input.expectedPolicySha256); digest(input.requestSha256); digest(input.intentSha256);
    identity(input.articleId);identity(input.articleVersionId);identity(input.sponsorUserId);
    digest(input.articleContentSha256);digest(input.sourceSha256);digest(input.profileSha256);digest(input.visualSha256);
    if (!Number.isSafeInteger(input.leaseAttempt) || input.leaseAttempt<1 || !input.leaseOwner || !Number.isSafeInteger(input.expectedPolicyVersion)
      || input.expectedPolicyVersion<1) throw new SeoBlogError(400,'Invalid image worker claim.');
    // Existing content-command privileges, not a new SECURITY DEFINER write grant on legacy tables.
    await t.query('SELECT workspace_id FROM app.seo_blog_brands WHERE workspace_id=$1 FOR UPDATE',[input.workspaceId]);
    await t.query('SELECT id FROM app.seo_blog_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[input.workspaceId,input.jobId]);
    const decision = await this.result<SeoImageAttemptDecision>(t,'SELECT app_private.seo_image_reserve($1,$2) AS result',[input.workspaceId,JSON.stringify(input)]);
    if (decision.kind==='admitted') {
      await t.query(`UPDATE app.seo_blog_jobs SET data=jsonb_set(data,'{payload,image,start}',jsonb_build_object(
        'nonce',$3::text,'attemptId',$4::text,'at',clock_timestamp(),'leaseOwner',$5::text,'leaseAttempt',$6::integer)),
        row_version=row_version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
        [input.workspaceId,input.jobId,decision.nonce,decision.attemptId,input.leaseOwner,input.leaseAttempt]);
      await t.query(`INSERT INTO app.seo_blog_usage(workspace_id,kind,amount,at,reference) VALUES($1,'images',1,clock_timestamp(),$2)`,
        [input.workspaceId,`seo-image-start:${decision.attemptId}`]);
    }
    return decision;
  }

  /** Coordinator-facing API: admitted is returned only after acknowledged COMMIT. Unknown COMMIT throws, never grants a call. */
  async commitImageAttempt(input: SeoImageAttemptInput): Promise<SeoImageAttemptDecision> {
    const snapshot = {...input};
    return this.tx(input.workspaceId,(t)=>this.reserveImageAttempt(t,snapshot));
  }

  async recordImageAttemptReceipt(t: DbTransaction, input: SeoImageAttemptReceiptInput): Promise<SeoImageReceiptResult> {
    if (this.principal.kind!=='worker') throw new SeoBlogError(403,'Image receipts require the content worker.');
    identity(input.workspaceId); identity(input.attemptId); identity(input.nonce); digest(input.requestSha256);
    if(input.observedCandidateSha256!==null&&input.observedCandidateSha256!==undefined)digest(input.observedCandidateSha256);
    const raw = input.candidate ? bytes(input.candidate.bytes,8*1024*1024) : null;
    const payload=JSON.stringify({...input,candidate:undefined,receipt:safeReceipt(input.receipt)});
    const provenance=input.candidate?JSON.stringify(input.candidate.provenance):null;
    await t.query('SELECT workspace_id FROM app.seo_blog_brands WHERE workspace_id=$1 FOR UPDATE',[input.workspaceId]);
    await t.query(`SELECT j.id FROM app.seo_blog_jobs j WHERE j.workspace_id=$1
      AND j.id=app_private.seo_image_attempt_job($1,$2) FOR UPDATE`,[input.workspaceId,input.attemptId]);
    return this.result(t,'SELECT app_private.seo_image_record_receipt($1,$2,$3,$4) AS result',[input.workspaceId,payload,raw,provenance]);
  }

  async commitImageAttemptReceipt(input: SeoImageAttemptReceiptInput): Promise<SeoImageReceiptResult> {
    // Own bytes/evidence before the first asynchronous operation.
    const snapshot = { ...input,receipt:safeReceipt(input.receipt),...(input.candidate?{candidate:{bytes:bytes(input.candidate.bytes,8*1024*1024),
      provenance:JSON.parse(JSON.stringify(input.candidate.provenance)) as SeoMediaCandidateInput['provenance']}}:{}) };
    return this.tx(input.workspaceId,(t)=>this.recordImageAttemptReceipt(t,snapshot));
  }

  /** Fresh recovery claim may apply known pixels; an old worker cannot adopt a newer owner's/epoch's lease. */
  async checkImageApplyEligibility(t: DbTransaction, input: Readonly<{workspaceId:string;attemptId:string;nonce:string;leaseOwner:string;leaseAttempt:number}>): Promise<Readonly<{eligible:boolean;hold:string|null}>> {
    if (this.principal.kind!=='worker') throw new SeoBlogError(403,'Image application requires the content worker.');
    await t.query('SELECT workspace_id FROM app.seo_blog_brands WHERE workspace_id=$1 FOR UPDATE',[input.workspaceId]);
    await t.query(`SELECT j.id FROM app.seo_blog_jobs j WHERE j.workspace_id=$1
      AND j.id=app_private.seo_image_attempt_job($1,$2) FOR UPDATE`,[input.workspaceId,input.attemptId]);
    return this.result(t,'SELECT app_private.seo_image_check_apply($1,$2) AS result',[input.workspaceId,JSON.stringify(input)]);
  }

  /** Same-client SQL-only callback for private proposals/job result. It may not call suppliers, approve, release or publish. */
  async applyPreparedImageBoundary<T>(input:SeoImageApplyInput,commit:(t:DbTransaction,snapshot:Readonly<{job:Job;preparation:SeoImageVerifiedPreparation}>)=>Promise<T>):Promise<Readonly<{applied:false;hold:string}>|Readonly<{applied:true;value:T}>> {
    if(this.principal.kind!=='worker')throw new SeoBlogError(403,'Image application requires the content worker.');
    identity(input.workspaceId);identity(input.attemptId);identity(input.nonce);identity(input.candidateAssetId);digest(input.candidateSha256);
    for(const variant of input.variants){identity(variant.assetId);digest(variant.sha256);}
    const copied=JSON.parse(JSON.stringify(input)) as SeoImageApplyInput;
    return this.tx(copied.workspaceId,async(t)=>{
      await t.query('SELECT workspace_id FROM app.seo_blog_brands WHERE workspace_id=$1 FOR UPDATE',[copied.workspaceId]);
      const row=(await t.query<{data:Omit<Job,'rowVersion'>;row_version:string}>(`SELECT data,row_version FROM app.seo_blog_jobs
        WHERE workspace_id=$1 AND id=app_private.seo_image_attempt_job($1,$2) FOR UPDATE`,[copied.workspaceId,copied.attemptId])).rows[0];
      if(!row)return {applied:false,hold:'claim_changed'};
      const image=row.data.payload.image as Record<string,unknown>|undefined;
      await t.query('SELECT id FROM app.seo_blog_articles WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[copied.workspaceId,image?.articleId]);
      const verified=await this.result<{eligible:false;hold:string}|{eligible:true;preparation:SeoImageVerifiedPreparation}>(t,
        'SELECT app_private.seo_image_verify_preparation($1,$2) AS result',[copied.workspaceId,JSON.stringify(copied)]);
      if(!verified.eligible)return {applied:false,hold:verified.hold};
      const value=await commit(t,{job:{...row.data,rowVersion:Number(row.row_version)},preparation:verified.preparation});
      return {applied:true,value};
    });
  }
}

/** Compose with the existing r72_web pool. No private table/asset enumeration capability. */
export class PgSeoBlogReleasedMediaReader {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}
  async readReleasedAsset(releaseId: string, expectedSha256: string): Promise<SeoMediaReleasedBytes | null> {
    if (!UUID.test(releaseId) || !SHA.test(expectedSha256)) return null;
    return withTransaction(this.pool, { actorKind: 'system', workspaceId: READER_WORKSPACE, requestId: 'seo-media-public-read' }, async (t) => {
      const row = (await t.query<{ release_id: string; sha256: string; mime_type: 'image/jpeg'; bytes: Buffer }>(
        'SELECT * FROM app_private.read_released_seo_media($1,$2)', [releaseId, expectedSha256])).rows[0];
      return row ? { releaseId: row.release_id, sha256: row.sha256, mimeType: row.mime_type, bytes: Buffer.from(row.bytes) } : null;
    }, { readOnly: true });
  }
}
