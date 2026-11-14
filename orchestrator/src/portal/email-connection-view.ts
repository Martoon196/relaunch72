/**
 * The owner's "Connect email" screens. Plain English only: no setting names, no provider error text, no ids. Every
 * value from the database or the owner is escaped. Copy buttons are progressive enhancement: the records are
 * selectable text without JavaScript, and the one same-origin script (allowed by the page's CSP) only reveals the
 * buttons and copies.
 */
import { escapeHtml as e } from './ui.js';
import { shortHost, type DnsHost } from '../email-connections/domains.js';
import { EMAIL_CONNECTION_MESSAGES, type EmailConnectionView } from '../email-connections/service.js';
import { EMAIL_TERMS, EMAIL_TERMS_AGREEMENT } from '../email-connections/terms.js';
import type { EmailConnectionState } from '../email-connections/store.js';

export const EMAIL_CONNECTION_ROUTE = '/portal/email';

export const EMAIL_CONNECTION_COPY_SCRIPT = `(function(){var buttons=document.querySelectorAll('button[data-copy]');for(var i=0;i<buttons.length;i++){(function(b){b.hidden=false;b.addEventListener('click',function(){if(!navigator.clipboard)return;navigator.clipboard.writeText(b.getAttribute('data-copy')||'').then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy';},2000);});});})(buttons[i]);}})();`;

export interface EmailConnectionPageInput {
  readonly view: EmailConnectionView;
  readonly csrf: string;
  readonly commandId: string;
  readonly message?: { readonly text: string; readonly ok: boolean };
  /** What the owner typed, shown again after a refusal. */
  readonly form?: { readonly fromName: string; readonly fromAddress: string; readonly replyTo: string };
  /** Only for the platform founder, after a clash with a domain already in the shared account. */
  readonly offerTakeOver?: boolean;
}

const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${e(value)}">`;
const day = (value: string) => new Date(value).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' });

const HELP: Readonly<Record<DnsHost, { readonly name: string; readonly steps: readonly string[] }>> = {
  cloudflare: { name: 'Cloudflare', steps: ['Log in to Cloudflare, open your domain, then go to DNS and Records.',
    'Press “Add record”, choose the type (TXT or CNAME), and paste the Name and the Value from this page.',
    'For the CNAME record, set Proxy status to “DNS only” (grey cloud), then press Save.'] },
  godaddy: { name: 'GoDaddy', steps: ['Sign in to GoDaddy, open My Products and choose DNS next to your domain.',
    'Press “Add New Record”, choose the type, and paste the short Name and the Value from this page.', 'Press Save, then add the second record the same way.'] },
  namecheap: { name: 'Namecheap', steps: ['Sign in to Namecheap, open Domain List and press Manage next to your domain, then Advanced DNS.',
    'Press “Add New Record”, choose TXT Record or CNAME Record, and paste the short Host and the Value from this page.', 'Press the tick to save, then add the second record.'] },
  '123-reg': { name: '123-reg', steps: ['Sign in to 123-reg, choose your domain, then Manage DNS (Advanced DNS).',
    'Add a new record: choose the type, and paste the short Name and the Value from this page.', 'Save, then add the second record the same way.'] },
  ionos: { name: 'IONOS', steps: ['Sign in to IONOS, open Domains & SSL, choose your domain, then DNS.',
    'Press “Add record”, choose the type, and paste the short Host name and the Value from this page.', 'Save, then add the second record the same way.'] },
  other: { name: '', steps: ['Sign in where your domain’s DNS is managed (often where you bought the domain).',
    'Find the DNS settings and add a new record for each card on this page, with the Name and the Value shown.', 'Save both, then come back here and press Check.'] },
};

function businessNav(state: { readonly name: string; readonly workspaceId: string }): string {
  return `<nav class="business" aria-label="Business"><span>Business</span> <a href="${EMAIL_CONNECTION_ROUTE}?business=${e(state.workspaceId)}" aria-current="page">${e(state.name)}</a></nav>`;
}

function termsBlock(): string {
  return `<h3>Our email rules</h3><p>Every business sends through one shared email account, so these rules protect everyone:</p>
    <ul>${EMAIL_TERMS.map(rule => `<li>${e(rule)}</li>`).join('')}</ul>
    <label class="check" for="email-agree"><input id="email-agree" type="checkbox" name="agree" value="yes" required> ${e(EMAIL_TERMS_AGREEMENT)}</label>`;
}

function connectForm(page: EmailConnectionPageInput, state: EmailConnectionState, button = 'Connect'): string {
  const form = page.form ?? { fromName: state.fromName ?? '', fromAddress: state.fromAddress ?? '', replyTo: state.replyTo ?? '' };
  return `<form method="post" action="${EMAIL_CONNECTION_ROUTE}/connect">${hidden('csrf', page.csrf)}${hidden('commandId', page.commandId)}
    <label for="email-from-name">Sender name<input id="email-from-name" name="fromName" maxlength="100" required value="${e(form.fromName)}" autocomplete="organization"></label>
    <label for="email-from">Send from (an address on your own domain)<input id="email-from" name="fromAddress" type="email" maxlength="254" required value="${e(form.fromAddress)}" placeholder="hello@yourbusiness.co.uk"></label>
    <label for="email-reply">Replies go to<input id="email-reply" name="replyTo" type="email" maxlength="254" value="${e(form.replyTo)}"></label>
    ${termsBlock()}<button type="submit">${e(button)}</button></form>`;
}

function recordCard(kind: 'TXT' | 'CNAME', host: string, value: string, domain: string, verified: boolean): string {
  const short = shortHost(host, domain);
  const line = (label: string, text: string, hint = '') => `<div class="field"><span class="label">${label}</span><code>${e(text)}</code><button type="button" class="secondary copy" data-copy="${e(text)}" hidden>Copy</button>${hint ? `<span class="note">${hint}</span>` : ''}</div>`;
  return `<article class="record"><h3>${kind} record${verified ? ' <span class="tick" aria-label="found">✓ found</span>' : ''}</h3>
    ${line('Type', kind)}${line('Name', short, 'Most hosts want this short name')}${line('Full name', host, 'Some hosts want the full name')}${line('Value', value)}</article>`;
}

function mailto(state: EmailConnectionState): string {
  const dns = state.dns!, domain = state.domain ?? '';
  const body = [`Hello,`, ``, `Please add these 2 DNS records for ${domain}, so our emails can be sent from ${state.fromAddress ?? domain}:`, ``,
    `1. TXT record`, `   Name: ${shortHost(dns.dkim.host, domain)}  (full: ${dns.dkim.host})`, `   Value: ${dns.dkim.value}`, ``,
    `2. CNAME record`, `   Name: ${shortHost(dns.returnPath.host, domain)}  (full: ${dns.returnPath.host})`, `   Value: ${dns.returnPath.value}`,
    `   If the DNS is on Cloudflare, set this one to DNS only (grey cloud).`, ``, `Thank you!`].join('\n');
  return `mailto:?subject=${encodeURIComponent(`DNS records for ${domain}`)}&body=${encodeURIComponent(body)}`;
}

function recordsSection(page: EmailConnectionPageInput, state: EmailConnectionState, host: DnsHost | null): string {
  const dns = state.dns, domain = state.domain ?? '';
  if (!dns) return `<section class="card"><p>${e(EMAIL_CONNECTION_MESSAGES.unfinished)}</p>${continueForm(page)}</section>`;
  const help = HELP[host ?? 'other'];
  return `<section class="card"><h2>Add these 2 records where your domain is managed</h2>
    <p>Your domain is <strong>${e(domain)}</strong>. Add both records, then press Check.</p>
    ${recordCard('TXT', dns.dkim.host, dns.dkim.value, domain, dns.dkim.verified)}${recordCard('CNAME', dns.returnPath.host, dns.returnPath.value, domain, dns.returnPath.verified)}
    <details${host && host !== 'other' ? ' open' : ''}><summary>Where do I add these?</summary>
      <p>${help.name ? `Your domain’s DNS looks like it is with <strong>${e(help.name)}</strong>.` : 'Here is how it usually goes.'}</p>
      <ol>${help.steps.map(step => `<li>${e(step)}</li>`).join('')}</ol></details>
    <p><a class="button secondary" href="${e(mailto(state))}">Email these to whoever looks after my website</a></p>
    <form method="post" action="${EMAIL_CONNECTION_ROUTE}/check">${hidden('csrf', page.csrf)}${hidden('commandId', page.commandId)}<button type="submit">Check</button></form>
    <details><summary>Start again</summary><p>Starting again means you will be given new records to add. The old ones can be removed.</p>${disconnectForm(page, 'Start again')}</details></section>`;
}

function repairCard(page: EmailConnectionPageInput): string {
  return `<section class="card notice"><h2>Your email connection needs a repair</h2><p>Press Repair and we will set the connection up again with the same details. Your records stay the same.</p>
    <form method="post" action="${EMAIL_CONNECTION_ROUTE}/continue">${hidden('csrf', page.csrf)}${hidden('commandId', page.commandId)}<button type="submit">Repair</button></form></section>`;
}
function takeOverForm(page: EmailConnectionPageInput): string {
  return `<form method="post" action="${EMAIL_CONNECTION_ROUTE}/use-domain">${hidden('csrf', page.csrf)}${hidden('commandId', page.commandId)}<button type="submit">Use this domain</button></form>`;
}
function continueForm(page: EmailConnectionPageInput): string {
  return `<form method="post" action="${EMAIL_CONNECTION_ROUTE}/continue">${hidden('csrf', page.csrf)}${hidden('commandId', page.commandId)}<button type="submit">Continue</button></form>`;
}
function disconnectForm(page: EmailConnectionPageInput, label = 'Disconnect'): string {
  return `<form method="post" action="${EMAIL_CONNECTION_ROUTE}/disconnect">${hidden('csrf', page.csrf)}${hidden('commandId', page.commandId)}<button type="submit" class="secondary">${e(label)}</button></form>`;
}

function connectedCard(page: EmailConnectionPageInput, state: EmailConnectionState): string {
  const terms = state.terms;
  return `<section class="card"><h2>Email is connected</h2>
    <dl><dt>Domain</dt><dd>${e(state.domain ?? '')}</dd><dt>Sends from</dt><dd>${e(state.fromName ?? '')} &lt;${e(state.fromAddress ?? '')}&gt;</dd>
    ${state.replyTo ? `<dt>Replies go to</dt><dd>${e(state.replyTo)}</dd>` : ''}</dl>
    <ul class="ticks"><li>✓ TXT record found</li><li>✓ CNAME record found</li></ul>
    <p class="notice"><strong>${e(EMAIL_CONNECTION_MESSAGES.connectedNext)}</strong></p>
    <form method="post" action="${EMAIL_CONNECTION_ROUTE}/check">${hidden('csrf', page.csrf)}${hidden('commandId', page.commandId)}<button type="submit" class="secondary">Check again</button></form>
    <details><summary>Disconnect</summary><p>Email stops being connected for this business. Your sending domain is kept if it is already proven, and you can connect again later.</p>${disconnectForm(page)}</details>
    ${terms ? `<p class="small">Agreed by ${e(terms.acceptedByName ?? 'the business owner')} on ${e(day(terms.acceptedAt))}.</p>` : ''}</section>`;
}

function body(page: EmailConnectionPageInput): string {
  const view = page.view;
  if (!view.offered) return `<section class="card"><h1>Connect email</h1><p>${e(view.message)}</p></section>`;
  const { state } = view;
  const intro = `<section class="card"><div class="eyebrow">Email</div><h1>Connect email</h1>${businessNav(view.business)}
    <p>Send emails from your own address. We set everything up with the email service for you; you only add two records to your domain.</p></section>`;
  switch (state.status) {
    case 'not_connected': case 'disconnected':
      return `${intro}<section class="card"><h2>Your sending address</h2>${connectForm(page, state)}</section>`;
    case 'creating': case 'needs_attention':
      return `${intro}<section class="card"><h2>Setting up</h2><p>Setting up didn’t finish.</p>${continueForm(page)}
        ${page.offerTakeOver ? takeOverForm(page) : ''}
        <details><summary>Use different details</summary>${connectForm(page, state, 'Connect with these details')}</details>
        <details><summary>Start again</summary><p>This removes what was set up so far for this business. Nothing is sent and nothing else changes.</p>${disconnectForm(page, 'Start again')}</details></section>`;
    case 'dns_pending':
      return `${intro}${view.repair ? repairCard(page) : ''}${recordsSection(page, state, view.dnsHost)}`;
    case 'verified':
      return `${intro}${view.repair ? repairCard(page) : ''}${connectedCard(page, state)}`;
  }
}

export function renderEmailConnectionPage(page: EmailConnectionPageInput): string {
  const message = page.message ? `<section class="card ${page.message.ok ? 'ok' : 'notice'}" role="${page.message.ok ? 'status' : 'alert'}"><p>${e(page.message.text)}</p></section>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect email</title><style>
    body{margin:0;background:#f4f3ef;color:#172b30;font:17px/1.65 system-ui,sans-serif}header,main{max-width:860px;margin:auto;padding:24px}header{display:flex;gap:14px;flex-wrap:wrap;justify-content:space-between}a{color:#164756}h1{font:clamp(32px,5vw,46px)/1.15 Georgia,serif;margin:.2em 0}h2{font-size:26px}h3{font-size:20px}.card{background:#fff;border:1px solid #d2dbdb;border-radius:18px;padding:clamp(20px,4vw,34px);margin:0 0 22px}.eyebrow{font-weight:800;font-size:14px;letter-spacing:.08em;text-transform:uppercase}.notice{border-left:4px solid #bd8a31;background:#faf3e5}.ok{border-left:4px solid #2f7d55;background:#eef7f1}.note,.small{color:#465b60;font-size:15px}label{display:block;font-weight:700;margin:18px 0}input:not([type=hidden]):not([type=checkbox]){display:block;box-sizing:border-box;width:100%;padding:13px;margin-top:7px;border:1px solid #9daeb0;border-radius:8px;font:17px/1.5 system-ui}.check{display:flex;gap:12px;align-items:flex-start}.check input{margin-top:6px;width:20px;height:20px}button,.button{display:inline-block;padding:14px 20px;border:0;border-radius:9px;background:#f2b440;color:#172b30;font:700 17px/1.4 system-ui;cursor:pointer;text-decoration:none}.secondary{background:#eaf0ef;border:1px solid #adbdbe}.record{border:1px solid #bdcbca;border-radius:12px;padding:16px 20px;margin:16px 0;background:#fafcfa}.field{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}.label{min-width:9em;font-weight:700}code{user-select:all;overflow-wrap:anywhere;background:#eef2f1;padding:4px 8px;border-radius:6px;font-size:15px}.copy{padding:6px 12px;font-size:14px}.tick{color:#2f7d55;font-size:16px}.business span{font-weight:700}.ticks{list-style:none;padding:0}dt{font-weight:700}dd{margin:0 0 10px}details{margin:18px 0}summary{cursor:pointer;font-weight:700}a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #83510c;outline-offset:3px}
    </style><script src="${EMAIL_CONNECTION_ROUTE}/copy.js" defer></script></head><body><header><strong>Growth HQ</strong><nav aria-label="Workspace navigation"><a href="/portal">Home</a> · <a href="/portal/follow-ups">Follow-ups</a></nav></header><main>${message}${body(page)}</main></body></html>`;
}

/** A small page for a refused request, with a way back to a fresh copy of the email page. */
export function renderEmailConnectionProblem(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect email</title><style>body{margin:0;background:#f4f3ef;color:#172b30;font:17px/1.65 system-ui,sans-serif}main{max-width:640px;margin:auto;padding:32px 16px}section{background:#fff;border:1px solid #d2dbdb;border-radius:18px;padding:28px}a{display:inline-block;padding:14px 20px;border-radius:9px;background:#f2b440;color:#172b30;font-weight:700;text-decoration:none}</style></head><body><main><section role="alert"><p>${e(message)}</p><a href="${EMAIL_CONNECTION_ROUTE}">Back to email</a></section></main></body></html>`;
}
