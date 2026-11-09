/**
 * Attendee-facing pages, branded from the owning workspace. Nothing here shows an
 * invented audience number, chat or live presenter: recorded sessions are always
 * labelled as recordings, and every state says exactly what is happening.
 */

import { accentPalette, type AccentPalette } from './colour.js';
import { formatInZone } from './schedule.js';
import { KIND_LABEL, type WebinarBrand, type WebinarEvent } from './types.js';

export const PUBLIC_ASSET_ROOM = '/w/_assets/room.js';
export const PUBLIC_ASSET_HLS = '/w/_assets/hls.js';

export const PUBLIC_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: https:; "
  + "media-src 'self' blob: https://*.cloudflarestream.com https://*.videodelivery.net; connect-src 'self' https://*.cloudflarestream.com https://*.videodelivery.net; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
/** Owner preview inside the portal: no scripts, no form submission. */
export const PUBLIC_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

function e(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function accent(event: WebinarEvent, brand: WebinarBrand): AccentPalette {
  return accentPalette(event.settings.accentColor ?? brand.accentColor ?? brand.primaryColor);
}

function brandName(brand: WebinarBrand): string {
  return brand.productName ?? brand.workspaceName;
}

function shell(title: string, event: WebinarEvent, brand: WebinarBrand, body: string, opts: { script?: boolean; robots?: boolean } = {}): string {
  const a = accent(event, brand);
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)} · ${e(brandName(brand))}</title>${opts.robots ? '' : '<meta name="robots" content="noindex,nofollow">'}
<meta property="og:title" content="${e(event.title)}"><meta property="og:description" content="${e(event.summary.slice(0, 200))}">
<style>
:root{--accent:${e(a.accent)};--on-accent:${e(a.onAccent)};--accent-text:${e(a.textOnLight)};--ink:#111827;--muted:#5b6474;--line:#e3e6eb;--bg:#f6f7f9;--panel:#fff}
@media (prefers-color-scheme:dark){:root{--accent-text:${e(a.textOnDark)};--ink:#eef0f4;--muted:#a3abb9;--line:#2a2f3a;--bg:#0e1015;--panel:#161922}}
*{box-sizing:border-box}[hidden]{display:none!important}html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent-text)}header.top{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel)}
header.top strong{color:var(--accent-text);font-size:1.05rem}main{max-width:1120px;margin:0 auto;padding:24px 16px 64px}
.kicker{display:inline-flex;gap:6px;align-items:center;font-size:.74rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--accent-text);margin-bottom:8px}
h1{font-size:clamp(1.6rem,1.1rem + 2.2vw,2.5rem);line-height:1.15;margin:0 0 10px;letter-spacing:-.015em}
.grid{display:grid;gap:28px;grid-template-columns:1fr}@media(min-width:880px){.grid{grid-template-columns:1.15fr 1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;box-shadow:0 10px 30px -18px rgba(0,0,0,.25)}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.pill{display:inline-flex;gap:6px;align-items:center;padding:5px 11px;border-radius:999px;border:1px solid var(--line);font-size:.86rem;font-weight:600;background:var(--panel)}
.muted{color:var(--muted)}.small{font-size:.88rem}label{display:block;font-weight:600;margin:14px 0 6px;font-size:.92rem}
input,select,textarea{width:100%;font:inherit;padding:11px 13px;border:1.5px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink)}
input:focus,select:focus,textarea:focus{outline:3px solid color-mix(in srgb,var(--accent) 35%,transparent);border-color:var(--accent)}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:400}.check input{width:20px;height:20px;margin-top:3px;flex:none;accent-color:var(--accent)}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-weight:700;padding:12px 20px;min-height:46px;border-radius:10px;border:0;background:var(--accent);color:var(--on-accent);text-decoration:none;cursor:pointer}
button.secondary,.btn.secondary{background:transparent;color:var(--ink);border:1.5px solid var(--line)}button:disabled{opacity:.55;cursor:not-allowed}
button:focus-visible,.btn:focus-visible,a:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:2px}
.notice{padding:12px 14px;border-radius:10px;background:color-mix(in srgb,var(--accent) 10%,var(--panel));border:1px solid color-mix(in srgb,var(--accent) 35%,transparent);margin:0 0 16px}
.alert{padding:12px 14px;border-radius:10px;background:#fde8e8;color:#8a1c1c;margin:0 0 16px}.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.presenter{display:flex;gap:12px;align-items:center;margin-top:16px}.avatar{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;font-weight:800;color:var(--on-accent);background:var(--accent)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
</style></head><body><header class="top"><strong>${e(brandName(brand))}</strong>${brand.supportEmail ? `<a class="small" href="mailto:${e(brand.supportEmail)}">Contact</a>` : ''}</header>
<main id="main">${body}</main>${opts.script ? `<script src="${PUBLIC_ASSET_ROOM}?v=native-recovery-1" defer></script>` : ''}</body></html>`;
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '•';
}

function eventIntro(ev: WebinarEvent): string {
  const startLine = ev.kind === 'on_demand' || !ev.startsAt ? '<span class="pill">Watch any time</span>'
    : `<span class="pill"><time datetime="${e(ev.startsAt)}" data-local-time>${e(formatInZone(ev.startsAt, ev.timezone))}</time></span>`;
  return `<span class="kicker">${e(KIND_LABEL[ev.kind])}</span><h1>${e(ev.title)}</h1>
<div class="meta">${startLine}<span class="pill">${ev.durationMinutes} minutes</span>${ev.kind === 'scheduled_recording' ? '<span class="pill">Recorded presentation</span>' : ''}</div>
${ev.summary ? `<p style="white-space:pre-line">${e(ev.summary)}</p>` : ''}
${ev.presenterName ? `<div class="presenter"><span class="avatar" aria-hidden="true">${e(initials(ev.presenterName))}</span><div><strong>${e(ev.presenterName)}</strong>${ev.presenterTitle ? `<div class="muted small">${e(ev.presenterTitle)}</div>` : ''}</div></div>` : ''}`;
}

export interface RegistrationPageInput {
  readonly event: WebinarEvent;
  readonly brand: WebinarBrand;
  readonly registered: number;
  readonly preview: boolean;
  readonly error: string | null;
  readonly values: Record<string, string>;
  readonly nowMs: number;
  /** Already registered in this browser: offer the room instead of the form. */
  readonly roomPath?: string | null;
}

export function registrationPage(input: RegistrationPageInput): string {
  const ev = input.event;
  const s = ev.settings;
  const v = (k: string) => e(input.values[k] ?? '');
  const ended = ev.kind !== 'on_demand' && ev.startsAt !== null && Date.parse(ev.startsAt) + ev.durationMinutes * 60_000 <= input.nowMs;
  const full = ev.capacity !== null && input.registered >= ev.capacity;
  const closed = ev.status === 'cancelled' ? 'This webinar has been cancelled.'
    : full ? 'This webinar is full.'
    : ended && !s.replay.enabled ? 'This webinar has finished.' : null;
  const questions = s.questions.map((q) => q.type === 'select'
    ? `<label for="${q.id}">${e(q.label)}${q.required ? '' : ' <span class="muted">(optional)</span>'}</label><select id="${q.id}" name="${q.id}"${q.required ? ' required' : ''}><option value="">Choose…</option>${q.options.map((o) => `<option${input.values[q.id] === o ? ' selected' : ''}>${e(o)}</option>`).join('')}</select>`
    : `<label for="${q.id}">${e(q.label)}${q.required ? '' : ' <span class="muted">(optional)</span>'}</label><input id="${q.id}" name="${q.id}" maxlength="500" value="${v(q.id)}"${q.required ? ' required' : ''}>`).join('');
  const attribution = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'referrerHost'].map((k) => input.values[k] ? `<input type="hidden" name="${k}" value="${v(k)}">` : '').join('');
  const form = input.roomPath
    ? `<div class="card"><h2 style="margin-top:0">You're registered</h2><p>This browser is already registered for this webinar.</p><a class="btn" href="${e(input.roomPath)}">Go to the webinar room</a></div>`
    : closed ? `<div class="card"><h2 style="margin-top:0">${e(closed)}</h2>${input.brand.supportEmail ? `<p class="muted">Questions? <a href="mailto:${e(input.brand.supportEmail)}">${e(input.brand.supportEmail)}</a></p>` : ''}</div>`
    : `<form class="card" method="post" action="/w/${e(ev.publicKey)}/register" novalidate>
<h2 style="margin-top:0">${ended ? 'Watch the replay' : ev.kind === 'on_demand' ? 'Get instant access' : 'Save your seat'}</h2>
${input.error ? `<p class="alert" role="alert">${e(input.error)}</p>` : ''}
<label for="name">Your name</label><input id="name" name="name" autocomplete="name" required maxlength="120" value="${v('name')}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="320" value="${v('email')}">
${questions}${attribution}
<div class="hp" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
<p class="small muted" style="margin-top:16px">${e(s.serviceNotice)}${s.privacyUrl ? ` <a href="${e(s.privacyUrl)}" target="_blank" rel="noopener">Privacy policy</a>` : ''}</p>
${s.marketingConsentText ? `<label class="check small"><input type="checkbox" name="marketing" value="1"${input.values.marketing === '1' ? ' checked' : ''}> <span>${e(s.marketingConsentText)} <span class="muted">(optional)</span></span></label>` : ''}
<div style="margin-top:18px"><button type="submit"${input.preview ? ' disabled' : ''}>Register</button></div>
<p class="small muted" style="margin-top:14px">Already registered? <a href="/w/${e(ev.publicKey)}/link">Get your link again</a></p></form>`;
  const body = `${input.preview ? '<p class="notice" role="note"><strong>Owner preview.</strong> This is how the registration page looks. The form is disabled here.</p>' : ''}
<div class="grid"><section>${eventIntro(ev)}</section><section>${form}</section></div>`;
  return shell(ev.title, ev, input.brand, body, { script: !input.preview, robots: ev.status === 'published' && !input.preview });
}

export function messagePage(event: WebinarEvent, brand: WebinarBrand, title: string, message: string, action?: { href: string; label: string }): string {
  return shell(title, event, brand, `<div class="card" style="max-width:640px;margin:20px auto"><span class="kicker">${e(event.title)}</span><h1>${e(title)}</h1><p>${e(message)}</p>
${action ? `<p><a class="btn" href="${e(action.href)}">${e(action.label)}</a></p>` : ''}</div>`);
}

export function confirmationPage(input: { event: WebinarEvent; brand: WebinarBrand; roomPath: string; calendarPath: string | null; /** True only when this brand can actually deliver the link by email right now. */ emailed: boolean; nowMs: number }): string {
  const ev = input.event;
  const soon = ev.kind === 'on_demand' || (ev.startsAt !== null && Date.parse(ev.startsAt) - ev.settings.roomOpensMinutesBefore * 60_000 <= input.nowMs);
  return shell("You're registered", ev, input.brand, `<div class="card" style="max-width:680px;margin:20px auto">
<span class="kicker">${e(KIND_LABEL[ev.kind])}</span><h1>You're registered</h1>
<p><strong>${e(ev.title)}</strong>${ev.startsAt && ev.kind !== 'on_demand' ? ` · <time datetime="${e(ev.startsAt)}" data-local-time>${e(formatInZone(ev.startsAt, ev.timezone))}</time>` : ''}</p>
<p>${input.emailed ? "We've emailed your personal link. Keep it — it's how you get back into the room on any device." : 'Bookmark this page: this browser can open the room. If you lose it, use "Get your link again" on the webinar page.'}</p>
<p style="display:flex;gap:10px;flex-wrap:wrap"><a class="btn" href="${e(input.roomPath)}">${soon ? 'Enter the room now' : 'Open the waiting room'}</a>${input.calendarPath ? `<a class="btn secondary" href="${e(input.calendarPath)}">Add to calendar</a>` : ''}</p></div>`, { script: true });
}

export function accessLinkPage(event: WebinarEvent, brand: WebinarBrand, sent: boolean): string {
  return shell('Get your link', event, brand, `<form class="card" method="post" action="/w/${e(event.publicKey)}/link" style="max-width:560px;margin:20px auto">
<span class="kicker">${e(event.title)}</span><h1>Get your link again</h1>
${sent ? '<p class="notice" role="status">If that address is registered, we have emailed its personal link. Check your inbox (and spam folder).</p>' : '<p>Enter the email you registered with and we will email your personal link.</p>'}
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="320">
<div class="hp" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off"></div>
<p style="margin-top:16px"><button type="submit">Email my link</button></p></form>`);
}

export function roomPage(input: { event: WebinarEvent; brand: WebinarBrand; attendeeName: string }): string {
  const ev = input.event;
  const key = e(ev.publicKey);
  return shell(ev.title, ev, input.brand, `<style>
.room{display:grid;gap:18px;grid-template-columns:1fr}@media(min-width:960px){.room{grid-template-columns:minmax(0,1fr) 340px}}
.stage{position:relative;background:#000;border-radius:14px;overflow:hidden;aspect-ratio:16/9}.stage video{width:100%;height:100%;display:block;background:#000}
.stage .over{position:absolute;inset:0;display:grid;place-items:center;text-align:center;color:#fff;padding:20px;background:radial-gradient(ellipse at center,rgba(0,0,0,.35),rgba(0,0,0,.8))}
.stage .over[hidden]{display:none}.big{font-size:clamp(1.8rem,5vw,3rem);font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.state{display:inline-flex;gap:7px;align-items:center;font-size:.76rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase;padding:4px 10px;border-radius:999px;background:var(--line)}
.state.live{background:#dc2626;color:#fff}.state.live::before{content:'';width:7px;height:7px;border-radius:50%;background:#fff}
.cta{margin-top:16px;border-left:5px solid var(--accent)}.qa{display:flex;flex-direction:column;max-height:70vh}.qa ul{list-style:none;padding:0;margin:0;overflow:auto;flex:1}
.qa li{padding:10px 0;border-bottom:1px solid var(--line)}.qa li .ans{margin-top:6px;padding-left:10px;border-left:3px solid var(--accent);color:var(--muted)}
</style>
<div data-room data-key="${key}" data-kind="${e(ev.kind)}">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:12px"><div><h1 style="font-size:1.45rem;margin:0">${e(ev.title)}</h1>
<p class="muted small" style="margin:4px 0 0">Welcome, ${e(input.attendeeName)}.</p></div><span class="state" data-state-label role="status">Loading…</span></div>
<div class="room"><section>
<div class="stage"><video data-video playsinline preload="none" aria-label="${e(ev.title)}"></video>
<div class="over" data-overlay><div><p data-state-message style="margin:0 0 10px;font-size:1.05rem">Checking the session…</p><div class="big" data-countdown aria-live="off"></div>
<button type="button" data-play hidden style="margin-top:14px">▶ Start watching</button></div></div></div>
<p class="small muted" data-note style="margin-top:8px"></p>
<div class="card cta" data-cta hidden><p style="margin:0 0 4px"><strong data-cta-label></strong></p><p class="small muted" data-cta-body style="margin:0 0 12px"></p>
<a class="btn" data-cta-link target="_blank" rel="noopener">Continue</a></div>
${ev.presenterName ? `<div class="presenter"><span class="avatar" aria-hidden="true">${e(initials(ev.presenterName))}</span><div><strong>${e(ev.presenterName)}</strong>${ev.presenterTitle ? `<div class="muted small">${e(ev.presenterTitle)}</div>` : ''}</div></div>` : ''}
</section>
${ev.settings.questionsEnabled ? `<aside class="card qa" aria-label="Questions"><h2 style="margin:0 0 4px;font-size:1.1rem">Questions</h2>
<p class="small muted" style="margin:0 0 10px">${ev.settings.questionsModerated ? 'Questions appear for everyone once the host approves them. You always see your own.' : 'Your question is shared with everyone in the room.'}</p>
<ul data-questions aria-live="polite"></ul><form data-ask style="margin-top:10px"><label class="sr" for="ask">Your question</label>
<textarea id="ask" name="body" maxlength="500" rows="2" placeholder="Ask a question" required></textarea><p class="small muted" data-ask-status role="status" style="margin:6px 0"></p><button type="submit">Send question</button></form></aside>` : ''}
</div></div>`, { script: true });
}
