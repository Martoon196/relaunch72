import { escapeHtml as e } from '../portal/ui.js';
import type { Lead360View } from '../portal/lead-360-view.js';

const state = (value: string): string => value.replaceAll('_', ' ');
const shown = (value: string | null): string => value?.trim() ? e(value) : 'Not recorded';
const due = (value: string | null): string => {
  if (!value || !Number.isFinite(Date.parse(value))) return 'No date set';
  return e(new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' }).format(new Date(value)));
};

/** MHP's working contact view; the Property Predator evidence case file stays separate. */
export function renderMhpContactBody(view: Lead360View, marketingWorkspace = false): string {
  const contactId = encodeURIComponent(view.identity.contactId);
  const opportunities = view.crm.opportunities.length
    ? `<ul class="mhp-contact-list">${view.crm.opportunities.map(item => `<li><div><strong>${e(item.title)}</strong><span>${e(item.stageLabel)} · ${e(state(item.state))}${item.valueLabel ? ` · ${e(item.valueLabel)}` : ''}</span></div></li>`).join('')}</ul>`
    : `<p>No opportunity has been recorded for this ${marketingWorkspace ? 'contact' : 'investor'}.</p>`;
  const tasks = view.crm.tasks.length
    ? `<ul class="mhp-contact-list">${view.crm.tasks.map(item => `<li><div><strong>${e(item.title)}</strong><span>${e(state(item.state))} · ${due(item.dueAt)}</span></div></li>`).join('')}</ul>`
    : '<p>No follow-up has been recorded yet.</p>';
  return `<style>
    .mhp-contact{color:#142019;background:#fff;border:1px solid #dedfd5;border-radius:18px;padding:clamp(24px,4vw,44px);font:400 17px/1.6 system-ui,sans-serif;box-shadow:0 10px 28px rgba(20,32,25,.07)}
    .mhp-contact *{box-sizing:border-box}.mhp-contact h1,.mhp-contact h2,.mhp-contact p{margin-top:0}.mhp-contact h1{font-size:clamp(32px,4vw,46px);line-height:1.12;letter-spacing:-.03em;margin:10px 0 14px}.mhp-contact h2{font-size:24px;line-height:1.25;margin-bottom:14px}.mhp-contact p,.mhp-contact li,.mhp-contact a{font-size:17px}.mhp-contact .kicker{color:#83510c;font-size:14px;font-weight:800;letter-spacing:.09em;text-transform:uppercase}.mhp-contact .intro{color:#526154;max-width:68ch}.mhp-contact .actions{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0 30px}.mhp-contact .actions a,.mhp-contact .section-link{display:inline-flex;align-items:center;min-height:44px;padding:10px 16px;border-radius:9px;border:1px solid #bac5b8;background:#f8f6ef;color:#142019;font-weight:700;text-decoration:none}.mhp-contact .actions a.primary{background:#E8A33D;border-color:#E8A33D}.mhp-contact .actions a:hover,.mhp-contact .section-link:hover{background:#fff2dc}.mhp-contact .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.mhp-contact section{min-width:0;border:1px solid #dedfd5;border-radius:14px;padding:24px;background:#fff}.mhp-contact section p,.mhp-contact .detail{color:#526154}.mhp-contact .detail{overflow-wrap:anywhere}.mhp-contact-list{list-style:none;margin:0 0 20px;padding:0;display:grid;gap:10px}.mhp-contact-list li{padding:14px;border-radius:9px;background:#f8f6ef}.mhp-contact-list strong,.mhp-contact-list span{display:block}.mhp-contact-list span{color:#526154;margin-top:3px}.mhp-contact .section-link{margin-top:4px}.mhp-contact a:focus-visible{outline:3px solid #83510c;outline-offset:2px}@media(max-width:760px){.mhp-contact .grid{grid-template-columns:1fr}.mhp-contact section{padding:20px}}
  </style><article class="mhp-contact" aria-labelledby="mhp-contact-title">
    <span class="kicker">${marketingWorkspace ? 'MHP marketing · Contact record' : 'Your Desk · Investor record'}</span><h1 id="mhp-contact-title">${e(view.identity.displayName)}</h1>
    <p class="detail">${shown(view.identity.companyName)} · ${shown(view.identity.primaryEmail)}${view.identity.primaryPhone ? ` · ${e(view.identity.primaryPhone)}` : ''}</p>
    <p class="intro">${marketingWorkspace ? 'Your enquiry and follow-up are saved below. Use Pipeline to manage the next step.' : 'Your opportunity and follow-up are saved below. Use Pipeline to manage the opportunity, or Conversations to prepare a message.'}</p>
    <nav class="actions" aria-label="${marketingWorkspace ? 'Contact actions' : 'Investor actions'}"><a href="/portal/crm/contacts">← All ${marketingWorkspace ? 'enquiries' : 'investors'}</a><a class="primary" href="/portal/crm/opportunities">Open pipeline</a><a href="/portal/crm/tasks">Follow-ups</a>${marketingWorkspace ? '' : '<a href="/portal/investors/email">Conversations</a>'}</nav>
    <div class="grid"><section aria-labelledby="mhp-contact-opportunities"><h2 id="mhp-contact-opportunities">Opportunities</h2>${opportunities}<a class="section-link" href="/portal/crm/opportunities">View and move opportunities →</a></section>
    <section aria-labelledby="mhp-contact-tasks"><h2 id="mhp-contact-tasks">Follow-ups</h2>${tasks}<a class="section-link" href="/portal/crm/tasks">Open follow-ups →</a></section></div>
    ${marketingWorkspace ? '' : `<p style="margin:24px 0 0"><a href="/portal/investors?contact=${contactId}">Record this investor’s requirements →</a></p>`}
  </article>`;
}
