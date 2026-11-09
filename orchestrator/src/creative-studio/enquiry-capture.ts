/**
 * Brand enquiry capture for Creative Studio campaigns (0144 section 6). A visitor arriving from a tracked link fills a
 * short form (hosted, or embedded on the brand's own page); the lead is created by the existing CRM command
 * (crm.createLead) acting as the owner who switched capture on, in the brand's own pipeline. The UTM values are
 * untrusted: they are shape-checked here, bound to the form by an HMAC token, and stored as a campaign touch only when
 * SQL finds the exact tracked link this brand issued. No personal data ever goes into a URL.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import type { CrmCommandService } from '../crm-pg/commands.js';
import { requestDatabaseContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import { escapeHtml as e } from '../portal/ui.js';

export const ENQUIRY_ROUTE = '/enquire';
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'] as const;
export type Utm = Partial<Record<typeof UTM_KEYS[number], string>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY = /^[a-f0-9]{24}$/u;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
export const ENQUIRY_LIMITS = Object.freeze({ perHour: 50, tokenSeconds: 3600 });

/** Untrusted UTM evidence: only the four keys, only a conservative shape; anything else is dropped. */
export function parseUtm(params: URLSearchParams): Utm {
  const out: Utm = {};
  for (const k of UTM_KEYS) { const v = params.get(k); if (v && /^[a-z0-9_-]{1,60}$/u.test(v)) out[k] = v; }
  return out;
}
const utmText = (u: Utm) => UTM_KEYS.map((k) => `${k}=${u[k] ?? ''}`).join('&');

export function enquiryToken(secret: string, ws: string, key: string, utm: Utm, now = Date.now()): string {
  const body = `${Math.floor(now / 1000)}.${randomBytes(16).toString('hex')}`;
  return `${body}.${createHmac('sha256', secret).update(`creative-enquiry:${ws}:${key}:${utmText(utm)}:${body}`).digest('hex')}`;
}
/** Valid for one hour, for this brand form and these exact UTM values. Returns the nonce. */
export function verifyEnquiryToken(secret: string, ws: string, key: string, utm: Utm, token: string, now = Date.now()): string | null {
  if (!/^\d{10}\.[a-f0-9]{32}\.[a-f0-9]{64}$/u.test(token)) return null;
  const [stamp, nonce, mac] = token.split('.'), age = now / 1000 - Number(stamp);
  const expected = createHmac('sha256', secret).update(`creative-enquiry:${ws}:${key}:${utmText(utm)}:${stamp}.${nonce}`).digest();
  return age >= 0 && age < ENQUIRY_LIMITS.tokenSeconds && timingSafeEqual(expected, Buffer.from(mac!, 'hex')) ? nonce! : null;
}

export interface EnquiryTarget { readonly brandName: string; readonly privacyUrl: string; readonly ownerUserId: string; readonly pipelineId: string; readonly stageId: string; readonly recentHour: number }
export interface EnquiryInput { readonly name: string; readonly email: string; readonly phone: string; readonly message: string }
export interface EnquiryOutcome { readonly contactId: string; readonly opportunityId: string; readonly replayed: boolean; readonly touch: { recorded: boolean; reason?: string } }
export class EnquiryError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export class PgEnquiryCapture {
  constructor(private readonly deps: { readonly contentPool: Pick<Pool, 'connect'>; readonly crm: Pick<CrmCommandService, 'createLead'> }) {}

  async target(ws: string, key: string, requestId: string): Promise<EnquiryTarget | null> {
    if (!UUID.test(ws) || !KEY.test(key)) return null;
    return withTransaction(this.deps.contentPool, { actorKind: 'webhook', workspaceId: ws, requestId }, async (t) =>
      (await t.query<{ v: EnquiryTarget | null }>('SELECT app_private.creative_studio_capture_target($1,$2) AS v', [ws, key])).rows[0]?.v ?? null, { readOnly: true });
  }

  async capture(ws: string, key: string, nonce: string, input: EnquiryInput, utm: Utm, requestId: string): Promise<EnquiryOutcome> {
    const target = await this.target(ws, key, requestId);
    if (!target) throw new EnquiryError(404, 'This enquiry form is not available.');
    // Idempotent per form submission: a double click or refresh re-sends the same nonce and replays the same lead.
    const commandKey = `creative.enquiry.${sha(`${ws}:${key}:${nonce}`)}`;
    const context = requestDatabaseContext({ workspaceId: ws, userId: target.ownerUserId, requestId });
    if (target.recentHour >= ENQUIRY_LIMITS.perHour) throw new EnquiryError(429, 'Too many enquiries have been sent just now. Please try again later.');
    const lead = await this.deps.crm.createLead(context, {
      commandKey, displayName: input.name, source: 'creative_studio_enquiry', ownerUserId: target.ownerUserId,
      contactPoints: [{ kind: 'email', value: input.email, isPrimary: true, consentStatus: 'unknown' },
        ...(input.phone ? [{ kind: 'phone' as const, value: input.phone, isPrimary: false, consentStatus: 'unknown' as const }] : [])],
      pipelineId: target.pipelineId, stageId: target.stageId, opportunityName: `Website enquiry · ${input.name}`.slice(0, 200), valueMinor: 0, currency: 'GBP',
      task: { title: 'Reply to the website enquiry', description: input.message },
    });
    const touch = await withTransaction(this.deps.contentPool, context, async (t) => (await t.query<{ v: { recorded: boolean; reason?: string } }>(
      'SELECT app_private.creative_studio_record_touch($1,$2) AS v', [ws, JSON.stringify({ commandKey, utmSource: utm.utm_source ?? null, utmMedium: utm.utm_medium ?? null,
        utmCampaign: utm.utm_campaign ?? null, utmContent: utm.utm_content ?? null })])).rows[0]!.v);
    return { contactId: lead.contactId, opportunityId: lead.opportunityId, replayed: lead.disposition === 'replayed', touch };
  }
}

export function enquiryInput(form: URLSearchParams): EnquiryInput {
  const field = (k: string, max: number) => (form.get(k) ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim().slice(0, max);
  const name = field('name', 200), email = field('email', 254).toLowerCase(), phone = field('phone', 40), message = field('message', 2000);
  if (!name) throw new EnquiryError(400, 'Please add your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(email)) throw new EnquiryError(400, 'Please add a valid email address.');
  if (phone && !/^\+?[0-9 ()-]{6,40}$/u.test(phone)) throw new EnquiryError(400, 'Please check the phone number, or leave it empty.');
  if (!message) throw new EnquiryError(400, 'Please tell us briefly what you need.');
  if (form.get('consent') !== 'yes') throw new EnquiryError(400, 'Please confirm that we may contact you about this enquiry.');
  return { name, email, phone, message };
}

export function enquiryPage(input: { brandName: string; privacyUrl: string; action: string; token: string; utm: Utm; embed: boolean; received?: boolean; error?: string }): string {
  const hidden = UTM_KEYS.filter((k) => input.utm[k]).map((k) => `<input type="hidden" name="${k}" value="${e(input.utm[k]!)}">`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>Enquiry · ${e(input.brandName)}</title><style>
*{box-sizing:border-box}body{margin:0;background:${input.embed ? '#fff' : '#f5f6f8'};color:#16202a;font:16px/1.5 system-ui,sans-serif}main{max-width:560px;margin:${input.embed ? '0' : '40px'} auto;padding:24px;background:#fff;border:${input.embed ? '0' : '1px solid #dde2e8'};border-radius:14px}
h1{font-size:24px;margin:0 0 6px}p{color:#4b5866;margin:0 0 16px}label{display:block;font-weight:600;font-size:14px;margin:12px 0 4px}input,textarea{width:100%;padding:11px;border:1px solid #b9c2cc;border-radius:8px;font:inherit}textarea{min-height:110px}
.check{display:flex;gap:9px;font-weight:400;align-items:flex-start}.check input{width:18px;margin-top:4px}.hp{position:absolute;left:-9999px}button{margin-top:16px;width:100%;padding:13px;border:0;border-radius:9px;background:#1f3a8a;color:#fff;font:700 16px system-ui;cursor:pointer}
.err{background:#fde8e8;color:#8a1c1c;padding:10px 12px;border-radius:8px}a{color:inherit}:focus-visible{outline:3px solid #f59e0b;outline-offset:2px}@media(max-width:600px){main{margin:${input.embed ? "0" : "16px"}}}</style></head><body><main>
<p>${e(input.brandName)}</p>${input.received ? '<h1 role="status">Thank you — your enquiry was sent.</h1><p>We will reply using the details you gave.</p>' : `<h1>Send an enquiry</h1><p>Tell us what you need and how to reach you.</p>
${input.error ? `<p class="err" role="alert">${e(input.error)}</p>` : ''}<form method="post" action="${e(input.action)}"><input type="hidden" name="token" value="${e(input.token)}">${hidden}
<label class="hp" aria-hidden="true">Leave empty<input name="website" tabindex="-1" autocomplete="off"></label>
<label for="q-name">Your name</label><input id="q-name" name="name" autocomplete="name" maxlength="200" required>
<label for="q-email">Email address</label><input id="q-email" name="email" type="email" autocomplete="email" maxlength="254" required>
<label for="q-phone">Phone (optional)</label><input id="q-phone" name="phone" type="tel" autocomplete="tel" maxlength="40">
<label for="q-msg">How can we help?</label><textarea id="q-msg" name="message" maxlength="2000" required></textarea>
<label class="check"><input type="checkbox" name="consent" value="yes" required><span>Please contact me about this enquiry. I have read the <a href="${e(input.privacyUrl)}" target="_blank" rel="noopener noreferrer">privacy notice</a>.</span></label>
<button type="submit">Send enquiry</button></form>`}</main></body></html>`;
}

/** Embed snippet for the brand's own page: forwards only shape-checked UTM values from that page's address into the frame. */
export function enquiryEmbedSnippet(origin: string, ws: string, key: string): string {
  const src = `${origin}${ENQUIRY_ROUTE}/${ws}/${key}?embed=1`;
  return `<div id="brand-enquiry"></div>\n<script>(function(){var u=new URL(${JSON.stringify(src)}),p=new URLSearchParams(location.search);["utm_source","utm_medium","utm_campaign","utm_content"].forEach(function(k){var v=p.get(k);if(v&&/^[a-z0-9_-]{1,60}$/.test(v))u.searchParams.set(k,v)});var f=document.createElement("iframe");f.src=u.toString();f.title="Enquiry form";f.loading="lazy";f.style.cssText="width:100%;max-width:560px;height:720px;border:0";document.getElementById("brand-enquiry").appendChild(f)})();</script>`;
}

export async function handleEnquiryPublic(req: IncomingMessage, res: ServerResponse, capture: PgEnquiryCapture, secret: string, requestId: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost'), [, , ws = '', key = ''] = url.pathname.split('/');
  const embed = url.searchParams.get('embed') === '1';
  const respond = (status: number, body: string) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'${embed ? '' : "; frame-ancestors 'none'"}` });
    res.end(body);
  };
  const unavailable = () => respond(404, enquiryPage({ brandName: 'Enquiry', privacyUrl: '#', action: '#', token: '', utm: {}, embed, received: false, error: 'This enquiry form is not available.' }).replace(/<form[\s\S]*<\/form>/u, ''));
  if (!UUID.test(ws) || !KEY.test(key)) return unavailable();
  const target = await capture.target(ws, key, requestId).catch(() => null);
  if (!target) return unavailable();
  const action = `${ENQUIRY_ROUTE}/${ws}/${key}${embed ? '?embed=1' : ''}`;
  if (req.method === 'GET') {
    const utm = parseUtm(url.searchParams);
    return respond(200, enquiryPage({ brandName: target.brandName, privacyUrl: target.privacyUrl, action, token: enquiryToken(secret, ws, key, utm), utm, embed }));
  }
  if (req.method !== 'POST') return respond(405, 'Method unavailable.');
  if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return respond(415, 'Use the enquiry form.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += (chunk as Buffer).length; if (size > 16_384) return respond(413, 'The enquiry is too long.'); chunks.push(chunk as Buffer); }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const utm = parseUtm(form);
  const nonce = verifyEnquiryToken(secret, ws, key, utm, form.get('token') ?? '');
  const again = (status: number, error: string) => respond(status, enquiryPage({ brandName: target.brandName, privacyUrl: target.privacyUrl, action, token: enquiryToken(secret, ws, key, utm), utm, embed, error }));
  if (!nonce) return again(400, 'This form expired. Please send it again.');
  if (form.get('website')) return respond(200, enquiryPage({ brandName: target.brandName, privacyUrl: target.privacyUrl, action, token: '', utm: {}, embed, received: true }));
  try {
    await capture.capture(ws, key, nonce, enquiryInput(form), utm, requestId);
    return respond(200, enquiryPage({ brandName: target.brandName, privacyUrl: target.privacyUrl, action, token: '', utm: {}, embed, received: true }));
  } catch (error) {
    if (error instanceof EnquiryError) return again(error.status, error.message);
    return again(503, 'The enquiry could not be sent just now. Please try again shortly.');
  }
}
