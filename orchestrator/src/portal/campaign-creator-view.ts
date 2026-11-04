import { randomUUID } from 'node:crypto';
import type { BrandProfile } from '../seo-blog/types.js';
import type { AdvocacyKit, CampaignContent, CreatorRecord, EmailCampaign } from '../seo-blog/campaign-creator.js';
import { escapeHtml as e } from './ui.js';
import { csrfField, layout, SEO_BLOG_BASE, type Shell } from './seo-blog-view.js';

const base=(shell:Shell)=>`${SEO_BLOG_BASE}/b/${shell.brand!.id}/campaigns`;
function input(name:string,label:string,value:string,max:number,kind='text'):string{return `<label>${e(label)}<input type="${kind}" name="${e(name)}" value="${e(value)}" maxlength="${max}" required></label>`;}
function area(name:string,label:string,value:string,max:number,rows=5):string{return `<label>${e(label)}<textarea name="${e(name)}" maxlength="${max}" rows="${rows}" required>${e(value)}</textarea></label>`;}
function createForm(shell:Shell,profile:BrandProfile,kind:'email'|'advocacy'):string {
  const email=kind==='email';
  return `<section class="card"><h2>${email?'Inbox Engine · Email campaign':'Word of Mouth Engine · Requests and referrals'}</h2><p>${email?'Create a useful sequence, choose the subject lines, then review every email.':'Prepare optional feedback requests and referral invitations. Customer responses and permission are recorded separately by you.'}</p><form method="post" action="${base(shell)}/create">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${randomUUID()}"><input type="hidden" name="kind" value="${kind}">
  ${input('name','Campaign name','',160)}${area('goal','What should this campaign help the reader do?','',1000,3)}
  <label>Audience<select name="audience" required>${profile.audiences.map(a=>`<option value="${e(a)}">${e(a)}</option>`).join('')}</select></label>
  <label>Purpose<select name="purpose">${(email?[['welcome','Welcome'],['onboarding','Onboarding'],['education','Useful education'],['promotion','Promote an approved offer']]:[['both','Feedback and referrals'],['testimonial','Feedback requests'],['referral','Referral invitations']]).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label>
  ${email?'<label>Number of emails<input type="number" name="count" value="3" min="1" max="7" required></label>':'<input type="hidden" name="count" value="1">'}
  <label>Approved offer<select name="offerName"><option value="">No offer needed</option>${profile.offers.map(o=>`<option value="${e(o.name)}">${e(o.name)}</option>`).join('')}</select></label>
  <label>Reader’s next step<select name="ctaIndex" required>${profile.conversionPages.map((p,i)=>`<option value="${i}">${e(p.label)} — ${e(p.url)}</option>`).join('')}</select></label>
  ${area('permissionContext','Who is this for, and what permission would allow you to contact them?','',1500,3)}
  ${email?'<input type="hidden" name="customerMoment" value=""><input type="hidden" name="consentProcess" value=""><input type="hidden" name="incentiveTerms" value="None">':area('customerMoment','What real customer milestone would make this request appropriate?','',1500,3)+area('consentProcess','How will you record permission, approved attribution and withdrawal requests?','',1500,3)+area('incentiveTerms','Approved referral incentive terms, or None','None',1500,3)}
  <p class="section-note">Uses your writing allowance. Relative days are proposed timing. Creating this draft does not contact anyone.</p><button type="submit">Create ${email?'email campaign':'request kit'}</button></form></section>`;
}
export function campaignCreatorsPage(shell:Shell,profile:BrandProfile|null,records:readonly CreatorRecord[]):string {
  const ready=Boolean(profile?.confirmedAt&&profile.audiences.length&&profile.conversionPages.length&&!profile.conflicts.length);
  return layout(shell,'Campaign creators',`<h1>Campaign creators</h1><p class="muted">Shared production methods, written in ${e(shell.brand!.name)}’s voice. Review and export here; delivery stays in your existing tools.</p>
  ${ready?`<div class="setup-grid">${createForm(shell,profile!,'email')}${createForm(shell,profile!,'advocacy')}</div>`:`<section class="card"><h2>Confirm this brand’s context first</h2><p>Resolve conflicting facts and confirm an audience and working next-step link in Brand setup.</p><a class="button" href="${SEO_BLOG_BASE}/b/${shell.brand!.id}/setup">Review brand setup</a></section>`}
  <section class="card"><h2>Saved campaigns</h2>${records.length?records.map(r=>`<article><h3><a href="${base(shell)}/${r.id}">${e(r.brief.name)}</a></h3><p>${r.brief.kind==='email'?'Email campaign':'Request kit'} · <span class="pill">${e(r.state)}</span> · ${e(r.createdAt.slice(0,10))}</p></article>`).join(''):'<p>No campaigns yet. Start with one useful sequence or request kit.</p>'}</section>`);
}
function emailEditor(v:EmailCampaign):string {
  return v.emails.map((mail,i)=>`<fieldset class="card"><legend>Email ${i+1}</legend><label>Proposed day after the start<input type="number" name="email.${i}.dayOffset" min="0" max="90" value="${mail.dayOffset}" required></label>${input(`email.${i}.purpose`,'Job of this email',mail.purpose,180)}
  ${mail.subjects.map((subject,j)=>input(`email.${i}.subject.${j}`,`Subject option ${j+1}`,subject,100)).join('')}
  <label>Chosen subject<select name="email.${i}.chosen">${mail.subjects.map((s,j)=>`<option value="${j}"${s===mail.subject?' selected':''}>Option ${j+1}</option>`).join('')}</select></label>
  ${input(`email.${i}.preview`,'Preview text',mail.preview,180)}${area(`email.${i}.body`,'Email body',mail.body,7000,12)}<p>Next step: ${e(mail.cta.label)} · ${e(mail.cta.url)}</p></fieldset>`).join('');
}
function advocacyEditor(v:AdvocacyKit):string {
  return v.requests.map((r,i)=>`<fieldset class="card"><legend>Request ${i+1}</legend>${area(`request.${i}.moment`,'Customer moment',r.moment,500,3)}${area(`request.${i}.shortRequest`,'Short request',r.shortRequest,700)}${area(`request.${i}.standardRequest`,'Standard request',r.standardRequest,1800,8)}${area(`request.${i}.followUp`,'Gentle follow-up',r.followUp,900)}${r.questions.map((q,j)=>input(`request.${i}.question.${j}`,`Neutral question ${j+1}`,q,250)).join('')}</fieldset>`).join('')+
  (v.referralMessages?`<fieldset class="card"><legend>Referral invitations</legend>${area('referral.short','Short invitation',v.referralMessages.short,700)}${area('referral.standard','Standard invitation',v.referralMessages.standard,1400,7)}${area('referral.extended','Extended invitation',v.referralMessages.extended,2200,9)}</fieldset>`:'')+
  `<fieldset class="card"><legend>Permission checklist</legend>${v.consentChecklist.map((s,i)=>input(`consent.${i}`,`Check ${i+1}`,s,300)).join('')}<p>Approved incentive terms: ${e(v.incentiveTerms)}</p></fieldset>`;
}
export function campaignCreatorReviewPage(shell:Shell,record:CreatorRecord,currentProfile:BrandProfile|null):string {
  const r=record,v=r.version;
  const current=Boolean(currentProfile?.confirmedAt&&currentProfile.version===r.profileVersion&&currentProfile.factsSha===r.factsSha&&!currentProfile.conflicts.length);
  const editAllowed=current&&['draft','approved'].includes(r.state)&&v;
  const hidden=`${csrfField(shell.csrf)}<input type="hidden" name="rowVersion" value="${r.rowVersion}"><input type="hidden" name="contentSha" value="${e(v?.contentSha??'')}">`;
  return layout(shell,'Review campaign',`<p><a href="${base(shell)}">← Campaign creators</a></p><h1>${e(r.brief.name)}</h1><p><span class="pill">${e(r.state)}</span> · ${e(r.detail)}</p>
  ${!current?'<p class="notice">Brand context changed or needs confirmation. Review Brand setup and create a fresh campaign from the current facts.</p>':''}
  <section class="card"><h2>Campaign brief</h2><p>${e(r.brief.goal)}</p><p>Audience: ${e(r.brief.audience)}</p><p>Permission context: ${e(r.brief.permissionContext)}</p>${r.brief.kind==='advocacy'?`<p>Permission process: ${e(r.brief.consentProcess)}</p>`:''}<p class="section-note">This is an authoring draft. It does not establish any recipient’s consent or schedule a send.</p></section>
  ${v?`<form method="post" action="${base(shell)}/${r.id}/edit">${hidden}<fieldset${editAllowed?'':' disabled'}>${input('title','Draft title',v.content.title,160)}${area('summary','Campaign summary',v.content.summary,800,3)}${r.brief.kind==='email'?emailEditor(v.content as EmailCampaign):advocacyEditor(v.content as AdvocacyKit)}<button type="submit">Save a new draft version</button></fieldset></form>
  ${editAllowed?`<section class="card"><h2>Review this version</h2><p>Editing clears approval. Check every subject, claim, link and permission note before approving.</p><form method="post" action="${base(shell)}/${r.id}/approve">${hidden}<label><input type="checkbox" name="reviewed" value="1" required> I reviewed the wording, facts and permission process for this exact draft.</label><button type="submit">Approve this campaign draft</button></form>${r.state==='approved'?`<p><a class="button" href="${base(shell)}/${r.id}/export">Export approved campaign</a> <a href="${base(shell)}/${r.id}/export?format=json">Export JSON</a></p>`:''}</section>`:''}`:
  `<section class="card"><h2>No usable draft yet</h2><p>A pending or uncertain request is never automatically repeated. Check its saved run to recover any completed draft. If it remains uncertain, its writing allowance stays reserved until the operation is reconciled.</p><form method="post" action="${base(shell)}/${r.id}/recover">${csrfField(shell.csrf)}<button type="submit">Check saved run</button></form></section>`}`);
}
/** Rebuild from known saved fields, not browser-supplied schema or recipient data. */
export function creatorContentFromForm(record:CreatorRecord,fields:URLSearchParams):CampaignContent {
  if(!record.version)throw new Error('No saved draft to edit.');
  const content=structuredClone(record.version.content);
  content.title=fields.get('title')??'';content.summary=fields.get('summary')??'';
  if(record.brief.kind==='email')for(const [i,mail] of (content as EmailCampaign).emails.entries()){
    mail.dayOffset=Number(fields.get(`email.${i}.dayOffset`));mail.purpose=fields.get(`email.${i}.purpose`)??'';
    mail.subjects=mail.subjects.map((_s,j)=>fields.get(`email.${i}.subject.${j}`)??'');
    mail.subject=mail.subjects[Number(fields.get(`email.${i}.chosen`))]??'';
    mail.preview=fields.get(`email.${i}.preview`)??'';mail.body=fields.get(`email.${i}.body`)??'';
  }else{
    const kit=content as AdvocacyKit;
    for(const [i,request] of kit.requests.entries()){
      for(const key of ['moment','shortRequest','standardRequest','followUp'] as const)request[key]=fields.get(`request.${i}.${key}`)??'';
      request.questions=request.questions.map((_q,j)=>fields.get(`request.${i}.question.${j}`)??'');
    }
    if(kit.referralMessages)for(const key of ['short','standard','extended'] as const)kit.referralMessages[key]=fields.get(`referral.${key}`)??'';
    kit.consentChecklist=kit.consentChecklist.map((_s,i)=>fields.get(`consent.${i}`)??'');
  }
  return content;
}
export function creatorTextExport(record:CreatorRecord,content?:CampaignContent):string {
  const c=content??record.version!.content;
  const intro=`${record.brief.name}\nApproved authoring draft — not sent or scheduled.\nPermission context: ${record.brief.permissionContext}\n\n${c.summary}\n`;
  if(record.brief.kind==='email')return intro+(c as EmailCampaign).emails.map((m,i)=>`\nEMAIL ${i+1} — proposed day ${m.dayOffset}\nSubject: ${m.subject}\nAlternatives: ${m.subjects.filter(s=>s!==m.subject).join(' / ')}\nPreview: ${m.preview}\n\n${m.body}\n\n${m.cta.label}: ${m.cta.url}\n`).join('');
  const k=c as AdvocacyKit;
  return intro+`\nPermission process: ${record.brief.consentProcess}\nIncentive terms: ${k.incentiveTerms}\n`+k.requests.map((r,i)=>`\nREQUEST ${i+1}: ${r.moment}\n${r.shortRequest}\n\n${r.standardRequest}\n\nFollow-up: ${r.followUp}\nQuestions:\n${r.questions.map(q=>'- '+q).join('\n')}\n`).join('')+(k.referralMessages?`\nREFERRAL INVITATIONS\n${k.referralMessages.short}\n\n${k.referralMessages.standard}\n\n${k.referralMessages.extended}\n`:'')+`\nPERMISSION CHECKLIST\n${k.consentChecklist.map(s=>'- '+s).join('\n')}\n`;
}
export function productionRulesPage(shell:Shell,data:{enabled:boolean;assignment:{revision:number;pins:readonly {packId:string}[]}|null},creatorsReady:boolean):string {
  const names=['Engine Room','Editor’s Desk','Longform Forge','Hook & Close','Multiplier','Art Director'];
  return layout(shell,'Production rules',`<h1>Production rules</h1><section class="card"><h2>Shared methods, separate brand context</h2><p>Use the reviewed rules for this brand’s new drafts. Existing drafts keep their recorded methods. Each brand retains its own facts, audience, voice and approved links.</p><ul>${names.map(n=>`<li>${n}</li>`).join('')}</ul><p>Currently assigned: ${data.assignment?.pins.length??0} packs.</p>${data.enabled?`<form method="post" action="${SEO_BLOG_BASE}/b/${shell.brand!.id}/methods/activate">${csrfField(shell.csrf)}<input type="hidden" name="revision" value="${data.assignment?.revision??0}">${creatorsReady?'<label><input type="checkbox" name="creators" value="1" checked> Include Inbox Engine and Word of Mouth Engine authoring</label>':''}<p class="section-note">Changing production rules does not grant sending, publishing or image-generation permission.</p><button type="submit">Use reviewed production rules</button></form>`:'<p>The reviewed production release has not been enabled yet.</p>'}</section>`);
}
