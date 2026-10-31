import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalCompanyContentEmailDraft } from '../src/company-content-pg/index.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';
import { MHP_MARKETING_TEMPLATES } from '../src/mhp/marketing-templates.js';
import {
  MHP_OWNER_EMAIL_ORGANIZATION, MHP_WEBINAR_EMAIL_STEPS, mhpEmailSha,
  mhpOwnerEmailDraftCommand, mhpOwnerEmailSeed, parseMhpOwnerEmailBrand, renderMhpOwnerEmail, validateMhpOwnerEmailCopy,
} from '../src/mhp/owner-email-content.js';

const commandId='12600000-0000-4000-8000-000000000001';
const canonical=JSON.stringify({schema:'mhp.organization-branding/v1',organizationId:MHP_OWNER_EMAIL_ORGANIZATION,
  productName:'Martin Howard Property',primaryColor:'#1F6B45',accentColor:'#E8A33D',logoStorageKey:null,logoSha256:null,
  supportEmail:'owner@example.invalid',revision:'2026-10-31T00:00:00Z'});
const sha256=mhpEmailSha(canonical),ref=`mhp:organization-branding:${MHP_OWNER_EMAIL_ORGANIZATION}:${sha256}`;
const brand=parseMhpOwnerEmailBrand({canonical,sha256,ref});
const input={commandId,title:'Owner webinar follow-up',subject:'Hello {{FIRSTNAME}}',bodyText:'Thanks for joining {{LABEL}}.\n{{LINK}}',
  campaign:'webinar-2026-11-04',brand,now:Date.parse('2026-10-31T00:00:00Z')};

test('owner email reuses canonical subject/body and retains exact real branding/local manifest evidence',()=>{
  const draft=mhpOwnerEmailDraftCommand(input),body=canonicalCompanyContentEmailDraft(input.subject,input.bodyText);
  assert.equal(draft.origin,'imported');assert.equal(draft.source.system,'mhp.owner-email');
  assert.equal(draft.source.itemId,`owner-email:${commandId}`);assert.equal(draft.source.version,`edit:${commandId}`);
  assert.equal(draft.blob.sha256,mhpEmailSha(body));assert.equal(draft.blob.storageKey,`inline:mhp.owner-email:${mhpEmailSha(body)}`);
  const local=draft.metadata!.mhpOwnerEmail as Record<string,string>;
  assert.equal(local.brandCanonical,canonical);assert.equal(local.manifestSha256,mhpEmailSha(local.manifestCanonical!));
  assert.equal(draft.attestation.catalogSha256,local.manifestSha256);
  assert.equal(Date.parse(draft.attestation.expiresAt)-Date.parse(draft.attestation.checkedAt),900_000);
  const manifest=JSON.parse(local.manifestCanonical!);assert.equal(manifest.audienceCampaign,input.campaign);
  assert.equal(manifest.brandSha256,sha256);assert.equal(manifest.contentSha256,draft.blob.sha256);
  assert.doesNotMatch(local.manifestCanonical!,/property.predator/u);
});

test('editing preserves source item and exact predecessor while advancing the source revision',()=>{
  const previous={contentItemId:'12600000-0000-4000-8000-000000000002',contentVersionId:'12600000-0000-4000-8000-000000000003',sourceItemId:`owner-email:${commandId}`};
  const edited=mhpOwnerEmailDraftCommand({...input,commandId:'12600000-0000-4000-8000-000000000004',previous});
  assert.equal(edited.origin,'edited');assert.equal(edited.contentItemId,previous.contentItemId);
  assert.equal(edited.previousVersionId,previous.contentVersionId);assert.equal(edited.source.itemId,previous.sourceItemId);
  assert.notEqual(edited.source.version,`edit:${commandId}`);
});

test('all five existing code templates are exact starting copies without changing automatic copy',()=>{
  for(const step of MHP_WEBINAR_EMAIL_STEPS){const seed=mhpOwnerEmailSeed(step);
    assert.equal(seed.subject,MHP_MARKETING_TEMPLATES[step].subject);assert.equal(seed.bodyText,MHP_MARKETING_TEMPLATES[step].text);
    assert.doesNotThrow(()=>validateMhpOwnerEmailCopy(seed.subject,seed.bodyText));}
  assert.throws(()=>mhpOwnerEmailSeed('sheet_delivery'),MhpCommerceError);
});

test('brand digest, organization and real revision cannot be replaced with PP or arbitrary snapshot data',()=>{
  assert.throws(()=>parseMhpOwnerEmailBrand({canonical:canonical+' ',sha256,ref}),MhpCommerceError);
  for(const change of [{organizationId:'foreign'},{revision:'not-a-date'},{primaryColor:'red;display:none'}]){
    const changed=JSON.stringify({...JSON.parse(canonical),...change}),hash=mhpEmailSha(changed);
    assert.throws(()=>parseMhpOwnerEmailBrand({canonical:changed,sha256:hash,ref:`mhp:organization-branding:${MHP_OWNER_EMAIL_ORGANIZATION}:${hash}`}),MhpCommerceError);
  }
});

test('text renderer uses only pinned digest, safely substitutes values and always supplies real unsubscribe',()=>{
  const copy=canonicalCompanyContentEmailDraft('Hello {{FIRSTNAME}}','<script>alert(1)</script>\n{{LABEL}}\n{{LINK}}');
  const args={canonicalContent:copy,contentSha256:mhpEmailSha(copy),brand,firstName:'<b>Sam</b>',label:'A & B',
    link:'https://outside.example/steal',unsubscribe:'https://app.martinhowardproperty.co.uk/email/unsubscribe?p=proof&t=proof'};
  const rendered=renderMhpOwnerEmail(args);
  assert.match(rendered.html,/&lt;script&gt;/u);assert.doesNotMatch(rendered.html,/<script>/u);
  assert.match(rendered.text,/https:\/\/martinhowardproperty.co.uk\/webinar\//u);
  assert.match(rendered.text,/Unsubscribe:/u);assert.match(rendered.html,/href="https:\/\/app.martinhowardproperty.co.uk\/email\/unsubscribe/u);
  assert.throws(()=>renderMhpOwnerEmail({...args,contentSha256:'0'.repeat(64)}),/digest mismatch/u);
  assert.throws(()=>renderMhpOwnerEmail({...args,unsubscribe:'javascript:alert(1)'}),/unsubscribe link/u);
});

test('owner preview is explicit and unsupported merge fields/header injection fail before send',()=>{
  const copy=validateMhpOwnerEmailCopy('A preview','Hi {{FIRSTNAME}}');
  const result=renderMhpOwnerEmail({canonicalContent:copy,contentSha256:mhpEmailSha(copy),brand,firstName:'Sam',label:'Sample webinar',
    link:'https://martinhowardproperty.co.uk/webinar/',unsubscribe:'https://example.invalid/unsubscribe-preview',preview:true});
  assert.equal(result.subject,'[TEST] A preview');assert.match(result.text,/not been sent to your webinar audience/u);
  assert.throws(()=>validateMhpOwnerEmailCopy('x\r\nBcc: somebody','body'),MhpCommerceError);
  assert.throws(()=>validateMhpOwnerEmailCopy('x','{{ARBITRARY}}'),MhpCommerceError);
  assert.throws(()=>validateMhpOwnerEmailCopy('x','x'.repeat(50_001)),MhpCommerceError);
});
