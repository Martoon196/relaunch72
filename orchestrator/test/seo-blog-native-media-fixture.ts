/** Stateful synthetic media/canonical ports for the native journey; never production persistence. */
import { createHash, randomUUID } from 'node:crypto';
import type { CompanyContentService } from '../src/company-content-pg/service.js';
import type { CreateCompanyContentVersionCommand } from '../src/company-content-pg/types.js';
import { canonicalCompanyContentJson } from '../src/company-content-pg/validation.js';
import type { ArticleMediaPort } from '../src/seo-blog/media-review.js';
import type { SeoMediaAsset, SeoMediaCanonicalApproval, SeoMediaPreparation, SeoMediaSocialAuthorization, SeoMediaUseReservation } from '../src/seo-blog/media-types.js';
import type { SeoBlogStore } from '../src/seo-blog/store.js';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function nativeMediaPorts(store: SeoBlogStore, brandId: string, ownerId: string, now: () => string) {
  const assets = new Map<string, {asset:SeoMediaAsset;bytes:Buffer}>(), preparations = new Map<string,SeoMediaPreparation>(), reservations = new Map<string,SeoMediaUseReservation>();
  const candidates = new Map<string,string>(), uses = new Map<string,SeoMediaSocialAuthorization>(), withdrawn = new Set<string>();
  const canonical = new Map<string,{id:string;itemId:string;command:CreateCompanyContentVersionCommand;sha:string}>(), requests = new Map<string,string>(), decisions = new Map<string,string>();
  const sourceKey = (command: CreateCompanyContentVersionCommand) => `${command.source.system}:${command.source.itemId}:${command.source.version}`;
  const drafts: Pick<CompanyContentService,'createVersion'> = { async createVersion(context, command) {
    if (context.actorKind !== 'user' || context.userId !== ownerId || context.workspaceId !== brandId) throw Error('Synthetic canonical principal mismatch');
    let row = canonical.get(sourceKey(command));
    if (!row) { row = {id:randomUUID(),itemId:randomUUID(),command,sha:sha(command.content)};canonical.set(sourceKey(command),row); }
    return {disposition:'applied',contentItemId:row.itemId,contentVersionId:row.id,versionNumber:1,contentSha256:row.sha,sourceAttestationId:randomUUID(),sourceAttestationExpiresAt:command.attestation.expiresAt};
  } };
  const approvals: Pick<CompanyContentService,'requestApproval'|'decideApproval'> = {
    async requestApproval(_context, command) {
      const row=[...canonical.values()].find(r=>r.id===command.contentVersionId)!;let id=requests.get(command.commandKey);if(!id){id=randomUUID();requests.set(command.commandKey,id);}
      return {disposition:'applied',approvalRequestId:id,contentItemId:row.itemId,contentVersionId:row.id,requestNumber:1,contentSha256:row.sha};
    },
    async decideApproval(_context, command) {
      const key=[...requests.entries()].find(([,id])=>id===command.approvalRequestId)![0], draftKey=key.replace(/:review$/u,'');
      const row=[...canonical.values()].find(r=>r.command.commandKey===draftKey)!;let id=decisions.get(command.commandKey);if(!id){id=randomUUID();decisions.set(command.commandKey,id);}
      return {disposition:'applied',approvalDecisionId:id,approvalRequestId:command.approvalRequestId,contentItemId:row.itemId,contentVersionId:row.id,contentSha256:row.sha,decision:command.decision};
    },
  };
  const media: ArticleMediaPort = {
    async persistCandidateReceipt(workspace,input) {
      if(workspace!==brandId||input.provenance.kind!=='uploaded')throw Error('Only synthetic owner upload');
      const existing=candidates.get(input.commandId);if(existing)return assets.get(existing)!.asset;
      const id=randomUUID(),bytes=Buffer.from(input.bytes),asset:SeoMediaAsset={id,workspaceId:workspace,blobId:randomUUID(),kind:'candidate',validation:'candidate_only',sha256:sha(bytes),byteLength:bytes.length,mimeType:'image/jpeg',width:null,height:null,sourceAssetId:null,recipe:null,provenance:input.provenance,createdAt:now()};
      assets.set(id,{asset,bytes});candidates.set(input.commandId,id);return asset;
    },
    async loadPrivateAsset(workspace,id,digest) { const value=assets.get(id);if(workspace!==brandId||!value||value.asset.sha256!==digest||withdrawn.has(id))throw Error('Synthetic private asset unavailable');return {asset:value.asset,bytes:Buffer.from(value.bytes)}; },
    async commitPreparation(workspace,input) {
      if(preparations.has(input.commandId))return preparations.get(input.commandId)!;
      const source=await media.loadPrivateAsset(workspace,input.sourceAssetId,input.sourceSha256);
      const variants=input.variants.map(v=>{const bytes=Buffer.from(v.bytes),asset:SeoMediaAsset={id:randomUUID(),workspaceId:workspace,blobId:randomUUID(),kind:'variant',validation:'prepared_jpeg',sha256:sha(bytes),byteLength:bytes.length,mimeType:'image/jpeg',width:v.recipe.width,height:v.recipe.height,sourceAssetId:source.asset.id,recipe:v.recipe,provenance:source.asset.provenance,createdAt:now()};assets.set(asset.id,{asset,bytes});return asset;});
      const result:SeoMediaPreparation={id:input.commandId,workspaceId:workspace,sourceAssetId:source.asset.id,sourceSha256:source.asset.sha256,sourceDimensions:input.sourceDimensions,outcome:input.outcome,variants,detail:input.detail};preparations.set(input.commandId,result);return result;
    },
    async getAssetCanonicalManifest(workspace,input) {const {asset}=await media.loadPrivateAsset(workspace,input.assetId,input.assetSha256);if(!asset.recipe||asset.recipe.profile!==input.profile||!asset.width||!asset.height)throw Error('Exact crop required');return {schema:'relaunch72.seo-media/v1',assetId:asset.id,byteSha256:asset.sha256,byteLength:asset.byteLength,mimeType:'image/jpeg',width:asset.width,height:asset.height,recipe:asset.recipe,presentation:{profile:input.profile,alt:input.alt},provenance:asset.provenance};},
    async reserveMediaUse(workspace,input) {let saved=reservations.get(input.commandId);if(!saved){const release=randomUUID();saved={...input,workspaceId:workspace,prospectiveReleaseId:release,prospectiveUrl:`https://app.relaunch72.com/api/public/seo-blog/media/${release}/${input.assetSha256}.jpg`};reservations.set(input.commandId,saved);}return saved;},
    async recordOwnerImageAuthorization(workspace,input) {const r=reservations.get(input.reservationCommandId)!;return {useKind:'blog_hero',id:input.commandId,workspaceId:workspace,reservationCommandId:r.commandId,assetId:r.assetId,assetSha256:r.assetSha256,articleVersionId:input.articleVersionId,articleContentSha256:input.articleContentSha256,reviewedIntentSha256:input.reviewedIntentSha256,authorizingUserId:ownerId,canonical:input.canonical};},
    async recordOwnerSocialImageAuthorization(workspace,input) {const article=await store.getArticle(workspace,input.articleId),v=article?.campaign?.variants.find(v=>v.id===input.variantId),r=v?.revisions.find(r=>r.id===v.currentRevisionId);if(!r||r.id!==input.variantRevisionId||r.sha256!==input.variantSha256||r.media?.useId!==input.useId)throw Error('Exact current native revision required');let saved=uses.get(input.useId);if(!saved){saved={...input,id:input.commandId,workspaceId:workspace,useKind:'social_variant',authorizingUserId:ownerId};uses.set(input.useId,saved);}return saved;},
    async withdrawAssetOrRelease(_workspace,input) {const target=input.scope==='asset'?input.assetId:input.releaseId;withdrawn.add(target);return {id:input.commandId,scope:input.scope,targetId:target,assetSha256:input.assetSha256,withdrawnAt:now()};},
  };
  return {media,drafts,approvals,assets,uses,canonical,
    async find(source:CreateCompanyContentVersionCommand['source'],contentSha:string) {const row=canonical.get(`${source.system}:${source.itemId}:${source.version}`);if(!row)return null;if(row.sha!==contentSha)throw Error('Canonical bytes changed');return {contentItemId:row.itemId,contentVersionId:row.id};},
    context:(workspaceId:string)=>({actorKind:'user' as const,userId:ownerId,workspaceId,requestId:randomUUID()}),
  };
}
