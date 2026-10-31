import { createHash } from 'node:crypto';
import type { CompanyContentCatalogItem, CompanyContentExactReview } from '../../src/company-content-pg/index.js';
import { canonicalCompanyContentEmailDraft, COMPANY_CONTENT_EMAIL_DRAFT_MIME_TYPE } from '../../src/company-content-pg/index.js';
import { MHP_MARKETING_WORKSPACE_ID } from '../../src/mhp/marketing-workspace-service.js';
import { MHP_OWNER_EMAIL_ORGANIZATION, mhpEmailSha, parseMhpOwnerEmailBrand } from '../../src/mhp/owner-email-content.js';
import type { MhpOwnerEmailExactLocal, MhpOwnerEmailLocalVersion, MhpOwnerEmailSnapshot } from '../../src/mhp/owner-email-service.js';

export const ids={user:'12600000-0000-4000-8000-000000000001',item:'12600000-0000-4000-8000-000000000002',
  version:'12600000-0000-4000-8000-000000000003',command:'12600000-0000-4000-8000-000000000004',
  approval:'12600000-0000-4000-8000-000000000005',request:'12600000-0000-4000-8000-000000000006',
  send:'12600000-0000-4000-8000-000000000007',lease:'12600000-0000-4000-8000-000000000008',proof:'12600000-0000-4000-8000-000000000009',
  prospect:'12600000-0000-4000-8000-000000000010'};
export const token=Buffer.alloc(32,12).toString('base64url');
export const identity={sessionToken:token,userId:ids.user,workspaceId:MHP_MARKETING_WORKSPACE_ID,userEmail:'owner@example.invalid'} as const;
export const tokenHash=createHash('sha256').update(token).digest();
export const now=Date.parse('2026-10-31T00:00:00Z');
const canonical=JSON.stringify({schema:'mhp.organization-branding/v1',organizationId:MHP_OWNER_EMAIL_ORGANIZATION,
  productName:'Martin Howard Property',primaryColor:'#1F6B45',accentColor:'#E8A33D',logoStorageKey:null,logoSha256:null,
  supportEmail:'owner@example.invalid',revision:'2026-10-31T00:00:00Z'});
export const brand=parseMhpOwnerEmailBrand({canonical,sha256:mhpEmailSha(canonical),
  ref:`mhp:organization-branding:${MHP_OWNER_EMAIL_ORGANIZATION}:${mhpEmailSha(canonical)}`});
export const copy={title:'Owner webinar follow-up',subject:'Hi {{FIRSTNAME}}',bodyText:'Your £500 café example\n{{LABEL}}\n{{LINK}}'};
export const content=canonicalCompanyContentEmailDraft(copy.subject,copy.bodyText),digest=mhpEmailSha(content);
export const exact:MhpOwnerEmailExactLocal={contentItemId:ids.item,contentVersionId:ids.version,sourceItemId:`owner-email:${ids.command}`,
  sourceVersion:`edit:${ids.command}`,canonicalContent:content,contentSha256:digest,blobSha256:digest,brand,
  manifestCanonical:'{}',manifestSha256:mhpEmailSha('{}'),approvalDecisionId:null,audienceCampaign:'webinar-proof'};
export const local:MhpOwnerEmailLocalVersion={...exact,versionNumber:1,previousVersionId:null,title:copy.title,brandSha256:brand.sha256,
  metadata:{},valid:true,exact};
export const review:CompanyContentExactReview={contentItemId:ids.item,contentVersionId:ids.version,versionNumber:1,isLatest:true,
  origin:'imported',kind:'email',title:copy.title,contentMimeType:COMPANY_CONTENT_EMAIL_DRAFT_MIME_TYPE,canonicalContent:content,
  canonicalByteLength:Buffer.byteLength(content),contentSha256:digest,source:{system:'mhp.owner-email',itemId:exact.sourceItemId,version:exact.sourceVersion},
  blobSha256:digest,brandSha256:brand.sha256,approvalRequestId:null,approvalDecisionId:null,approvalStatus:'unrequested',approvalStale:false,
  email:{schema:'propertypredator.email-draft/v1',subject:copy.subject,bodyText:copy.bodyText,subjectSha256:mhpEmailSha(copy.subject),bodySha256:mhpEmailSha(copy.bodyText)},
  createdAt:new Date(now).toISOString()};
export const catalogItem:CompanyContentCatalogItem={...review,sourceAttestationId:ids.proof,sourceCheckedAt:new Date(now).toISOString(),
  sourceExpiresAt:new Date(now+900_000).toISOString(),sourceFresh:true,publishable:false};
export const snapshot:MhpOwnerEmailSnapshot={brand,status:{mode:'test',providerReady:true,testRecipientCount:1,testEnabled:true},
  catalog:{items:[catalogItem],nextCursor:null},database:{brand,campaign:'webinar-proof',eligible:3,automatic:[],ownerItems:[],tests:[]}};
