import { appShell, escapeHtml as e } from './ui.js';
import type { PlatformCapability } from '../platform/capabilities.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE, RELAUNCH72_PRODUCT_PROFILE, type PortalProductProfile } from './product-profile.js';
import type { CrmWorkspaceSnapshot } from './crm-views.js';
import { INVESTOR_DASHBOARD_STYLE, investorDashboard } from './investor-dashboard.js';
import type { InvestorSiteSettings } from './investor-site.js';
import type { InvestorMailView } from './investor-mail-service.js';
import { investorMailSettings } from './investor-mail-view.js';
import { INVESTOR_ROUTE as route, INVESTOR_TEMPLATES, investorCommandKey, renderInvestorTemplate, type InvestorProgramme, type InvestorBusiness, type InvestorRequirements } from './investor-service.js';

const hidden = (name:string,value:unknown) => `<input type="hidden" name="${name}" value="${e(value)}">`;
const field = (label:string,name:string,value='',type='text',maximum=200) => `<label class="iv-field">${e(label)}<input name="${name}" type="${type}" value="${e(value)}" maxlength="${maximum}"${type==='email'?' autocomplete="email"':''}></label>`;
const area = (label:string,name:string,value='',maximum=1000) => `<label class="iv-field">${e(label)}<textarea name="${name}" rows="4" maxlength="${maximum}">${e(value)}</textarea></label>`;
const form = (action:string,csrf:string,body:string) => `<form method="post" action="${route}/${action}">${hidden('_csrf',csrf)}${body}</form>`;
const states: Record<string,string> = {test:'Your test business',pending_payment:'Awaiting payment confirmation',active:'Access active',suspended:'Access suspended'};
const css = `<style>.iv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:18px}.iv-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;margin:16px 0;min-width:0}.iv-card h2,.iv-card h3{margin:0 0 12px}.iv-card p{overflow-wrap:anywhere}.iv-field{display:grid;gap:6px;margin:12px 0;font-weight:600}.iv-field input,.iv-field textarea,.iv-field select{font:inherit;font-weight:400;padding:10px;border:1px solid var(--line-strong);border-radius:8px;background:var(--panel);color:var(--ink);width:100%;min-height:44px}.iv-field textarea{resize:vertical}.iv-actions{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.iv-tag{display:inline-block;padding:5px 10px;border-radius:20px;background:var(--panel-subtle);font-size:.85rem}.iv-card summary{cursor:pointer;min-height:44px;font-weight:600}.iv-template{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.iv-check{display:flex;align-items:flex-start;gap:10px;margin:12px 0}.iv-check input{margin-top:5px}.iv-heading{border-left:5px solid var(--accent);padding-left:16px}.iv-links{display:flex;gap:14px;flex-wrap:wrap;margin:16px 0}@media(max-width:480px){.iv-card{padding:16px}}</style>`;

export function investorProfile(business: InvestorBusiness): PortalProductProfile {
  if (business.productProfileId === 'martin_howard_property') {
    const features = business.features;
    return {...MARTIN_HOWARD_PROPERTY_PROFILE,productName:business.brandName,
      compactMark:Array.from(business.brandName)[0] ?? 'MH',
      visibleNavigation:['investors','crm',...(features?.emailWorkflow ? ['inbox' as const] : []),...(features?.leadrelay ? ['leadrelay' as const] : [])],
      theme:{...MARTIN_HOWARD_PROPERTY_PROFILE.theme,accent:business.accentColor}};
  }
  return {...RELAUNCH72_PRODUCT_PROFILE,investorWorkspace:true,productName:business.brandName,compactMark:Array.from(business.brandName)[0] ?? 'I',suiteLabel:'Investor Desk',
    visibleNavigation:['investors','crm','inbox','leadrelay'],moduleLabels:{investors:'Today',crm:'Investors',inbox:'Conversations',leadrelay:'Your AI team'},
    theme:{...RELAUNCH72_PRODUCT_PROFILE.theme,accent:business.accentColor,accentDeep:business.accentColor,accentSoft:'#edf2fa'}};
}
function branding(b:InvestorBusiness,csrf:string): string {
  return `<details><summary>Branding and email identity</summary>${form('branding',csrf,
    hidden('workspaceId',b.workspaceId)+hidden('version',b.version)+field('Business name','brandName',b.brandName,'text',100)+field('Brand colour','accentColor',b.accentColor,'color')+
    field('Business sending email','senderEmail',b.senderEmail,'email',320)+area('Email signature','signature',b.signature)+
    '<p class="muted">Saving an address does not connect or verify its domain. Email sending stays unavailable until that business’s sender connection is verified.</p><button class="button" type="submit">Save branding</button>')}
    </details>`;
}
export function investorPage(input: {programme: InvestorProgramme; csrf:string; email:string; crm?: CrmWorkspaceSnapshot|null; requirements?:InvestorRequirements; message?:string; error?:boolean; setupPath?:string|null; view?:string; site?:InvestorSiteSettings|null; mail?:InvestorMailView; productProfile?:PortalProductProfile}): string {
  const {programme:p,csrf} = input;
  const current = p.businesses.find(b=>b.workspaceId===p.selectedWorkspaceId);
  const selected = p.workspaces.find(w=>w.id===p.selectedWorkspaceId);
  const profile = current ? investorProfile(current) : input.productProfile ?? RELAUNCH72_PRODUCT_PROFILE;
  const mhp = profile.id === 'martin_howard_property';
  const deskLabel = mhp ? 'Your Desk' : 'Investor Desk';
  const suiteName = mhp ? 'Martin Howard Property' : 'Growth HQ';
  const canWrite = ['owner','admin','marketer','sales'].includes(selected?.role ?? '') && current?.features?.readOnly !== true;
  const hasEmail = !mhp || current?.features?.emailWorkflow === true;
  const hasLeadRelay = !mhp || current?.features?.leadrelay === true;
  const view=['playbook','settings','programme'].includes(input.view??'')?input.view:'today';
  let body = css+INVESTOR_DASHBOARD_STYLE+`<header class="iv-heading"><p class="eyebrow">${suiteName} · ${p.isAdmin?'Programme administration':'Investor relationships'}</p><h1>${current?e(current.brandName):'Your investor command centre.'}</h1><p>${current?'Good relationships. Clear conversations. Confident next steps.':'Give every mentee a business of their own, with the guidance and oversight to move forward.'}</p>${mhp?'<a href="/app/desk">Your deal files and calculators →</a> · <a href="/app/account">Your account and membership →</a>':''}</header>`;
  if (current?.features?.readOnly) body += '<section class="iv-card" role="status"><h2>Your Desk is read-only</h2><p>You can review your saved records. Your current membership does not allow changes, sending or automation.</p><a href="/app/account">Manage your account</a></section>';
  if(input.message) body+=`<div class="iv-card" role="${input.error?'alert':'status'}">${e(input.message)}</div>`;
  if(input.setupPath) body+=`<section class="iv-card"><h2>Account setup link</h2><p>Access is active. Share this private, single-use link with the named mentee. It expires in 24 hours. No invitation email has been sent.</p><label class="iv-field">Private setup link<input readonly value="${e(input.setupPath)}"></label></section>`;
  body+=`<details class="iv-switch" id="iv-workspace-switch"><summary><span class="iv-tag">${e(current?.brandName??selected?.name??'Growth HQ')}</span> Switch business</summary>${form('switch',csrf,`<label class="iv-field">Open a workspace<select name="workspaceId">${p.workspaces.map(w=>`<option value="${e(w.id)}"${w.id===p.selectedWorkspaceId?' selected':''}>${e(w.name)}</option>`).join('')}</select></label><button class="button secondary" type="submit">Open workspace</button>`)}</details>`;
  body+=`<nav class="iv-links" aria-label="${deskLabel}"><a href="${route}"${view==='today'?' aria-current="page"':''}>Today</a><a href="/portal/crm/contacts">Investors</a><a href="/portal/crm/opportunities">Pipeline</a><a href="/portal/crm/tasks">Follow-ups</a>${hasEmail?`<a href="${route}/email">Conversations</a>`:''}<a href="${route}?view=playbook"${view==='playbook'?' aria-current="page"':''}>Playbook</a><a href="${route}?view=settings"${view==='settings'?' aria-current="page"':''}>Business setup</a>${p.isAdmin?`<a href="${route}?view=programme"${view==='programme'?' aria-current="page"':''}>Mentee programme</a>`:''}</nav>`;
  if (!input.requirements && view==='today') body+=investorDashboard(p,current,input.crm);
  if(input.requirements) {
    const r=input.requirements;
    body+=`<section class="iv-card"><h2>${e(r.contactName)} · Requirements</h2><a href="/portal/crm/contacts/${e(r.contactId)}">Open full investor record</a>`;
    if(canWrite) body+=form('requirements',csrf,hidden('contactId',r.contactId)+hidden('version',r.version)+
      area('Available capital — as stated by the investor','capital',r.capital,500)+area('Preferred locations','locations',r.locations)+
      area('Investment interests','interests',r.interests)+area('Timing','timeframe',r.timeframe,500)+area('Internal notes and guidance','notes',r.notes,4000)+
      '<button class="button" type="submit">Save requirements</button>');
    else body+=`<dl>${[['Capital',r.capital],['Locations',r.locations],['Interests',r.interests],['Timing',r.timeframe],['Notes',r.notes]].map(([k,v])=>`<dt>${e(k)}</dt><dd>${e(v||'Not recorded')}</dd>`).join('')}</dl>`;
    body+='</section>';
  }
  if(current) {
    if(view==='settings') body+=`<section class="iv-card"><span class="iv-tag">${e(states[current.accessState])}</span><h2>Make it yours</h2><p>${e(current.ownerName)} · ${e(current.ownerEmail)}</p>${canWrite?branding(current,csrf):''}</section>`;
    if(input.crm && view==='today' && !input.requirements) body+=`<section class="iv-card"><h2>Investor requirements</h2><a class="button" href="/portal/crm/contacts">Add or manage investors</a>${input.crm.contacts.length?`<ul>${input.crm.contacts.map(c=>`<li><a href="${route}?contact=${e(c.id)}">${e(c.displayName)}</a> · <a href="/portal/crm/contacts/${e(c.id)}">Full record</a></li>`).join('')}</ul>`:'<p>Your investor list is empty. Start by adding a test contact you control.</p>'}</section>`;
    if(view==='playbook'||input.requirements) body+=`<section class="iv-card" id="iv-playbook"><p class="eyebrow">WORDS THAT START CONVERSATIONS</p><h2>Your investor playbook</h2><p>Choose a starting point, personalise it and review it before contacting the investor.</p><div class="iv-template-grid">${INVESTOR_TEMPLATES.map(t=>{
      const rendered=renderInvestorTemplate(t.id,current,input.requirements?.contactName ?? '');
      return `<details class="iv-template-card"><summary>${e(t.title)}</summary><p>${e(t.guidance)}</p><p><strong>Subject:</strong> ${e(t.subject)}</p><label class="iv-field">Personalise your ${t.id==='call'?'call notes':'message'}<textarea id="template-${t.id}" rows="10">${e(rendered.body)}</textarea></label><button class="button secondary" type="button" data-copy-template="template-${t.id}">Copy ${t.id==='call'?'call guide':'message'}</button><p class="muted" role="status" data-copy-status></p></details>`;
    }).join('')}</div><p class="muted">Edits here are for copying and are not saved or sent.</p></section><script src="${route}/client.js" defer></script>`;
    if(view==='settings') {
      if(hasEmail) body+=investorMailSettings(input.mail,csrf,current.brandName,current.senderEmail,canWrite&&(!mhp||current.features?.emailWritable===true)&&(p.isAdmin||selected?.role==='owner'||selected?.role==='admin'));
      else if(mhp) body+='<section class="iv-card"><h2>Conversations and your AI team</h2><p>Email workflow and LeadRelay are included with mentoring and partnership access.</p><a href="/app/account">View your membership</a></section>';
      const s=input.site;
      body+=`<section class="iv-card"><p class="eyebrow">YOUR BRAND. YOUR FRONT DOOR.</p><h2>Your investor website</h2><span class="iv-tag">${s?.published?'Published':'Private draft'}</span>${s?`<div class="iv-actions"><a class="button secondary" href="${route}/site-preview" target="_blank" rel="noopener">Preview website</a>${s.published?`<a href="/investor-sites/${e(s.slug)}" target="_blank" rel="noopener">Open published site</a>`:''}</div>`:''}${canWrite?form('site',csrf,hidden('version',s?.row_version??0)+field('Site address','slug',s?.slug??'','text',60)+field('Headline','headline',s?.headline??'Let’s talk about your next property investment.','text',140)+area('Introduction','introduction',s?.introduction??'Tell us what you are looking for, your preferred locations and your timing. We start with your goals, then agree a clear next step together.',1500)+field('Locations you cover','locations',s?.locations??'','text',300)+field('Public contact email','contactEmail',(s?.contact_email??current.senderEmail)||current.ownerEmail,'email',254)+field('Your privacy notice URL','privacyUrl',s?.privacy_url??'','url',2000)+field('Your own domain (optional)','domain',s?.requested_domain??'','text',253)+'<p class="muted">Your domain needs DNS and hosting verification before it can go live. Saving it here does not connect it. The website address above works on this installation once published.</p>'+`<label class="iv-check"><input type="checkbox" name="publish" value="yes"${s?.published?' checked':''}>I have reviewed this website and want it published. Leave unchecked to keep it private.</label><button class="button" type="submit">Save website</button>`):'<p>Your workspace administrator manages this website.</p>'}</section>`;
      if(hasLeadRelay&&!current.features?.readOnly) body+=`<section class="iv-card"><h2>Your AI team</h2><p>Open LeadRelay to configure the chatbot and call agent connected to this business.</p><a class="button secondary" href="/portal/leadrelay">Open LeadRelay</a><p>Attach a Property Predator appraisal link to an opportunity to keep it with the investor record.</p></section>`;
    }
  }
  if(p.isAdmin && (!current || view==='programme')) {
    body+=`<section class="iv-card" id="iv-add-business"><h2>Add a business</h2>${form('create',csrf,hidden('commandKey',investorCommandKey())+
      '<label class="iv-field">Type<select name="kind"><option value="test">My test business</option><option value="mentee">Mentee — awaiting payment</option></select></label>'+
      field('Business name','brandName')+field('Owner name','ownerName')+field('Login email','ownerEmail',input.email,'email',320)+
      '<p class="muted">A test business belongs to your current login. A mentee receives no access until you confirm payment. This does not collect a payment.</p><button class="button" type="submit">Create business</button>')}</section>`;
    body+=`<section><h2>Your businesses</h2><div class="iv-grid">${p.businesses.map(b=>`<article class="iv-card"><h3>${e(b.brandName)}</h3><span class="iv-tag">${e(states[b.accessState])}</span><p>${e(b.ownerName)}<br>${e(b.ownerEmail)}</p>${form('switch',csrf,hidden('workspaceId',b.workspaceId)+'<button class="button secondary" type="submit">Open business</button>')}${branding(b,csrf)}${b.accessState==='test'?'':`<details><summary>Manage paid access</summary>${form('access',csrf,hidden('workspaceId',b.workspaceId)+hidden('version',b.version)+
      '<label class="iv-field">Access<select name="state"><option value="active">Activate / restore access</option><option value="suspended">Suspend access</option></select></label>'+
      (mhp?'<label class="iv-field">Membership access<select name="entitlementTier"><option value="course">Course · CRM and enquiry site</option><option value="mentoring">Mentoring · includes email and AI team</option><option value="partnership">Partnership · includes email and AI team</option></select></label>':'')+
      field('Payment reference','paymentReference',b.paymentReference ?? '')+'<label class="iv-check"><input type="checkbox" name="paymentConfirmed" value="yes">I have checked the payment and authorise access.</label><button class="button" type="submit">Update access</button>')}</details>`}</article>`).join('')}</div></section>`;
  }
  return appShell({title:current?`${current.brandName} · ${deskLabel}`:`${deskLabel} · ${suiteName}`,tenantName:current?.brandName ?? selected?.name ?? suiteName,active:'investors',body,
    productProfile:profile,mode:'crm',crmAvailable:true,capabilities:new Set<PlatformCapability>(hasEmail?['workspace.overview.read','conversations.read']:['workspace.overview.read']),csrfToken:csrf});
}
