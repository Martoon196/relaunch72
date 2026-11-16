/**
 * The owner's "Connect email" screens: one guided path in five named steps, with exactly one filled (primary) button
 * in every state, the next thing to do. Everything else is a secondary button under one "More options" disclosure at
 * the bottom, each with one line saying what it does. The exceptions are deliberate: once live, Pause stays visible
 * (as a secondary button); in the founder's domain clash "Use this domain" is the one primary; and right after Go live
 * could not confirm bounce reporting, "Repair bounce reporting" is.
 *
 * Plain English only: no setting names, no provider error text, no ids, and none of the words DNS, TXT, CNAME, DKIM or
 * Return-Path in running text (the exact record type appears only in a record's own Type field; a host's own menu
 * names are quoted as they appear there). Every value from the database or the owner is escaped. The one same-origin
 * script (allowed by the page's CSP) is progressive enhancement: it reveals the Copy buttons, and while the records step
 * is open it checks again about once a minute for up to 30 minutes (never repairing, so it never creates anything).
 */
import { escapeHtml as e } from './ui.js';
import { shortHost, type DnsHost } from '../email-connections/domains.js';
import { EMAIL_CONNECTION_MESSAGES, type EmailConnectionView } from '../email-connections/service.js';
import { EMAIL_TERMS, EMAIL_TERMS_AGREEMENT, EMAIL_TERMS_VERSION } from '../email-connections/terms.js';
import type { EmailConnectionState } from '../email-connections/store.js';
import type { OwnerSendingView, SendingResult } from '../email-protection/owner.js';
import type { Banner, FounderLine } from '../email-protection/messages.js';
import { percent, RAMP, SAMPLE, bounces7 } from '../email-protection/rules.js';
import type { FounderToday } from '../email-protection/service.js';
import type { ProtectionStatus } from '../email-protection/store.js';
import type { SendingState } from '../email-protection/store.js';
import type { AllowlistBusiness, AllowlistResult, AllowlistView } from '../email-connections/allowlist.js';
import { EMAIL_STEP_NAMES, emailStepNow, type EmailStep } from './email-connection-progress.js';

export const EMAIL_CONNECTION_ROUTE = '/portal/email';

/**
 * The page script: Copy buttons, and the records step checking again by itself. It posts the page's own Check form
 * (same origin, the page's CSRF token, plus auto=yes so the check never repairs or creates anything), at most once a
 * minute while the tab is visible, for up to 30 minutes, and stops on any answer that is not a normal page. An answer
 * that changes nothing keeps the owner's place; one that says something new (a record found, or a Value that doesn't
 * match) replaces the page so the owner sees it.
 */
export const EMAIL_CONNECTION_COPY_SCRIPT = `(function(){
function copies(root){var b=root.querySelectorAll('button[data-copy]');for(var i=0;i<b.length;i++){(function(x){x.hidden=false;x.addEventListener('click',function(){if(!navigator.clipboard)return;var was=x.textContent;navigator.clipboard.writeText(x.getAttribute('data-copy')||'').then(function(){x.textContent='Copied';setTimeout(function(){x.textContent=was;},2000);});});})(b[i]);}
var shown=root.querySelectorAll('[data-js-only]');for(var j=0;j<shown.length;j++)shown[j].hidden=false;}
var started=Date.now(),busy=false,timer=null;
function form(){return document.querySelector('form[data-auto-check]');}
function say(t){var n=document.querySelector('[data-auto-check-note]');if(n)n.textContent=t;}
function stop(t){if(timer){clearInterval(timer);timer=null;}if(t)say(t);}
function tick(){var f=form();if(!f){stop();return;}
if(Date.now()-started>30*60000){stop('We have stopped checking by ourselves after 30 minutes. When the records are added, press Check.');return;}
if(document.hidden||busy)return;busy=true;
var body=new URLSearchParams(new FormData(f));body.append('auto','yes');
fetch(f.action,{method:'POST',body:body,credentials:'same-origin',redirect:'error'}).then(function(r){if(r.status!==200)throw new Error('status');return r.text();}).then(function(html){busy=false;
var doc=new DOMParser().parseFromString(html,'text/html'),fresh=doc.querySelector('main'),main=document.querySelector('main');if(!fresh||!main)throw new Error('page');
var was=document.querySelector('[data-records-found]'),now=doc.querySelector('[data-records-found]');
var said=document.querySelector('[data-message]'),says=doc.querySelector('[data-message]');
var same=was&&now&&was.getAttribute('data-records-found')===now.getAttribute('data-records-found');
if(same&&(doc.querySelector('[data-auto-quiet]')||(said&&says&&said.textContent===says.textContent))){say('Checked again at '+new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})+'. Not all found yet: we look again in about a minute.');return;}
main.innerHTML=fresh.innerHTML;copies(main);if(!form())stop();}).catch(function(){busy=false;stop('We stopped checking by ourselves because something went wrong. Press Check to try again.');});}
copies(document);
if(form()&&window.fetch&&window.URLSearchParams&&window.FormData&&window.DOMParser){timer=setInterval(tick,60000);}
})();`;

export interface EmailConnectionPageInput {
  readonly view: EmailConnectionView;
  readonly csrf: string;
  readonly commandId: string;
  readonly message?: { readonly text: string; readonly ok: boolean };
  /** What the owner typed, shown again after a refusal. */
  readonly form?: { readonly fromName: string; readonly fromAddress: string; readonly replyTo: string };
  /** The email rules were ticked on step 1 (carried to step 2 in the form; recorded when Connect is pressed). */
  readonly agreed?: boolean;
  /** Only for the platform founder, after a clash with a domain already in the shared account. */
  readonly offerTakeOver?: boolean;
  /** A customer's clash with a domain used elsewhere in the account: Continue would only meet it again. */
  readonly clash?: boolean;
  /** Go live (or a repair) could not confirm the bounce webhook: "Repair bounce reporting" is offered. */
  readonly offerBounceRepair?: boolean;
  /** Release 2: the sending controls (only for a verified connection on a database with 0156). */
  readonly sending?: OwnerSendingView;
  /** What the owner typed in the sending details, shown again after a refusal. */
  readonly sendingForm?: { readonly businessName: string; readonly postalAddress: string; readonly testList: string };
  /** A test was just sent: step 4 asks "Did it arrive?" (nothing is stored about the answer). */
  readonly testSent?: boolean;
  /** The page's own automatic check learnt nothing new: marked so its script keeps the owner's place. */
  readonly autoQuiet?: boolean;
}

const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${e(value)}">`;
const day = (value: string) => new Date(value).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' });
const when = (value: string) => new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const plain = (n: number, one: string, many: string) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
/** A host's own menu or button name, quoted exactly as it appears on their site. */
const ui = (text: string) => `<span class="ui-name">${e(text)}</span>`;
/** "[[DNS]]" in a help line is a host's own menu name. */
const helpLine = (line: string) => e(line).replace(/\[\[(.+?)\]\]/gu, (_m, name: string) => `<span class="ui-name">${name}</span>`);

const BOUNCE_REPAIR_NOTE = 'If the email service can\'t reach our bounce address, this sets bounce reporting up again. Afterwards you may need to check your records and send yourself a test again; the page will show you.';

const HELP: Readonly<Record<DnsHost, { readonly name: string; readonly steps: readonly string[] }>> = {
  cloudflare: { name: 'Cloudflare', steps: ['Log in to Cloudflare and open your domain. In the menu, choose [[DNS]], then [[Records]].',
    'Press [[Add record]]. For Type, pick the Type shown on the record below, then paste its Name and its Value.',
    'For record 2, set [[Proxy status]] to [[DNS only]] (the grey cloud). Press [[Save]], then add the other record the same way.'] },
  godaddy: { name: 'GoDaddy', steps: ['Sign in to GoDaddy, open [[My Products]] and press [[DNS]] next to your domain.',
    'Press [[Add New Record]]. For Type, pick the Type shown on the record below, then paste its short Name and its Value.', 'Press [[Save]], then add the other record the same way.'] },
  namecheap: { name: 'Namecheap', steps: ['Sign in to Namecheap, open [[Domain List]], press [[Manage]] next to your domain, then [[Advanced DNS]].',
    'Press [[Add New Record]] and pick the Type shown on the record below. Paste its short Name into [[Host]] and its Value into [[Value]].', 'Press the tick to save, then add the other record.'] },
  '123-reg': { name: '123-reg', steps: ['Sign in to 123-reg, choose your domain, then [[Manage DNS]] ([[Advanced DNS]]).',
    'Add a new record: pick the Type shown on the record below, then paste its short Name and its Value.', 'Save, then add the other record the same way.'] },
  ionos: { name: 'IONOS', steps: ['Sign in to IONOS, open [[Domains & SSL]], choose your domain, then [[DNS]].',
    'Press [[Add record]], pick the Type shown on the record below, then paste its short [[Host name]] and its Value.', 'Save, then add the other record the same way.'] },
  other: { name: '', steps: ['Sign in where your domain is managed. That is usually the company you bought it from.',
    'Find the settings for your domain’s records. They are often called [[DNS]], [[DNS settings]] or [[Zone file]].',
    'Add a new record for each one below: pick the Type shown, paste the Name and the Value, then save. Come back here and press Check.'] },
};

// ---------------------------------------------------------------- buttons and forms

const action = (page: EmailConnectionPageInput, name: string, label: string, secondary = false, extra = '') =>
  `<form method="post" action="${EMAIL_CONNECTION_ROUTE}/${name}"${extra}>${hidden('csrf', page.csrf)}${hidden('commandId', page.commandId)}<button type="submit"${secondary ? ' class="secondary"' : ''}>${e(label)}</button></form>`;
const link = (href: string, label: string, secondary = false) => `<a class="button${secondary ? ' secondary' : ''}" href="${e(href)}">${e(label)}</a>`;

interface More { readonly what: string; readonly html: string }
const more = (what: string, html: string): More => ({ what, html });

function moreOptions(items: readonly More[]): string {
  if (!items.length) return '';
  return `<details class="more"><summary>More options</summary><ul class="more-list">${items.map(item => `<li><p class="small">${e(item.what)}</p>${item.html}</li>`).join('')}</ul></details>`;
}

function termsList(): string {
  return `<ul class="rules">${EMAIL_TERMS.map(rule => `<li>${e(rule)}</li>`).join('')}</ul>`;
}
const agreeBox = () => `<label class="check" for="email-agree"><input id="email-agree" type="checkbox" name="agree" value="yes" required> ${e(EMAIL_TERMS_AGREEMENT)}</label>`;

function addressFields(page: EmailConnectionPageInput, state: EmailConnectionState): string {
  const form = page.form ?? { fromName: state.fromName ?? '', fromAddress: state.fromAddress ?? '', replyTo: state.replyTo ?? '' };
  return `<label for="email-from-name">Sender name<span class="hint">The name people see in their inbox, like your business name.</span><input id="email-from-name" name="fromName" maxlength="100" required value="${e(form.fromName)}" autocomplete="organization"></label>
    <label for="email-from">Send from (an address on your own domain)<span class="hint">For example hello@yourbusiness.co.uk. Not a Gmail, Outlook or other free address.</span><input id="email-from" name="fromAddress" type="email" maxlength="254" required value="${e(form.fromAddress)}" placeholder="hello@yourbusiness.co.uk"></label>
    <label for="email-reply">Replies go to<span class="hint">Optional. Leave it empty and replies come back to the address above.</span><input id="email-reply" name="replyTo" type="email" maxlength="254" value="${e(form.replyTo)}"></label>`;
}

/** The address form. With the tick box (step 1 refused, or "Use different details"), or with the tick carried from step 1. */
function connectForm(page: EmailConnectionPageInput, state: EmailConnectionState, button: string, secondary: boolean, withRules: boolean): string {
  return `<form method="post" action="${EMAIL_CONNECTION_ROUTE}/connect">${hidden('csrf', page.csrf)}${hidden('commandId', page.commandId)}
    ${addressFields(page, state)}
    ${withRules ? `<h3>Our email rules</h3>${termsList()}${agreeBox()}` : `${hidden('agree', 'yes')}<p class="agree-line">By pressing Connect you agree to our email rules. <a href="${EMAIL_CONNECTION_ROUTE}">Read the rules again</a></p>`}
    <button type="submit"${secondary ? ' class="secondary"' : ''}>${e(button)}</button></form>`;
}

// ---------------------------------------------------------------- the progress strip

function stepSummary(n: EmailStep, page: EmailConnectionPageInput, state: EmailConnectionState): string {
  const s = page.sending?.sending;
  switch (n) {
    case 1: return state.terms ? `Agreed by ${state.terms.acceptedByName ?? 'the business owner'} on ${day(state.terms.acceptedAt)}.` : 'Read: you agree when you press Connect.';
    case 2: return state.fromAddress ? `Sends from ${state.fromName ?? ''} <${state.fromAddress}>` : 'Your sending address is saved.';
    case 3: return state.domain ? `Both records found on ${state.domain}` : 'Both records found';
    case 4: return page.sending?.testList.length ? `Test sent to ${page.sending.testList.join(', ')}` : s?.testCurrent ? 'Test sent' : 'Connected';
    case 5: return 'You are live';
  }
}
const LATER: Readonly<Record<EmailStep, string>> = {
  1: `Read and agree to ${EMAIL_TERMS.length} short rules.`, 2: 'Choose the address your emails come from.', 3: 'Add two records at the company that manages your domain.',
  4: 'Add your business details and send a test email to yourself.', 5: 'Ask to go live. The platform owner approves it.',
};

function progressStrip(now: EmailStep | 'live' | 'held', page: EmailConnectionPageInput, state: EmailConnectionState): string {
  const items = ([1, 2, 3, 4, 5] as const).map(n => {
    // 'held': connected, and the rest switches on later (a database without sending controls): nothing is "now".
    const done = now === 'live' || (now === 'held' ? n <= 3 : n < now), current = now === n;
    const line = done ? stepSummary(n, page, state) : current ? 'You are here.' : now === 'held' ? 'Switched on later: nothing is needed from you now.' : LATER[n];
    return `<li class="${done ? 'done' : current ? 'now' : 'later'}"${current ? ' aria-current="step"' : ''}><span class="dot" aria-hidden="true">${done ? '✓' : n}</span>`
      + `<span><strong>${n} ${e(EMAIL_STEP_NAMES[n])}</strong>${done ? '<span class="sr"> (done)</span>' : current ? '<span class="sr"> (now)</span>' : ''}<span class="line">${e(line)}</span></span></li>`;
  }).join('');
  return `<ol class="steps" aria-label="Your progress">${items}</ol>`;
}

// ---------------------------------------------------------------- step 3: the two records

function recordCard(n: 1 | 2, kind: 'TXT' | 'CNAME', host: string, value: string, domain: string, verified: boolean): string {
  const short = shortHost(host, domain);
  const line = (label: string, text: string, hint = '', type = false) => `<div class="field"${type ? ' data-type-field' : ''}><span class="label">${label}</span><code>${e(text)}</code><button type="button" class="secondary copy" data-copy="${e(text)}" hidden>Copy</button>${hint ? `<span class="note">${hint}</span>` : ''}</div>`;
  return `<article class="record"><h4>Record ${n} ${verified ? '<span class="found">Found ✓</span>' : '<span class="waiting">Not found yet</span>'}</h4>
    ${line('Type', kind, '', true)}${line('Name', short, 'Most companies want this short name')}${line('Full name', host, 'Some companies want the full name instead')}${line('Value', value)}</article>`;
}

/** The message for whoever looks after the website: the same text in the mail link and in the copy box. */
function helperText(state: EmailConnectionState): string {
  const dns = state.dns!, domain = state.domain ?? '';
  return [`Hello,`, ``, `Please could you add these 2 DNS records for ${domain}, so our emails can be sent from ${state.fromAddress ?? domain}?`, ``,
    `Record 1`, `   Type: TXT`, `   Name: ${shortHost(dns.dkim.host, domain)}  (full name: ${dns.dkim.host})`, `   Value: ${dns.dkim.value}`, ``,
    `Record 2`, `   Type: CNAME`, `   Name: ${shortHost(dns.returnPath.host, domain)}  (full name: ${dns.returnPath.host})`, `   Value: ${dns.returnPath.value}`,
    `   If the domain is on Cloudflare, set this one to DNS only (grey cloud).`, ``, `Thank you!`].join('\n');
}
function mailto(state: EmailConnectionState): string {
  return `mailto:?subject=${encodeURIComponent(`DNS records for ${state.domain ?? ''}`)}&body=${encodeURIComponent(helperText(state))}`;
}

function recordsCard(page: EmailConnectionPageInput, state: EmailConnectionState, host: DnsHost | null): { card: string; more: More[] } {
  const dns = state.dns!, domain = state.domain ?? '';
  const found = Number(dns.dkim.verified) + Number(dns.returnPath.verified), bothFound = found === 2;
  const repairFirst = page.offerBounceRepair === true;
  const check = action(page, 'check', 'Check', repairFirst, repairFirst ? '' : ' data-auto-check');
  const status = `<ul class="status" aria-label="Your two records"><li>Record 1: ${dns.dkim.verified ? '<span class="found">Found ✓</span>' : '<span class="waiting">Not found yet</span>'}</li>
    <li>Record 2: ${dns.returnPath.verified ? '<span class="found">Found ✓</span>' : '<span class="waiting">Not found yet</span>'}</li></ul>`;
  const records = recordCard(1, 'TXT', dns.dkim.host, dns.dkim.value, domain, dns.dkim.verified) + recordCard(2, 'CNAME', dns.returnPath.host, dns.returnPath.value, domain, dns.returnPath.verified);
  const help = HELP[host ?? 'other'];
  const text = helperText(state);
  const intro = bothFound
    ? `<h2>Your two records are already in place</h2><p>Your domain is <strong>${e(domain)}</strong>. Both records are already found, so there is nothing to add. Press Check to finish connecting.</p>`
    : `<h2>Add two records at the company that manages your domain</h2>
      <p>Your domain is <strong>${e(domain)}</strong>. To prove these emails really come from you, two small records need adding at the company that manages your domain (usually where you bought it). This is the hardest step, and many people ask whoever looks after their website to do it.</p>
      ${status}<p><strong>Choose one:</strong></p>
      <details class="choice" name="records-choice"${host && host !== 'other' ? ' open' : ''}><summary>I’ll add them myself</summary>
        <h3>Where do I add these?</h3><p>${help.name ? `Your domain looks like it is managed by <strong>${e(help.name)}</strong>.` : 'Here is how it usually goes.'}</p>
        <ol>${help.steps.map(step => `<li>${helpLine(step)}</li>`).join('')}</ol>${records}</details>
      <details class="choice" name="records-choice"><summary>Send these to whoever looks after my website</summary>
        <p>Press the button to open an email with everything they need, ready to send. If no email opens, copy the message below and send it yourself.</p>
        <p>${link(mailto(state), 'Write the email for me', true)}</p>
        <div data-for-helper><label for="email-helper-text">The message to send</label><textarea id="email-helper-text" readonly rows="14">${e(text)}</textarea>
        <button type="button" class="secondary copy" data-copy="${e(text)}" hidden>Copy</button></div></details>`;
  const timing = bothFound ? '' : `<h3>After they are added</h3>
    <p>Records can take from a few minutes to a few hours to show up. You can close this page and come back at any time: your place is kept. “Found” means the email service can see that record on your domain.</p>
    <p class="small" data-auto-check-note data-js-only hidden>While this page is open, it checks again by itself about once a minute, for up to 30 minutes.</p>`;
  const repair = repairFirst ? `<p class="notice">Bounce reporting isn’t confirmed yet. Press Repair bounce reporting, then press Check under More options.</p><p class="small">${BOUNCE_REPAIR_NOTE}</p>${action(page, 'repair-bounces', 'Repair bounce reporting')}` : check;
  const card = `<section class="card step" id="email-step" data-records-found="${found}"><div class="eyebrow">Step 3 of 5</div>${intro}${bothFound ? status : ''}${timing}${repair}</section>`;
  const items: More[] = [];
  if (repairFirst) items.push(more('Ask the email service to look for your two records again.', action(page, 'check', 'Check', true)));
  if (bothFound) items.push(more('See the two records, in case someone asks for them.', `<details><summary>Show the records</summary>${records}</details>`));
  items.push(more('Use another address or domain. You will be given new records to add; the old ones can be removed.', action(page, 'disconnect', 'Start again', true)));
  return { card, more: items };
}

// ---------------------------------------------------------------- steps 4 and 5, and live

function businessDetailsFields(page: EmailConnectionPageInput, s: SendingState, sending: OwnerSendingView, open: boolean): string {
  const form = page.sendingForm ?? { businessName: s.businessName ?? '', postalAddress: s.postalAddress ?? '', testList: s.testRecipients.join(', ') };
  return `<label for="email-business-name">Your business's real name<span class="hint">For example: Property Predator Ltd</span><input id="email-business-name" name="businessName" maxlength="120" required value="${e(form.businessName)}" autocomplete="organization"></label>
    <label for="email-postal-address">Postal address (one line)<span class="hint">For example: 1 High Street, Leeds LS1 1AA</span><input id="email-postal-address" name="postalAddress" maxlength="300" required value="${e(form.postalAddress)}" autocomplete="street-address"></label>
    <details${open ? ' open' : ''}><summary>Send the test somewhere else</summary><p class="small">The test goes to ${e(sending.testList.join(', ') || 'the address you sign in with')}.</p>
    <label for="email-test-list">Send tests to (up to 10 addresses, separated by commas; leave empty to use your own)<input id="email-test-list" name="testList" maxlength="2700" value="${e(form.testList)}"></label></details>`;
}

function detailsForm(page: EmailConnectionPageInput, s: SendingState, sending: OwnerSendingView, thenTest: boolean, secondary: boolean): string {
  return `<form method="post" action="${EMAIL_CONNECTION_ROUTE}/details">${hidden('csrf', page.csrf)}${hidden('commandId', page.commandId)}${thenTest ? hidden('then', 'test') : ''}
    ${businessDetailsFields(page, s, sending, Boolean(page.sendingForm?.testList))}<button type="submit"${secondary ? ' class="secondary"' : ''}>${thenTest ? 'Save and send me a test' : 'Save'}</button></form>`;
}

function bouncedList(page: EmailConnectionPageInput, sending: OwnerSendingView): string {
  if (!sending.bounced.length) return '';
  return `<section class="card"><h3>Addresses we no longer email</h3><p class="small">These came straight back as undeliverable. If you know one works now, press the button beside it.</p>
    <ul class="plain">${sending.bounced.map(item => `<li><span>${e(item.email)}</span> <form method="post" action="${EMAIL_CONNECTION_ROUTE}/works-now">${hidden('csrf', page.csrf)}${hidden('commandId', page.commandId)}${hidden('email', item.email)}<button type="submit" class="secondary copy">This address works now</button></form></li>`).join('')}</ul></section>`;
}

const startingLimits = () => `<p>New senders start at up to ${plain(RAMP[0]!.daily, 'marketing email', 'marketing emails')} a day. Your first ${SAMPLE.size} go first, then we wait ${SAMPLE.waitHours} hours to check how many bounced or were marked as spam; if no more than 1 bounced and nobody marked one as spam, the rest go by themselves. The daily number rises as your emails keep arriving safely, up to ${RAMP[RAMP.length - 1]!.daily.toLocaleString('en-GB')} a day.</p>`;

/** The More options every connected screen shares (each shown only where it can work). */
function connectedMore(page: EmailConnectionPageInput, state: EmailConnectionState, s: SendingState | null, sending: OwnerSendingView | undefined,
  include: { test?: boolean; details?: boolean; pauseResume?: boolean } = {}): More[] {
  const items: More[] = [];
  const off = state.protection.state === 'off';
  // The owner's own pause, wherever the card itself does not carry it: Resume while paused, Pause in test or live.
  if (include.pauseResume && s && !off) {
    if (s.ownerPausedAt) items.push(more('You paused your marketing emails. Let them go again.', action(page, 'resume', 'Resume', true)));
    else if (state.mode !== 'off') items.push(more('Stop your marketing emails until you resume them. Sign-in links and receipts still go.', action(page, 'pause', 'Pause', true)));
  }
  if (include.test && s && !off) items.push(more('Send another test email to yourself.', action(page, 'test-send', 'Send a test to me', true)));
  if (include.details && s && sending) items.push(more('Change your business name, postal address or where tests go.', `<details><summary>Change your business details</summary>${detailsForm(page, s, sending, false, true)}</details>`));
  items.push(more('Ask the email service to look at your two records again.', action(page, 'check', 'Check again', true)));
  if (s && !off) {
    if (state.mode === 'off') items.push(more('Send your follow-up emails through this address to your test addresses only, before you go live.', action(page, 'start-test', 'Start testing', true)));
    if (state.mode === 'live') items.push(more('Only your test addresses get emails until you go live again.', action(page, 'back-to-test', 'Back to testing', true)));
  }
  items.push(more('Email stops being connected for this business. Your domain is kept if its records were found, and you can connect again later.', action(page, 'disconnect', 'Disconnect', true)));
  return items;
}

function figures(state: EmailConnectionState, s: SendingState): string {
  // While the owner's own pause holds, nothing marketing goes: no "up to N a day can go" line.
  const counts = s.counts;
  if (!counts) return '';
  return `<p>In the last 7 days: ${e(plain(counts.sends7, 'email', 'emails'))} sent, ${e(plain(bounces7(counts), 'bounce', 'bounces'))}${counts.sends7 ? ` (${e(percent(bounces7(counts), counts.sends7))})` : ''}${counts.blocked7 ? `, ${e(plain(counts.blocked7, 'email', 'emails'))} blocked by the receiving email service` : ''}. In the last 30 days: ${e(plain(counts.complaints30, 'spam report', 'spam reports'))}.</p>
    ${state.mode === 'live' && !s.ownerPausedAt && state.protection.state !== 'paused' && state.protection.state !== 'off' ? `<p>Right now up to ${e(plain(state.protection.dailyCap, 'marketing email', 'marketing emails'))} a day can go${state.protection.dailyCap < RAMP[RAMP.length - 1]!.daily ? ', rising as your emails keep arriving safely' : ''}. ${e(plain(counts.liveDay, 'has', 'have'))} gone in the last 24 hours.</p>` : ''}`;
}

interface Screen { readonly now: EmailStep | 'live' | 'held'; readonly card: string; readonly more: readonly More[]; readonly after?: string;
  /** This card is the waiting-for-approval card (so the banner saying the same is not shown twice). */
  readonly saysWaiting?: boolean }

function sendingScreen(page: EmailConnectionPageInput, state: EmailConnectionState, sending: OwnerSendingView): Screen {
  const s = sending.sending!;
  const step = emailStepNow(page.view, sending) as EmailStep | 'live';
  const from = `${state.fromName ?? ''} <${state.fromAddress ?? ''}>`;
  const after = bouncedList(page, sending);
  if (state.protection.state === 'off') {
    return { now: step, after, more: connectedMore(page, state, s, sending, { details: true }), card: `<section class="card step" id="email-step"><h2>Email sending is switched off</h2>
      <p>The note at the top says why and what happens next. There is nothing to press on this page: only we can switch it back on.</p>${link('/portal', 'Back to Growth HQ')}</section>` };
  }
  const outdated = state.terms && state.terms.version !== EMAIL_TERMS_VERSION
    ? `<p class="notice">Our email rules have changed since you agreed to them. To agree to the new ones, press Disconnect under More options, then connect again with the same address. Records that were already found stay the same.</p>` : '';
  // The owner's own pause shows on every card: the banner asks them to press Resume, so Resume is here.
  const ownerPaused = Boolean(s.ownerPausedAt);
  const pausedNote = ownerPaused ? `<div class="notice paused-note"><p><strong>You have paused your marketing emails.</strong> Nothing marketing goes until you press Resume. You can carry on with this step meanwhile.</p>${action(page, 'resume', 'Resume', true)}</div>` : '';
  const pauseMore = { pauseResume: !ownerPaused };
  // A go-live request still waiting, on a card other than the waiting card (for example a fresh test is needed).
  const waitingNote = s.goLiveRequestedAt ? `<p class="notice">Your request to go live (${e(when(s.goLiveRequestedAt))}) is waiting for the platform owner’s approval.</p>` : '';
  const several = sending.testList.length > 1;
  // Step 4: who the emails are from, then a test; then "Did it arrive?".
  if (step === 4 || (page.testSent && step === 5)) {
    if (page.testSent) {
      return { now: 4, after, more: connectedMore(page, state, s, sending, { details: true, ...pauseMore }), card: `<section class="card step" id="email-step"><div class="eyebrow">Step 4 of 5</div>${pausedNote}${waitingNote}<h2>Did it arrive?</h2>
        <p>We sent a test email to <strong>${e(sending.testList.join(', ') || 'your address')}</strong>. It comes from ${e(from)}, with the subject “Test email from ${e(state.fromName ?? '')}”.</p>
        ${link(EMAIL_CONNECTION_ROUTE, 'Yes, go to the last step')}
        <details class="nope"><summary class="button secondary">No, or it went to spam</summary><ol>
          <li>Wait two minutes. Emails sometimes take a little while.</li>
          <li>Look in your spam or junk folder. If it is there, mark it as “not spam” so the next ones arrive in your inbox.</li>
          <li>Check the address it went to: ${e(sending.testList.join(', ') || 'the address you sign in with')}. To use another, change it under More options.</li>
          <li>Then send it again.</li></ol>${action(page, 'test-send', 'Send it again', true)}</details>${outdated}</section>` };
    }
    return { now: 4, after, more: connectedMore(page, state, s, sending, pauseMore), card: `<section class="card step" id="email-step"><div class="eyebrow">Step 4 of 5</div>${pausedNote}${waitingNote}<h2>Send yourself a test</h2>
      <h3>First, who your emails are from</h3>
      <p>The law requires your real business name and postal address at the bottom of every marketing email. We add them for you, with an unsubscribe link, like this:</p>
      <p class="example">${e(s.businessName || 'Property Predator Ltd')} · ${e(s.postalAddress || '1 High Street, Leeds LS1 1AA')} · Unsubscribe</p>
      ${outdated}${detailsForm(page, s, sending, true, false)}
      <p class="small">${several ? `We save these details, then send a test email to each address (${e(sending.testList.join(', '))}) from ${e(from)}.` : `We save these details, then send one test email to you from ${e(from)}.`}</p></section>` };
  }
  if (step === 5) {
    const going = `<p>Going live means your follow-up and marketing emails go out from <strong>${e(from)}</strong>. Nothing extra is sent when you press it.</p>`;
    const mode = state.mode === 'test' ? `<p class="small">You are testing now: only your test addresses (${e(sending.testList.join(', ') || 'none yet')}) get emails until you go live.</p>` : '';
    if (s.goLiveRequestedAt) {
      // Paused by the owner while waiting: Resume is the one thing to press; checking for the answer is secondary.
      return { now: 5, after, saysWaiting: true, more: connectedMore(page, state, s, sending, { test: true, details: true, ...pauseMore }), card: `<section class="card step ok" id="email-step" role="status"><div class="eyebrow">Step 5 of 5</div><h2>Waiting for approval</h2>
        <p>You asked to go live on ${e(when(s.goLiveRequestedAt))}. The platform owner approves every new sender, and it is usually quick.</p>
        <p>${sending.willEmail ? 'We will email you when it is done.' : 'Check back on this page for the answer.'} Nothing else is needed from you.</p>
        ${ownerPaused ? `<p><strong>You have also paused your marketing emails.</strong> Nothing marketing goes until you press Resume, even once approved.</p><div class="actions">${action(page, 'resume', 'Resume')}${link(EMAIL_CONNECTION_ROUTE, 'Check for the answer', true)}</div>`
          : link(EMAIL_CONNECTION_ROUTE, 'Check for the answer')}</section>` };
    }
    if (page.offerBounceRepair) {
      return { now: 5, after, more: [more('Ask to go live again, once bounce reporting is repaired.', action(page, 'go-live', 'Go live', true)), ...connectedMore(page, state, s, sending, { test: true, details: true, ...pauseMore })],
        card: `<section class="card step" id="email-step"><div class="eyebrow">Step 5 of 5</div>${pausedNote}<h2>One repair before you go live</h2>
        <p>Before you go live, the email service must be able to tell us about emails that bounce. It couldn’t confirm that just now. Press Repair bounce reporting, then press Go live again.</p>
        <p class="small">${BOUNCE_REPAIR_NOTE}</p>${action(page, 'repair-bounces', 'Repair bounce reporting')}</section>` };
    }
    return { now: 5, after, more: connectedMore(page, state, s, sending, { test: true, details: true, ...pauseMore }), card: `<section class="card step" id="email-step"><div class="eyebrow">Step 5 of 5</div>${pausedNote}<h2>Go live</h2>
      ${going}${startingLimits()}<p>The first time, and whenever your domain changes, the platform owner approves it before anything goes.</p>${mode}${outdated}${action(page, 'go-live', 'Go live')}</section>` };
  }
  // Live: the card carries Pause (or Resume) itself.
  const paused = ownerPaused;
  const primary = page.offerBounceRepair ? action(page, 'repair-bounces', 'Repair bounce reporting') : paused ? action(page, 'resume', 'Resume') : link('/portal/follow-ups', 'Open your follow-ups');
  const pause = paused ? (page.offerBounceRepair ? action(page, 'resume', 'Resume', true) : '') : action(page, 'pause', 'Pause', true);
  return { now: 'live', after, more: connectedMore(page, state, s, sending, { test: true, details: true }), card: `<section class="card step ok" id="email-step"><h2>Your email is live ✓</h2>
    <p>Your follow-up and marketing emails go out from <strong>${e(from)}</strong>.</p>
    ${paused ? '<p><strong>You have paused your marketing emails.</strong> Nothing marketing goes until you press Resume.</p>' : ''}
    ${figures(state, s)}
    ${s.sampleState === 'sending' || s.sampleState === 'waiting' ? '' : `<p class="small">After a restart or a new list, your first ${SAMPLE.size} marketing emails go first, then we wait ${SAMPLE.waitHours} hours to check how many bounced or were marked as spam. If that is within our limits, the rest go by themselves.</p>`}
    ${outdated}<div class="actions">${primary}${pause}</div>${pause ? '<p class="small">Pause stops your marketing emails until you resume them here. Sign-in links and receipts still go.</p>' : ''}</section>` };
}

function repairCard(page: EmailConnectionPageInput): string {
  return `<section class="card step notice" id="email-step"><h2>Your email connection needs a repair</h2><p>Press Repair and we will set the connection up again with the same details. Your records stay the same.</p>
    ${action(page, 'continue', 'Repair')}</section>`;
}

function screen(page: EmailConnectionPageInput, state: EmailConnectionState, host: DnsHost | null): Screen {
  const view = page.view as Extract<EmailConnectionView, { offered: true }>;
  const now = emailStepNow(view, page.sending, page.agreed === true) ?? 1;
  switch (state.status) {
    case 'not_connected': case 'disconnected': {
      if (page.form && !page.agreed) {
        // The rules were not ticked on the way in: the rules and the address together, with what was typed kept.
        return { now: 1, more: [], card: `<section class="card step" id="email-step"><div class="eyebrow">Step 1 of 5</div><h2>Our email rules</h2>
          <p>Tick the box under the rules, then press Connect.</p>${connectForm(page, state, 'Connect', false, true)}</section>` };
      }
      if (!page.agreed) {
        return { now: 1, more: [], card: `<section class="card step" id="email-step"><div class="eyebrow">Step 1 of 5</div><h2>Our email rules</h2>
          <p>Every business sends through one shared email account, so these ${EMAIL_TERMS.length} short rules protect everyone. They take a minute to read.</p>${termsList()}
          <form method="get" action="${EMAIL_CONNECTION_ROUTE}">${agreeBox()}<button type="submit">Next: your address</button></form></section>` };
      }
      return { now: 2, more: [], card: `<section class="card step" id="email-step"><div class="eyebrow">Step 2 of 5</div><h2>Your sending address</h2>
        <p>This is the address your emails come from. It must be on your own domain: the part after the @, like yourbusiness.co.uk.</p>
        ${connectForm(page, state, 'Connect', false, false)}<p class="small">When you press Connect, we set everything up with the email service for you. It takes a few seconds.</p></section>` };
    }
    case 'creating': case 'needs_attention': {
      const other = more('Connect with another address or domain instead.', `<details><summary>Use different details</summary>${connectForm(page, state, 'Connect with these details', true, true)}</details>`);
      const again = more('Remove what was set up so far for this business and go back to step 1. Nothing is sent and nothing else changes.', action(page, 'disconnect', 'Start again', true));
      if (page.offerTakeOver) {
        return { now, more: [other, again], card: `<section class="card step" id="email-step"><div class="eyebrow">Step 3 of 5</div><h2>This domain is already in our email account</h2>
          <p>${e(state.domain ?? 'This domain')} is already set up in our shared email account. If it belongs to this business, press Use this domain.</p>${action(page, 'use-domain', 'Use this domain')}</section>` };
      }
      if (page.clash) {
        return { now, more: [again], card: `<section class="card step" id="email-step"><div class="eyebrow">Step 3 of 5</div><h2>Use an address on another domain</h2>
          <p>${e(state.domain ?? 'That domain')} is already used in our email account, so it can’t be connected from here. Use an address on a different domain below. If you think it is yours, tell the platform owner.</p>
          ${connectForm(page, state, 'Connect with these details', false, true)}</section>` };
      }
      return { now, more: [other, again], card: `<section class="card step" id="email-step"><div class="eyebrow">Step 3 of 5</div><h2>Setting up your domain</h2>
        <p>We were setting up sending for ${e(state.domain ?? 'your domain')} with the email service, and it didn’t finish. Press Continue to carry on from where it stopped. Nothing is set up twice.</p>
        <p class="small">If it stops again, wait a few minutes and press Continue again. When the problem is on our side, we are told and will sort it out.</p>${action(page, 'continue', 'Continue')}</section>` };
    }
    case 'dns_pending': {
      const again = more('Use another address or domain. You will be given new records to add; the old ones can be removed.', action(page, 'disconnect', 'Start again', true));
      if (view.repair) return { now, more: [again], card: repairCard(page) };
      if (!state.dns) return { now, more: [again], card: `<section class="card step" id="email-step"><div class="eyebrow">Step 3 of 5</div><h2>Setting up your domain</h2><p>${e(EMAIL_CONNECTION_MESSAGES.unfinished)}</p>${action(page, 'continue', 'Continue')}</section>` };
      const outdated = state.terms && state.terms.version !== EMAIL_TERMS_VERSION;
      const records = recordsCard(page, state, host);
      return { now, more: records.more, card: outdated ? records.card.replace('</section>', '<p class="notice">Our email rules have changed since you agreed to them. To agree to the new ones, press Start again under More options, then connect again with the same address.</p></section>') : records.card };
    }
    case 'verified': {
      if (view.repair) {
        const sv = page.sending?.sending ? page.sending : undefined;
        return { now, after: sv ? bouncedList(page, sv) : '', more: connectedMore(page, state, sv?.sending ?? null, sv, { details: true, pauseResume: true }), card: repairCard(page) };
      }
      if (page.sending?.sending) return sendingScreen(page, state, page.sending);
      // Release 1 only: connected; sending is switched on in the next release.
      return { now: 'held', more: connectedMore(page, state, null, undefined), card: `<section class="card step ok" id="email-step"><h2>Your email is connected ✓</h2>
        <p><strong>${e(EMAIL_CONNECTION_MESSAGES.connectedNext)}</strong> Nothing else is needed from you right now.</p>${link('/portal', 'Back to Growth HQ')}</section>` };
    }
  }
}

/** The business's banner (slowed, paused, off, sample held, account hold, own pause, waiting for approval). */
export function renderBanner(banner: Banner | null): string {
  if (!banner) return '';
  const cls = banner.tone === 'alert' ? 'card alert' : banner.tone === 'notice' ? 'card notice' : 'card ok';
  return `<section class="${cls}" role="${banner.tone === 'alert' ? 'alert' : 'status'}"><h2>${e(banner.title)}</h2><p>${e(banner.text)}</p></section>`;
}

function body(page: EmailConnectionPageInput): string {
  const view = page.view;
  if (!view.offered) return `<section class="card"><h1>Connect your email</h1><p>${e(view.message)}</p></section>`;
  const { state } = view;
  const shown = screen(page, state, view.dnsHost);
  const banner = page.sending?.banner ?? null;
  // The step card says everything the waiting banner would, with who approves: shown once.
  const bannerHtml = banner && !(shown.saysWaiting && banner.title === 'Waiting for approval') ? renderBanner(banner) : '';
  const intro = `<section class="card intro"><div class="eyebrow">Email</div><h1>Connect your email</h1>
    <nav class="business" aria-label="Business"><span>Business</span> <a href="${EMAIL_CONNECTION_ROUTE}?business=${e(view.business.workspaceId)}" aria-current="page">${e(view.business.name)}</a></nav>
    <p>Send your follow-up and marketing emails from your own address, one step at a time. About 5 minutes, plus adding two records to your domain.</p>${progressStrip(shown.now, page, state)}</section>`;
  return `${bannerHtml}${intro}${shown.card}${shown.after ?? ''}${moreOptions(shown.more)}`;
}

const PAGE_STYLE = `body{margin:0;background:#f4f3ef;color:#172b30;font:17px/1.65 system-ui,sans-serif}header,main{max-width:860px;margin:auto;padding:24px}header{display:flex;gap:14px;flex-wrap:wrap;justify-content:space-between}a{color:#164756}h1{font:clamp(32px,5vw,46px)/1.15 Georgia,serif;margin:.2em 0}h2{font-size:26px;line-height:1.3;margin:.3em 0 .5em}h3{font-size:20px;margin:1.2em 0 .4em}h4{font-size:18px;margin:0 0 8px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}p,li{max-width:70ch}
.card{background:#fff;border:1px solid #d2dbdb;border-radius:18px;padding:clamp(18px,4vw,34px);margin:0 0 22px;min-width:0}.step{border:2px solid #164756}.eyebrow{font-weight:800;font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:#465b60}
.notice{border-left:4px solid #bd8a31;background:#faf3e5;padding:12px 16px}.ok{border-left:4px solid #2f7d55;background:#eef7f1}.card.ok{border-left-width:6px}.alert{border-left:4px solid #9c2f14;background:#fdf1ec}
.actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:16px 0}.actions form{margin:0}.plain{list-style:none;padding:0}.plain li{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:8px 0;overflow-wrap:anywhere}
.note,.small,.hint{color:#465b60;font-size:15px}.hint{display:block;font-weight:400}label{display:block;font-weight:700;margin:18px 0}input:not([type=hidden]):not([type=checkbox]),textarea{display:block;box-sizing:border-box;width:100%;padding:13px;margin-top:7px;border:1px solid #9daeb0;border-radius:8px;font:17px/1.5 system-ui;background:#fff;color:#172b30}textarea{font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap}
.check{display:flex;gap:12px;align-items:flex-start}.check input{margin-top:6px;width:22px;height:22px;flex:none}
button,.button{display:inline-block;box-sizing:border-box;max-width:100%;padding:15px 24px;border:0;border-radius:10px;background:#f2b440;color:#172b30;font:700 18px/1.4 system-ui;cursor:pointer;text-decoration:none;text-align:center;margin:8px 0}.secondary{background:#eaf0ef;border:1px solid #adbdbe;font-weight:600;font-size:16px;padding:11px 18px}
.record{border:1px solid #bdcbca;border-radius:12px;padding:16px 20px;margin:16px 0;background:#fafcfa}.field{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}.field button{margin:0}.label{min-width:7em;font-weight:700}code{user-select:all;overflow-wrap:anywhere;background:#eef2f1;padding:4px 8px;border-radius:6px;font-size:15px;max-width:100%}.copy{padding:6px 12px;font-size:14px}
.found{color:#1f6b45;font-weight:700;font-size:16px;background:#e2f3e8;border-radius:999px;padding:2px 10px}.waiting{color:#6b4d12;font-weight:700;font-size:16px;background:#f6ecd6;border-radius:999px;padding:2px 10px}.status{list-style:none;padding:0;margin:14px 0}.status li{margin:6px 0}
.business span{font-weight:700}details{margin:16px 0}summary{cursor:pointer;font-weight:700}
.choice{border:1px solid #9daeb0;border-radius:12px;padding:0 18px;margin:12px 0;background:#fafcfa}.choice>summary{padding:16px 0;font-size:18px}.choice[open]{padding-bottom:16px;border-color:#164756}
.nope>summary{display:inline-block;list-style:none}.nope>summary::-webkit-details-marker{display:none}.example{font-size:15px;background:#f4f3ef;border-radius:8px;padding:10px 14px;border:1px dashed #9daeb0}
.more{background:#fff;border:1px solid #d2dbdb;border-radius:18px;padding:6px 22px}.more>summary{padding:14px 0}.more-list{list-style:none;padding:0;margin:0 0 12px}.more-list>li{border-top:1px solid #e1e7e6;padding:12px 0}.more-list p{margin:0}.more-list form{margin:0}
.steps{list-style:none;padding:0;margin:18px 0 0;display:grid;gap:6px}.steps li{display:flex;gap:12px;align-items:flex-start;padding:8px 12px;border-radius:10px;overflow-wrap:anywhere}.steps .dot{flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:15px;background:#e1e7e6;color:#465b60}.steps .line{display:block;font-size:15px;color:#465b60}
.steps .done .dot{background:#2f7d55;color:#fff}.steps .now{background:#fdf3dc;border:2px solid #f2b440}.steps .now .dot{background:#f2b440;color:#172b30}.steps .later{color:#6a7b7e}.steps .later strong{font-weight:600}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.paused-note{margin:0 0 14px}.paused-note p{margin:0 0 4px}.agree-line{font-weight:600}
.ui-name{font-weight:700;background:#eef2f1;border-radius:4px;padding:0 4px}
a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible,textarea:focus-visible{outline:3px solid #83510c;outline-offset:3px}
main>.card>p:only-child{margin:0}
@media(max-width:520px){header,main{padding:16px}.actions form,.more-list form{width:100%}button:not(.copy),.button{width:100%}.field .label{min-width:0;width:100%}.more{padding:4px 16px}.choice{padding:0 14px}}`;

export function renderEmailConnectionPage(page: EmailConnectionPageInput): string {
  const message = page.message ? `<section class="card ${page.message.ok ? 'ok' : 'notice'}" data-message${page.autoQuiet ? ' data-auto-quiet' : ''} role="${page.message.ok ? 'status' : 'alert'}"><p>${e(page.message.text)}</p></section>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your email</title><style>${PAGE_STYLE}</style><script src="${EMAIL_CONNECTION_ROUTE}/copy.js" defer></script></head><body><header><strong>Growth HQ</strong><nav aria-label="Workspace navigation"><a href="/portal">Home</a> · <a href="/portal/follow-ups">Follow-ups</a></nav></header><main>${message}${body(page)}</main></body></html>`;
}

/** A small page for a refused request, with a way back to a fresh copy of the email page. */
export function renderEmailConnectionProblem(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your email</title><style>body{margin:0;background:#f4f3ef;color:#172b30;font:17px/1.65 system-ui,sans-serif}main{max-width:640px;margin:auto;padding:32px 16px}section{background:#fff;border:1px solid #d2dbdb;border-radius:18px;padding:28px}a{display:inline-block;padding:14px 20px;border-radius:9px;background:#f2b440;color:#172b30;font-weight:700;text-decoration:none}</style></head><body><main><section role="alert"><p>${e(message)}</p><a href="${EMAIL_CONNECTION_ROUTE}">Back to email</a></section></main></body></html>`;
}

const ALLOWLIST_STYLE = 'h2{font:24px/1.3 Georgia,serif;margin:28px 0 12px}h3{margin:0 0 6px;font-size:19px;overflow-wrap:anywhere}label{display:block;font-weight:700;margin:12px 0 6px}select,input{display:block;box-sizing:border-box;width:100%;padding:12px;margin:0 0 12px;border:1px solid #9daeb0;border-radius:8px;font:17px/1.5 system-ui;background:#fff;color:#172b30}.secondary{display:inline-block;padding:10px 16px;border:1px solid #adbdbe;border-radius:9px;background:#eaf0ef;font-weight:600;cursor:pointer}details.confirm>summary{list-style:none}details.confirm>summary::-webkit-details-marker{display:none}details.confirm[open]>summary{margin-bottom:8px}summary:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid #83510c;outline-offset:3px}';
const UNDELIVERED: Readonly<Record<string, string>> = { paused: 'A pause', switched_off: 'A switch-off', slowed: 'A slow-down', sample_held: 'A held list',
  go_live_requested: 'A go-live request', go_live_approved: 'A go-live approval', account_held: 'The account hold', lifted: 'A restart', reinstated: 'A switch back on', sample_released: 'A released list' };
const founderButton = (page: { csrf: string; commandId: string }, action: string, workspace: string, version: number, label: string) =>
  `<form method="post" action="${EMAIL_CONNECTION_ROUTE}/founder/act">${hidden('csrf', page.csrf)}${hidden('commandId', page.commandId)}${hidden('action', action)}${hidden('workspace', workspace)}${hidden('version', String(version))}<button type="submit">${e(label)}</button></form>`;

const allowlistForm = (page: { csrf: string; commandId: string }, action: 'allow' | 'revoke' | 'reallow', workspace: string, inner: string) =>
  `<form method="post" action="${EMAIL_CONNECTION_ROUTE}/founder/allowlist">${hidden('csrf', page.csrf)}${hidden('commandId', page.commandId)}${hidden('action', action)}${action === 'allow' ? '' : hidden('workspace', workspace)}${inner}</form>`;

/** One business's email in a few plain words, for the founder's list. */
function allowlistState(b: AllowlistBusiness): string {
  const base = !b.hasConnection ? 'Its owner has not connected email yet.'
    : b.status === 'disconnected' ? 'Its owner disconnected email.'
      : b.status !== 'verified' ? 'Its owner is setting up email.'
        : b.mode === 'live' ? 'Connected and sending marketing emails.' : b.mode === 'test' ? 'Connected and testing.' : 'Connected, not sending yet.';
  const protection = b.protectionState === 'paused' ? ' Paused by our protection.' : b.protectionState === 'off' ? ' Switched off by our protection.' : '';
  return base + protection;
}
const named = (b: AllowlistBusiness) => b.businessName && b.businessName !== b.name ? `${e(b.name)} <span class="small">(${e(b.businessName)})</span>` : e(b.name);

/**
 * Who may use Connect email (0157): "Invite a business" (the founder's own businesses that are not on the list yet),
 * every allowed business with its state and "Switch email off for this business" behind a confirm step on the page
 * (a reason is required; no browser dialog), and every switched-off business with "Allow again". One primary button in
 * each section.
 */
function allowlistSections(page: { csrf: string; commandId: string }, view: AllowlistView): string {
  const active = view.businesses.filter(b => !b.revokedAt), revoked = view.businesses.filter(b => b.revokedAt);
  const invite = view.candidates.length
    ? `<section class="card" aria-labelledby="invite"><h2 id="invite">Invite a business</h2><p>Choose one of your businesses to let its owner connect email.</p>${allowlistForm(page, 'allow', '',
      `<label for="allow-business">Business</label><select id="allow-business" name="workspace" required>${view.candidates.map(c => `<option value="${e(c.workspaceId)}">${e(c.name)}</option>`).join('')}</select><button type="submit">Allow email for this business</button>`)}</section>`
    : '<section class="card" aria-labelledby="invite"><h2 id="invite">Invite a business</h2><p>Every one of your businesses can already use email, or has been switched off below.</p></section>';
  const rows = active.map(b => `<section class="card" aria-label="${e(b.name)}"><h3>${named(b)}</h3><p>${e(allowlistState(b))}</p><p class="small">Allowed ${e(b.allowedByName ? `by ${b.allowedByName} ` : '')}on ${e(when(b.allowedAt))}.</p>
    <details class="confirm"><summary class="button secondary">Switch email off for this business</summary><p>Nothing more will be sent through its connection from the moment you confirm. Its connection, its numbers and its history are kept, and bounces from emails it already sent are still recorded. You can allow it again later.</p>${allowlistForm(page, 'revoke', b.workspaceId,
      `<label for="reason-${e(b.workspaceId)}">Why (the owner may see this)</label><input id="reason-${e(b.workspaceId)}" name="reason" maxlength="300" required><button type="submit">Switch email off for this business</button>`)}</details></section>`).join('');
  const off = revoked.map(b => `<section class="card" aria-label="${e(b.name)}"><h3>${named(b)}</h3><p>Email switched off${b.revokedByName ? ` by ${e(b.revokedByName)}` : ''} on ${e(when(b.revokedAt!))}${b.revokedReason ? `: ${e(b.revokedReason)}` : '.'}</p><p class="small">${e(allowlistState(b))} Nothing is sent through its connection while it is switched off.</p>${allowlistForm(page, 'reallow', b.workspaceId, '<button type="submit">Allow again</button>')}</section>`).join('');
  return `<h2>Who can use email</h2>${invite}${rows ? `<h2>Businesses that can use email</h2>${rows}` : ''}${off ? `<h2>Switched off</h2>${off}` : ''}`;
}

/** The founder's page: one line per business that needs a decision, the numbers, and one button each. */
export function renderFounderProtectionPage(page: { status: ProtectionStatus; today: FounderToday; csrf: string; commandId: string; message?: SendingResult | AllowlistResult;
  /** 0157's allow-list; absent (0157 not applied): the page is exactly as before. */
  allowlist?: AllowlistView }): string {
  const { status, today } = page;
  const actionFor = (line: FounderLine): { action: string; label: string } | null => ({ paused: { action: 'lift', label: 'Lift the pause' },
    switched_off: { action: 'reinstate', label: 'Switch email back on' }, go_live_requested: { action: 'approve', label: 'Approve' },
    sample_held: { action: 'release_sample', label: 'Let the rest go' }, account_held: { action: 'lift_account', label: 'Lift the hold for everyone' } } as Record<string, { action: string; label: string }>)[line.kind] ?? null;
  const items = today.lines.map(line => {
    const business = line.workspaceId ? status.businesses.find(b => b.workspaceId === line.workspaceId) : undefined;
    const act = actionFor(line);
    const version = line.kind === 'account_held' ? status.account.rowVersion : business?.rowVersion ?? 0;
    const c = business?.counts;
    const numbers = c ? `<p class="small">Last 7 days: ${c.sends7} sent, ${bounces7(c)} bounced${c.sends7 ? ` (${percent(bounces7(c), c.sends7)})` : ''}. Last 30 days: ${c.complaints30} spam ${c.complaints30 === 1 ? 'report' : 'reports'}. Own pauses in the last 90 days: ${c.ownPauses90}.</p>` : '';
    // A go-live request: who, from where, what was already checked (the database refuses a request without each of
    // these), and one Approve. There is no Decline: a request simply waits until it is approved.
    const request = line.kind === 'go_live_requested' && business ? `<dl class="facts"><dt>Business</dt><dd>${e(business.businessName)}</dd>
      <dt>Sending from</dt><dd>${e(business.domain ?? 'their connected domain')}</dd>
      ${business.goLiveRequestedAt ? `<dt>Asked</dt><dd>${e(when(business.goLiveRequestedAt))}</dd>` : ''}
      <dt>Test email</dt><dd>Accepted for sending since the records were last found (a request can’t be made without it)</dd></dl>` : '';
    const note = line.kind === 'paused' ? '<p class="small">Lifting restarts their marketing emails slowed (half their daily limit), with their next 50 emails sent first and checked. Only what happens from now counts. Another pause within 90 days can switch them off: once at least 50 more of their emails have gone, and always on a third pause.</p>'
      : line.kind === 'switched_off' ? '<p class="small">Switching back on restarts them slowed, with their next 50 emails sent first and checked.</p>'
      : line.kind === 'go_live_requested' ? '<p class="small">Approving approves this domain only. Both records are verified, the bounce webhook is verified, a test was accepted for sending and the current email rules are ticked. A first go-live, or a new domain, starts at 50 marketing emails a day. The owner is emailed when you approve, if they have an address we can send to.</p>' : '';
    return `<article class="card ${line.tone === 'red' ? 'alert' : 'notice'}"><p><strong>${e(line.sentence)}</strong></p>${request}${numbers}${note}${act ? founderButton(page, act.action, line.kind === 'account_held' ? '' : line.workspaceId ?? '', version, act.label) : ''}</article>`;
  }).join('');
  const message = page.message ? `<section class="card ${page.message.ok ? 'ok' : 'notice'}" role="${page.message.ok ? 'status' : 'alert'}"><p>${e(page.message.message)}</p></section>` : '';
  const undelivered = status.undelivered?.length ? `<section class="card notice"><p><strong>${status.undelivered.length === 1 ? '1 alert email' : `${status.undelivered.length} alert emails`} could not be sent in the last 30 days</strong>, so ${status.undelivered.length === 1 ? 'it is' : 'they are'} shown here instead:</p><ul>${status.undelivered.map(u => `<li>${e(UNDELIVERED[u.kind] ?? 'An email protection step')} (to ${u.audience === 'owner' ? 'the business owner' : 'you'}), ${e(new Date(u.at).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long' }))}</li>`).join('')}</ul></section>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email protection</title><style>body{margin:0;background:#f4f3ef;color:#172b30;font:17px/1.65 system-ui,sans-serif}main{max-width:860px;margin:auto;padding:24px}h1{font:clamp(30px,5vw,42px)/1.15 Georgia,serif}.card{background:#fff;border:1px solid #d2dbdb;border-radius:18px;padding:24px;margin:0 0 18px}.alert{border-left:4px solid #9c2f14;background:#fdf1ec}.notice{border-left:4px solid #bd8a31;background:#faf3e5}.ok{border-left:4px solid #2f7d55;background:#eef7f1}.small{font-size:15px;color:#465b60}.facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:12px 0}.facts dt{font-weight:700}.facts dd{margin:0;overflow-wrap:anywhere}button{padding:14px 20px;border:0;border-radius:9px;background:#f2b440;color:#172b30;font:700 17px/1.4 system-ui;cursor:pointer}button:focus-visible{outline:3px solid #83510c;outline-offset:3px}${page.allowlist ? ALLOWLIST_STYLE : ''}@media(max-width:520px){main{padding:16px}.facts{grid-template-columns:1fr}button{width:100%}}</style></head><body><main>${message}<h1>Email protection</h1>${undelivered}${items || '<section class="card"><p>Nothing needs you. Every business is sending within our lines.</p></section>'}${page.allowlist ? allowlistSections(page, page.allowlist) : ''}<p class="small"><a href="${EMAIL_CONNECTION_ROUTE}">Back to email</a></p></main></body></html>`;
}
