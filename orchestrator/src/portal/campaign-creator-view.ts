import { randomUUID } from 'node:crypto';
import { parseCreativeUtmContent } from '../creative-studio/distribution.js';
import type { BrandProfile } from '../seo-blog/types.js';
import { ACQUISITION_CHANNELS, ACQUISITION_OBJECTIVES, type AcquisitionProposal, type AdvocacyKit, type CampaignContent, type CreatorRecord, type EmailCampaign } from '../seo-blog/campaign-creator.js';
import { creativePrefill, trackedLinks } from '../seo-blog/acquisition-assembly.js';
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
const CHANNEL_LABEL:Record<string,string>={instagram:'Instagram',facebook:'Facebook',linkedin:'LinkedIn',email:'Email',search:'Search',website:'Website'};
const OBJECTIVE_LABEL:Record<string,string>={leads:'Qualified leads',bookings:'Bookings',sales:'Sales',sign_ups:'Sign-ups',awareness:'Awareness'};
function acquisitionForm(shell:Shell,profile:BrandProfile,articles:readonly {id:string;title:string}[]):string {
  return `<section class="card"><h2>Hook &amp; Close · Acquisition campaign</h2><p>Turn this brand's saved research, audience guidance and approved facts into an evidence-led campaign proposal: problems, objections, channels, distinct concepts and a measurement plan.</p><form method="post" action="${base(shell)}/create">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${randomUUID()}"><input type="hidden" name="kind" value="acquisition"><input type="hidden" name="purpose" value="acquisition">
  ${input('name','Campaign name','',160)}${area('goal','What should this campaign achieve?','',1000,3)}
  <label>Objective<select name="objective">${ACQUISITION_OBJECTIVES.map(o=>`<option value="${o}">${OBJECTIVE_LABEL[o]}</option>`).join('')}</select></label>
  <label>Audience<select name="audience" required>${profile.audiences.map(a=>`<option value="${e(a)}">${e(a)}</option>`).join('')}</select></label>
  <label>Approved offer<select name="offerName"><option value="">No specific offer</option>${profile.offers.map(o=>`<option value="${e(o.name)}">${e(o.name)}</option>`).join('')}</select></label>
  <label>Destination<select name="ctaIndex" required>${profile.conversionPages.map((p,i)=>`<option value="${i}">${e(p.label)} — ${e(p.url)}</option>`).join('')}</select></label>
  <fieldset><legend>Channels to consider</legend>${ACQUISITION_CHANNELS.map(c=>`<label style="display:inline-block;margin-right:12px;font-weight:400"><input type="checkbox" name="channels" value="${c}"${['instagram','linkedin'].includes(c)?' checked':''}> ${CHANNEL_LABEL[c]}</label>`).join('')}</fieldset>
  <label>Distinct concepts<select name="count"><option>1</option><option>2</option><option selected>3</option></select></label>
  ${articles.length?`<fieldset><legend>Supporting articles (up to three)</legend>${articles.slice(0,12).map(a=>`<label style="display:block;font-weight:400"><input type="checkbox" name="articleId" value="${e(a.id)}"> ${e(a.title)}</label>`).join('')}</fieldset>`:''}
  <input type="hidden" name="permissionContext" value="Campaign proposal only; the owner decides channels, audiences, budgets and activation separately."><input type="hidden" name="customerMoment" value=""><input type="hidden" name="consentProcess" value=""><input type="hidden" name="incentiveTerms" value="None">
  <p class="section-note">Uses your writing allowance (one reserved model run). Creating a proposal does not publish, schedule, contact anyone or start any advertising spend.</p><button type="submit">Create campaign proposal</button></form></section>`;
}
export function campaignCreatorsPage(shell:Shell,profile:BrandProfile|null,records:readonly CreatorRecord[],enabledKinds:readonly ('email'|'advocacy'|'acquisition')[]=['email','advocacy'],articles:readonly {id:string;title:string}[]=[]):string {
  const ready=Boolean(profile?.confirmedAt&&profile.audiences.length&&profile.conversionPages.length&&!profile.conflicts.length);
  return layout(shell,'Campaign creators',`<h1>Campaign creators</h1><p class="muted">Shared production methods, written in ${e(shell.brand!.name)}’s voice. Review and export here; delivery stays in your existing tools.</p>
  ${ready&&enabledKinds.includes('acquisition')?acquisitionForm(shell,profile!,articles):''}
  ${ready?`<div class="setup-grid">${(['email','advocacy'] as const).map(kind=>enabledKinds.includes(kind)?createForm(shell,profile!,kind):`<section class="card"><h2>${kind==='email'?'Inbox Engine':'Word of Mouth Engine'} is switched off</h2><p>Saved drafts remain available. New generation is disabled for this brand.</p><a href="${SEO_BLOG_BASE}/b/${shell.brand!.id}/methods">Manage production packs</a></section>`).join('')}</div>`:`<section class="card"><h2>Confirm this brand’s context first</h2><p>Resolve conflicting facts and confirm an audience and working next-step link in Brand setup.</p><a class="button" href="${SEO_BLOG_BASE}/b/${shell.brand!.id}/setup">Review brand setup</a></section>`}
  <section class="card"><h2>Saved campaigns</h2>${records.length?records.map(r=>`<article><h3><a href="${base(shell)}/${r.id}">${e(r.brief.name)}</a></h3><p>${r.brief.kind==='email'?'Email campaign':r.brief.kind==='advocacy'?'Request kit':'Acquisition proposal'} · <span class="pill">${e(r.state)}</span> · ${e(r.createdAt.slice(0,10))}</p></article>`).join(''):'<p>No campaigns yet. Start with one useful sequence or request kit.</p>'}</section>`);
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
function evidenceLabel(record:CreatorRecord,id:string):string {
  const ev=record.brief.evidence,research=ev?.research??[];
  const m=/^S(\d+)$/.exec(id),s=m?research[Number(m[1])-1]:research.find(x=>x.id===id);
  if(s)return `<a href="${e(s.url)}" rel="noopener noreferrer" target="_blank" title="${e(s.passage)}">${e(s.title)}</a> <span class="muted">(research, retrieved ${e(s.retrievedAt.slice(0,10))}${s.primary?', primary source':''})</span>`;
  const f=ev?.facts.find(x=>x.id===id);if(f)return `${e(f.title)} <span class="muted">(${f.kind==='article'?'your article':'your audience guidance'})</span>`;
  if(/^profile:\d+:claim:/.test(id))return 'Approved claim <span class="muted">(brand profile)</span>';
  if(/^profile:\d+:offer:/.test(id))return 'Approved offer <span class="muted">(brand profile)</span>';
  return `${e(id)} <span class="pill bad">unknown</span>`;
}
export type CampaignOutcomesView = Pick<import('../creative-studio/service.js').LearningView,'utmCampaign'|'read'|'limits'> & Partial<import('../creative-studio/service.js').LearningView>;
function actualResults(o:CampaignOutcomesView|null|undefined):string {
  if(o===undefined)return `<section class="card"><h2>Actual results</h2><p><strong>No results recorded.</strong> This is a plan. Results appear only from real outcomes recorded after you run it through an existing channel; nothing here is evidence of performance.</p></section>`;
  if(o===null)return `<section class="card"><h2>Actual results</h2><p class="notice bad">Outcomes and findings could not be read right now. Nothing was changed. Refresh to try again.</p></section>`;
  const rows=o.read?.buckets??[];
  const label=(c:string)=>{const p=parseCreativeUtmContent(c);return p?`Concept ${p.concept+1}${p.creative?` · artwork ${p.creative}`:''}`:c?`Other tag “${e(c)}”`:'No utm_content';};
  const table=o.read===null?'<p class="notice bad">CRM outcomes could not be read right now. Nothing was changed.</p>'
    :rows.length?`<table><thead><tr><th>Concept / artwork</th><th>Leads</th><th>Qualified</th><th>Booked</th><th>Sold</th><th>Customers</th><th>Subscriptions cancelled</th><th>First / latest touch</th></tr></thead><tbody>${rows.map(b=>`<tr><td>${label(b.utmContent)}</td><td>${b.leads}</td><td>${b.qualified}</td><td>${b.booked}</td><td>${b.sold}</td><td>${b.customers}</td><td>${b.subscriptionsCancelled}</td><td>${b.firstAt?e(b.firstAt.slice(0,10)):'—'} / ${b.lastAt?e(b.lastAt.slice(0,10)):'—'}</td></tr>`).join('')}</tbody></table>`
    :'<p><strong>No CRM contact carries this campaign’s tag yet.</strong> Zero here can also mean leads arrived through a form that does not record campaign tags (see limits).</p>';
  return `<section class="card"><h2>Actual results</h2>${o.read?`<p class="section-note">Read ${e(o.read.readAt.slice(0,16).replace('T',' '))} UTC from the existing CRM, journey and payment records for <code>utm_campaign=${e(o.utmCampaign)}</code>. Nothing is estimated.</p>`:`<p class="section-note">Campaign tag: <code>utm_campaign=${e(o.utmCampaign)}</code>.</p>`}${table}<h3>Attribution limits</h3><ul>${o.limits.map(l=>`<li>${e(l)}</li>`).join('')}</ul></section>`;
}
function acquisitionEditor(shell:Shell,r:CreatorRecord,v:AcquisitionProposal,outcomes?:CampaignOutcomesView|null):string {
  const links=trackedLinks(r.brief,r.id,v),creative=shell.creativeAvailable?`${SEO_BLOG_BASE}/b/${shell.brand!.id}/creative`:null;
  const ev=r.brief.evidence;
  return `<section class="card"><h2>Evidence used</h2>${ev?.gaps.length?`<ul>${ev.gaps.map(g=>`<li><span class="pill warn">Gap</span> ${e(g)}</li>`).join('')}</ul>`:''}<p class="section-note">${ev?.research.length??0} saved research source(s) and ${ev?.facts.length??0} owner fact(s) were supplied, plus the confirmed profile's approved claims and offers. Nothing else was searched or fetched.</p></section>
  <section class="card"><h2>Audience insights</h2><table><thead><tr><th>Type</th><th>Insight</th><th>Basis</th><th>Evidence</th></tr></thead><tbody>${v.insights.map((i,n)=>`<tr><td>${e(i.type)}</td><td style="min-width:320px">${area(`insight.${n}.statement`,`Insight ${n+1}`,i.statement,400,3)}</td><td><span class="pill ${i.basis==='observed'?'ok':'warn'}">${i.basis==='observed'?'Observed in evidence':'Inferred'}</span></td><td>${i.evidence.map(id=>evidenceLabel(r,id)).join('<br>')}</td></tr>`).join('')}</tbody></table></section>
  <section class="card"><h2>Objective and channels</h2><p><strong>${e(OBJECTIVE_LABEL[r.brief.objective??'']??'')}</strong> · ${e(v.objective.goal)} · primary metric: ${e(v.objective.primaryMetric)}</p><p>Destination: ${e(r.brief.cta.label)} — ${e(r.brief.cta.url)}</p><ul>${v.channels.map(c=>`<li><strong>${e(CHANNEL_LABEL[c.channel]??c.channel)}</strong> — ${e(c.role)}. <span class="muted">${e(c.rationale)}</span></li>`).join('')}</ul><p class="section-note">Channel roles are proposals. No account connection, audience targeting, budget or publication is created here.</p></section>
  ${v.concepts.map((c,n)=>`<fieldset class="card"><legend>Concept ${n+1} · ${e(c.name)}</legend><p class="muted">${e(c.angle)} · addresses insight ${c.addresses.map(i=>i+1).join(', ')} · ${c.channels.map(ch=>e(CHANNEL_LABEL[ch]??ch)).join(', ')}</p>
    ${input(`concept.${n}.hook`,'Hook',c.hook,120)}${input(`concept.${n}.headline`,'Headline',c.headline,90)}${area(`concept.${n}.primaryText`,'Primary text',c.primaryText,600,4)}${area(`concept.${n}.creativeDirection`,'Creative direction (illustrative image)',c.creativeDirection,500,2)}
    <p>Call to action: ${e(c.cta.label)}</p><details><summary>Tracked links</summary><ul>${links.filter(l=>l.concept===n).map(l=>`<li>${e(CHANNEL_LABEL[l.channel]??l.channel)}: <code>${e(l.url)}</code></li>`).join('')}</ul></details>
    ${creative?`<p><a class="button secondary" href="${creative}?${e(creativePrefill(r.brief,c))}">Create artwork for this concept</a></p>`:''}</fieldset>`).join('')}
  <section class="card"><h2>Measurement plan</h2><p>Primary: ${e(v.measurement.primaryMetric)}${v.measurement.secondaryMetrics.length?` · secondary: ${v.measurement.secondaryMetrics.map(e).join(', ')}`:''}</p><p>Review after ${v.measurement.reviewAfterDays} days. ${e(v.measurement.learningRule)}</p><h3>Attribution limits</h3><ul>${v.measurement.limitations.map(l=>`<li>${e(l)}</li>`).join('')}</ul></section>
  <section class="card"><h2>Predictions <span class="pill warn">Hypotheses — not results</span></h2><ul>${v.hypotheses.map(h=>`<li>${e(h.statement)} <span class="muted">${e(h.basis)}</span></li>`).join('')}</ul></section>
  ${actualResults(outcomes)}`;
}
/** `outcomes` undefined: studio off (plan only); null: the read failed; otherwise the learning view. */
export function campaignCreatorReviewPage(shell:Shell,record:CreatorRecord,currentProfile:BrandProfile|null,outcomes?:CampaignOutcomesView|null):string {
  const r=record,v=r.version;
  const current=Boolean(currentProfile?.confirmedAt&&currentProfile.version===r.profileVersion&&currentProfile.factsSha===r.factsSha&&!currentProfile.conflicts.length);
  const editAllowed=current&&['draft','approved'].includes(r.state)&&v;
  const hidden=`${csrfField(shell.csrf)}<input type="hidden" name="rowVersion" value="${r.rowVersion}"><input type="hidden" name="contentSha" value="${e(v?.contentSha??'')}">`;
  return layout(shell,'Review campaign',`<p><a href="${base(shell)}">← Campaign creators</a></p><h1>${e(r.brief.name)}</h1><p><span class="pill">${e(r.state)}</span> · ${e(r.detail)}</p>
  ${!current?'<p class="notice">Brand context changed or needs confirmation. Review Brand setup and create a fresh campaign from the current facts.</p>':''}
  <section class="card"><h2>Campaign brief</h2><p>${e(r.brief.goal)}</p><p>Audience: ${e(r.brief.audience)}</p>${r.brief.kind==='acquisition'?'':`<p>Permission context: ${e(r.brief.permissionContext)}</p>`}${r.brief.kind==='advocacy'?`<p>Permission process: ${e(r.brief.consentProcess)}</p>`:''}<p class="section-note">${r.brief.kind==='acquisition'?'This is a campaign proposal. It does not publish, schedule, target anyone or start advertising spend.':'This is an authoring draft. It does not establish any recipient’s consent or schedule a send.'}</p></section>
  ${v?`<form method="post" action="${base(shell)}/${r.id}/edit">${hidden}<fieldset${editAllowed?'':' disabled'}>${input('title','Draft title',v.content.title,160)}${area('summary','Campaign summary',v.content.summary,800,3)}${r.brief.kind==='email'?emailEditor(v.content as EmailCampaign):r.brief.kind==='advocacy'?advocacyEditor(v.content as AdvocacyKit):acquisitionEditor(shell,r,v.content as AcquisitionProposal,outcomes)}<button type="submit">Save a new draft version</button></fieldset></form>
  ${editAllowed?`<section class="card"><h2>Review this version</h2><p>Editing clears approval. Check every subject, claim, link and permission note before approving.</p><form method="post" action="${base(shell)}/${r.id}/approve">${hidden}<label><input type="checkbox" name="reviewed" value="1" required> ${r.brief.kind==='acquisition'?'I reviewed the evidence, wording and commercial claims of this exact proposal.':'I reviewed the wording, facts and permission process for this exact draft.'}</label><button type="submit">Approve this campaign draft</button></form>${r.state==='approved'?`<p><a class="button" href="${base(shell)}/${r.id}/export">Export approved campaign</a> <a href="${base(shell)}/${r.id}/export?format=json">Export JSON</a></p>`:''}</section>`:''}`:
  `<section class="card"><h2>No usable draft yet</h2><p>A pending or uncertain request is never automatically repeated. Check its saved run to recover any completed draft. If it remains uncertain, its writing allowance stays reserved until the operation is reconciled.</p><form method="post" action="${base(shell)}/${r.id}/recover">${csrfField(shell.csrf)}<button type="submit">Check saved run</button></form></section>`}
  ${r.brief.kind==='acquisition'&&outcomes&&outcomes.snapshot!==undefined?learningSection(shell,r,outcomes):''}`);
}
const STRENGTH:Record<string,[string,string]>={insufficient_data:['warn','Not enough data'],no_clear_difference:['','No clear difference'],observed_difference:['ok','Observed difference — not proof'],not_applicable:['','Observation']};
function learningSection(shell:Shell,r:CreatorRecord,o:CampaignOutcomesView):string {
  const snap=o.snapshot,cmd=()=>`${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${randomUUID()}">`;
  const findings=snap?`<ul class="findings">${snap.findings.map(f=>`<li><span class="pill ${STRENGTH[f.strength]![0]}">${STRENGTH[f.strength]![1]}</span> ${e(f.statement)}<br><span class="section-note">Observed ${e(f.observedAt.slice(0,10))}${f.period.from?` · period ${e(f.period.from.slice(0,10))} to ${e((f.period.to??f.period.from).slice(0,10))}`:''} · evidence: ${f.evidence.length?f.evidence.map(x=>`<code>${e(x.utmContent||'(no tag)')}</code>`).join(', '):'none'}</span></li>`).join('')}</ul>
    <p class="section-note">${snap.notCompared.map(e).join(' ')}</p>
    <form method="post" action="${base(shell)}/${r.id}/findings">${cmd()}<button type="submit" class="secondary">Record these findings with today’s date</button> <span class="muted small">Saves the statements with the exact outcome counts they cite. The counts are checked again against the CRM when saved; nothing is changed or started.</span></form>`
    :'<p class="notice bad">Outcomes could not be read right now, so no findings were prepared.</p>';
  const tests=snap?.nextTests.length?`<h3>Suggested next tests</h3><p class="section-note">Suggestions only. Each changes one thing against a control. Running, funding or scheduling a test is your decision; nothing here starts one.</p><ol>${snap.nextTests.map(t=>`<li><strong>${e(t.title)}</strong><dl class="section-note"><dt>Change</dt><dd>${e(t.change)}</dd><dt>Keep the same</dt><dd>${e(t.keepTheSame)}</dd><dt>Measure</dt><dd>${e(t.measure)}</dd><dt>Review after</dt><dd>${t.reviewAfterDays} days</dd><dt>Why</dt><dd>${e(t.why)}</dd><dt>Budget</dt><dd>${e(t.budget)}</dd></dl></li>`).join('')}</ol>`:'';
  const recorded=(o.recorded??[]).map(rec=>`<li><strong>Recorded ${e(rec.recordedAt.slice(0,10))}</strong> · outcomes read ${e(rec.read.readAt.slice(0,16).replace('T',' '))} UTC · ${rec.snapshot.findings.length} finding(s)
    <details><summary>Statements</summary><ul>${rec.snapshot.findings.map(f=>`<li>${e(f.statement)}</li>`).join('')}</ul></details>
    <details><summary>Share a general pattern with your other brands</summary><form method="post" action="${base(shell)}/${r.id}/pattern">${cmd()}<input type="hidden" name="findingId" value="${e(rec.id)}"><label for="pat-${e(rec.id)}">General pattern (no numbers, names, offers, links or colours)</label><textarea id="pat-${e(rec.id)}" name="statement" minlength="20" maxlength="300" rows="2" required placeholder="e.g. Practical first-step questions drew more qualified enquiries than general invitations."></textarea><button type="submit" class="secondary">Share pattern</button><p class="section-note">Only you see it, in the other brands you manage, labelled as a pattern rather than evidence. You can withdraw it.</p></form></details>
    ${o.guidanceAvailable?`<details><summary>Copy into brand guidance</summary><form method="post" action="${base(shell)}/${r.id}/guidance">${cmd()}<input type="hidden" name="findingId" value="${e(rec.id)}"><label><input type="checkbox" name="acknowledge" value="1" required> I understand this adds an audience note to brand guidance: the brand profile must be refreshed (one profile extraction, counted against this brand’s writing allowance) and confirmed again, and approved artwork will need re-approval.</label><button type="submit" class="secondary">Copy to brand guidance</button></form></details>`:''}</li>`).join('');
  const patterns=(o.patterns??[]).map(p=>`<li>${e(p.statement)} <span class="pill ${p.state==='shared'?'ok':''}">${p.state==='shared'?'Shared':'Withdrawn'}</span> <span class="section-note">${e(p.decidedAt.slice(0,10))}</span>${p.state==='shared'?`<form method="post" action="${base(shell)}/${r.id}/pattern-withdraw" style="display:inline">${cmd()}<input type="hidden" name="patternId" value="${e(p.patternId)}"><button type="submit" class="secondary">Withdraw</button></form>`:''}</li>`).join('');
  return `<section class="card" id="learning"><h2>What we learned</h2><p class="section-note">Prepared from the outcome read above with fixed rules. Comparisons use 95% ranges and are drawn only when each concept has at least 20 tagged leads. No revenue, ROAS, cost per acquisition or winner is calculated.</p>${findings}${tests}
  <h3>Findings journal</h3>${recorded?`<ul>${recorded}</ul>`:'<p class="muted">No findings recorded yet.</p>'}${patterns?`<h3>Patterns shared from this brand</h3><ul>${patterns}</ul>`:''}</section>`;
}
/** Rebuild from known saved fields, not browser-supplied schema or recipient data. */
export function creatorContentFromForm(record:CreatorRecord,fields:URLSearchParams):CampaignContent {
  if(!record.version)throw new Error('No saved draft to edit.');
  const content=structuredClone(record.version.content);
  content.title=fields.get('title')??'';content.summary=fields.get('summary')??'';
  if(record.brief.kind==='acquisition'){
    const p=content as AcquisitionProposal;
    p.insights.forEach((insight,i)=>{insight.statement=fields.get(`insight.${i}.statement`)??'';});
    for(const [i,c] of p.concepts.entries())for(const key of ['hook','headline','primaryText','creativeDirection'] as const)c[key]=fields.get(`concept.${i}.${key}`)??'';
  }else if(record.brief.kind==='email')for(const [i,mail] of (content as EmailCampaign).emails.entries()){
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
  if(record.brief.kind==='acquisition'){
    const p=c as AcquisitionProposal,links=trackedLinks(record.brief,record.id,p);
    return `${record.brief.name}\nApproved campaign PROPOSAL — nothing launched, published, scheduled or spent.\nObjective: ${OBJECTIVE_LABEL[record.brief.objective??'']??''} — ${p.objective.goal}\nDestination: ${record.brief.cta.label} ${record.brief.cta.url}\n\n${p.summary}\n\nINSIGHTS\n${p.insights.map(i=>`- [${i.type}, ${i.basis}] ${i.statement} (evidence: ${i.evidence.join(', ')})`).join('\n')}\n\nCHANNELS\n${p.channels.map(ch=>`- ${ch.channel}: ${ch.role}`).join('\n')}\n`
      +p.concepts.map((k,i)=>`\nCONCEPT ${i+1}: ${k.name}\nHook: ${k.hook}\nHeadline: ${k.headline}\n${k.primaryText}\n${k.cta.label}\nCreative direction: ${k.creativeDirection}\nTracked links:\n${links.filter(l=>l.concept===i).map(l=>`  ${l.channel}: ${l.url}`).join('\n')}\n`).join('')
      +`\nMEASUREMENT\nPrimary: ${p.measurement.primaryMetric}\nReview after ${p.measurement.reviewAfterDays} days. ${p.measurement.learningRule}\nLimitations:\n${p.measurement.limitations.map(l=>'- '+l).join('\n')}\n\nPREDICTIONS (hypotheses, not results)\n${p.hypotheses.map(h=>'- '+h.statement).join('\n')}\n\nACTUAL RESULTS\nNone recorded.\n`;
  }
  const intro=`${record.brief.name}\nApproved authoring draft — not sent or scheduled.\nPermission context: ${record.brief.permissionContext}\n\n${c.summary}\n`;
  if(record.brief.kind==='email')return intro+(c as EmailCampaign).emails.map((m,i)=>`\nEMAIL ${i+1} — proposed day ${m.dayOffset}\nSubject: ${m.subject}\nAlternatives: ${m.subjects.filter(s=>s!==m.subject).join(' / ')}\nPreview: ${m.preview}\n\n${m.body}\n\n${m.cta.label}: ${m.cta.url}\n`).join('');
  const k=c as AdvocacyKit;
  return intro+`\nPermission process: ${record.brief.consentProcess}\nIncentive terms: ${k.incentiveTerms}\n`+k.requests.map((r,i)=>`\nREQUEST ${i+1}: ${r.moment}\n${r.shortRequest}\n\n${r.standardRequest}\n\nFollow-up: ${r.followUp}\nQuestions:\n${r.questions.map(q=>'- '+q).join('\n')}\n`).join('')+(k.referralMessages?`\nREFERRAL INVITATIONS\n${k.referralMessages.short}\n\n${k.referralMessages.standard}\n\n${k.referralMessages.extended}\n`:'')+`\nPERMISSION CHECKLIST\n${k.consentChecklist.map(s=>'- '+s).join('\n')}\n`;
}
export function productionRulesPage(shell:Shell,data:{enabled:boolean;assignment:{revision:number;pins:readonly {packId:string}[];origin?:string}|null},creatorsReady:boolean):string {
  const entries=[['editorial-planning','Editor’s Desk','Blog planning'],['blog-writing','Longform Forge','Blog writing'],['conversion-copy','Hook & Close','Blog calls to action'],['social-repurposing','Multiplier','Instagram and LinkedIn drafts'],['visual-briefing','Art Director','Image descriptions and instructions'],['email-writing','Inbox Engine','Email campaign drafts'],['advocacy-and-referral','Word of Mouth Engine','Feedback and referral request kits']];
  const action=`${SEO_BLOG_BASE}/b/${shell.brand!.id}/methods`,hidden=`${csrfField(shell.csrf)}<input type="hidden" name="revision" value="${data.assignment?.revision??0}">`;
  return layout(shell,'Production rules',`<h1>Production rules</h1><section class="card"><h2>Your production packs</h2><p>All eight reviewed packs start automatically for enrolled owned brands. Your choices below are saved for this brand and survive restarts. Each brand keeps its own facts, audience, voice and links.</p><p><strong>${data.assignment?.pins.length?`${data.assignment.pins.length} packs on`:'All production packs off'}</strong>${data.assignment?.origin==='private-default'?' · Automatically activated':''}</p>${data.enabled?`
  <form method="post" action="${action}/update">${hidden}<p><strong>Engine Room</strong> · Shared fact, voice and review rules. Included whenever any pack is enabled.</p>${entries.filter(([id])=>creatorsReady||!['email-writing','advocacy-and-referral'].includes(id!)).map(([id,name,scope])=>`<label style="display:block;margin:16px 0"><input type="checkbox" name="packId" value="${id}"${data.assignment?.pins.some(p=>p.packId===id)?' checked':''}> <strong>${name}</strong> · ${scope}</label>`).join('')}<p class="section-note">These switches affect production methods. Sending, publishing, image generation and spending still use their existing controls. Saved drafts and history are retained.</p><button type="submit">Save pack choices</button></form>
  <div class="row"><form method="post" action="${action}/activate">${hidden}${creatorsReady?'<input type="hidden" name="creators" value="1">':''}<button class="secondary" type="submit">Turn all available packs on</button></form><form method="post" action="${action}/disable">${hidden}<button class="secondary" type="submit">Turn all production packs off</button></form></div>`:'<p>The reviewed production release has not been enabled yet.</p>'}</section>`);
}
