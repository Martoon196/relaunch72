import { MHP_AUTH_ORIGIN, normalizeMhpEmail, type MhpAuthPurpose } from './auth-service.js';

export interface MhpTransactionalMailer {
  readonly configured: boolean;
  sendAuthLink(email: string, url: string, purpose: MhpAuthPurpose): Promise<void>;
  sendAccessInvite(email: string, name: string, product: string): Promise<void>;
  /** MHP009B: requested event-reminder email proof. Separate from auth links; creates no account. */
  sendEventPhoneLink?(email: string, url: string, startsAt: string): Promise<void>;
}

const escape = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/** Org-scoped transactional delivery only. It never consults the PP/Brevo marketing credentials. */
export function createMhpTransactionalMailer(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): MhpTransactionalMailer {
  const provider = env.MHP_TRANSACTIONAL_PROVIDER?.trim()
    || (env.MHP_BREVO_API_KEY && !env.MHP_POSTMARK_SERVER_TOKEN ? 'brevo' : env.MHP_POSTMARK_SERVER_TOKEN && !env.MHP_BREVO_API_KEY ? 'postmark' : '');
  const senderId = Number(env.MHP_BREVO_SENDER_ID ?? '1');
  const brevoKey = env.MHP_BREVO_API_KEY?.trim();
  const postmarkKey = env.MHP_POSTMARK_SERVER_TOKEN?.trim();
  const from = normalizeMhpEmail(env.MHP_POSTMARK_FROM ?? '');
  const configured = provider === 'brevo' ? Boolean(brevoKey && Number.isSafeInteger(senderId) && senderId > 0)
    : provider === 'postmark' ? Boolean(postmarkKey && from) : false;
  let inFlight = 0;
  const deliver = async (email: string, subject: string, plain: string, html: string, tag: string): Promise<void> => {
    if (!configured) throw new Error('MHP transactional email is not configured');
    const endpoint = provider === 'brevo' ? 'https://api.brevo.com/v3/smtp/email' : 'https://api.postmarkapp.com/email';
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    const payload = provider === 'brevo'
      ? { sender: { id: senderId }, to: [{ email }], subject, textContent: plain, htmlContent: html, tags: [tag], headers: { 'X-Mailin-Track': '0' } }
      : { From: from, To: email, Subject: subject, TextBody: plain, HtmlBody: html, MessageStream: 'outbound', TrackOpens: false, TrackLinks: 'None', Tag: tag };
    if (provider === 'brevo') headers['api-key'] = brevoKey!;
    else headers['X-Postmark-Server-Token'] = postmarkKey!;
    if (inFlight >= 8) throw new Error('MHP transactional delivery unavailable');
    inFlight += 1;
    try {
      const response = await fetcher(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('MHP transactional delivery unavailable'); }
      await response.body?.cancel();
    } catch { throw new Error('MHP transactional delivery unavailable'); }
    finally { inFlight -= 1; }
  };
  return Object.freeze({
    configured,
    async sendAuthLink(email: string, url: string, purpose: MhpAuthPurpose): Promise<void> {
      if (!configured) throw new Error('MHP transactional email is not configured');
      const target = new URL(url);
      if (!normalizeMhpEmail(email) || target.origin !== MHP_AUTH_ORIGIN || target.pathname !== '/portal/auth/verify'
        || (purpose !== 'magic' && purpose !== 'reset')) throw new Error('Invalid MHP authentication mail');
      const action = purpose === 'reset' ? 'Set your password' : 'Sign in to Your Desk';
      const subject = purpose === 'reset' ? 'Set your Martin Howard Property password' : 'Your Martin Howard Property sign-in link';
      const text = `${action}\n\n${url}\n\nThis link expires in 15 minutes and can be used once. If you did not request it, you can ignore this email.\n\nMartin Howard Property\nmartin@propinvestuk.co.uk`;
      const html = `<div style="background:#f3f3ee;padding:32px;font-family:Arial,sans-serif;color:#142019"><div style="max-width:560px;margin:auto;background:#fff;border-radius:20px;padding:36px"><p style="letter-spacing:2px;font-size:12px">MARTIN HOWARD PROPERTY</p><h1 style="font-size:28px">${action}</h1><p>Your secure link is ready. It expires in 15 minutes and works once.</p><p style="margin:28px 0"><a href="${escape(url)}" style="display:inline-block;padding:14px 20px;background:#E8A33D;color:#142019;text-decoration:none;border-radius:8px;font-weight:bold">${action}</a></p><p style="font-size:13px;color:#5b665f">If you did not request this email, you can ignore it. Your account stays secure.</p><hr style="border:0;border-top:1px solid #e7ebe6"><p style="font-size:12px">Martin Howard Property · martin@propinvestuk.co.uk</p></div></div>`;
      await deliver(email, subject, text, html, 'mhp-auth');
    },
    async sendAccessInvite(email: string, name: string, product: string): Promise<void> {
      if (!normalizeMhpEmail(email) || !name || name.length > 200 || !product || product.length > 200) throw new Error('Invalid MHP invite');
      const link = `${MHP_AUTH_ORIGIN}/portal/auth/magic`;
      const subject = 'Your Martin Howard Property access is ready';
      const plain = `Hi ${name},\n\nMartin has opened your ${product} access. Sign in with this email address to open your training centre and Your Desk:\n${link}\n\nChoose “Email my secure link”. Your sign-in email will contain a one-time link.\n\nMartin Howard Property\nmartin@propinvestuk.co.uk`;
      const html = `<div style="background:#f3f3ee;padding:32px;font-family:Arial,sans-serif;color:#142019"><div style="max-width:560px;margin:auto;background:#fff;border-radius:20px;padding:36px"><p style="letter-spacing:2px;font-size:12px">MARTIN HOWARD PROPERTY</p><h1 style="font-size:28px">Your access is ready.</h1><p>Hi ${escape(name)}, Martin has opened your ${escape(product)} access.</p><p>Use this email address to open your training centre and Your Desk. We’ll send you a private sign-in link.</p><p style="margin:28px 0"><a href="${link}" style="display:inline-block;padding:14px 20px;background:#E8A33D;color:#142019;text-decoration:none;border-radius:8px;font-weight:bold">Open my workspace</a></p><p style="font-size:13px;color:#5b665f">Enter ${escape(email)} and choose “Email my secure link”.</p><hr style="border:0;border-top:1px solid #e7ebe6"><p style="font-size:12px">Martin Howard Property · martin@propinvestuk.co.uk</p></div></div>`;
      await deliver(email, subject, plain, html, 'mhp-access');
    },
    async sendEventPhoneLink(email: string, url: string, startsAt: string): Promise<void> {
      const target = new URL(url), start = Date.parse(startsAt);
      if (!normalizeMhpEmail(email) || target.origin !== MHP_AUTH_ORIGIN || target.pathname !== '/webinar/phone-reminders/open'
          || !/^[A-Za-z0-9_-]{43}$/u.test(target.searchParams.get('t') ?? '') || [...target.searchParams.keys()].length !== 1
          || !Number.isFinite(start)) throw new Error('Invalid MHP event reminder mail');
      const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(start);
      const subject = 'Confirm your webinar text reminder';
      const text = `You asked for a text reminder for the Martin Howard Property webinar on ${when} (UK time).\n\nConfirm it here: ${url}\n\nThis link expires in 15 minutes and works once. If you did not ask for this, ignore this email: nothing changes and you will not get texts.\n\nMartin Howard Property\nmartin@propinvestuk.co.uk`;
      const html = `<div style="background:#f3f3ee;padding:32px;font-family:Arial,sans-serif;color:#142019"><div style="max-width:560px;margin:auto;background:#fff;border-radius:20px;padding:36px"><p style="letter-spacing:2px;font-size:12px">MARTIN HOWARD PROPERTY</p><h1 style="font-size:28px">Confirm your text reminder</h1><p>You asked for a text reminder for the webinar on ${escape(when)} (UK time).</p><p style="margin:28px 0"><a href="${escape(url)}" style="display:inline-block;padding:14px 20px;background:#E8A33D;color:#142019;text-decoration:none;border-radius:8px;font-weight:bold">Continue</a></p><p style="font-size:13px;color:#5b665f">This link expires in 15 minutes and works once. If you did not ask for this, ignore this email: nothing changes and you will not get texts.</p><hr style="border:0;border-top:1px solid #e7ebe6"><p style="font-size:12px">Martin Howard Property · martin@propinvestuk.co.uk</p></div></div>`;
      await deliver(email, subject, text, html, 'mhp-event-reminder');
    },
  });
}
