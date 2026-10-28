import { MHP_AUTH_ORIGIN, normalizeMhpEmail, type MhpAuthPurpose } from './auth-service.js';

export interface MhpTransactionalMailer {
  readonly configured: boolean;
  sendAuthLink(email: string, url: string, purpose: MhpAuthPurpose): Promise<void>;
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
      const endpoint = provider === 'brevo' ? 'https://api.brevo.com/v3/smtp/email' : 'https://api.postmarkapp.com/email';
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      const body = provider === 'brevo'
        ? { sender: { id: senderId }, to: [{ email }], subject, textContent: text, htmlContent: html, tags: ['mhp-auth'], headers: { 'X-Mailin-Track': '0' } }
        : { From: from, To: email, Subject: subject, TextBody: text, HtmlBody: html, MessageStream: 'outbound', TrackOpens: false, TrackLinks: 'None', Tag: 'mhp-auth' };
      if (provider === 'brevo') headers['api-key'] = brevoKey!;
      else headers['X-Postmark-Server-Token'] = postmarkKey!;
      let response: Response;
      if (inFlight >= 8) throw new Error('MHP transactional delivery unavailable');
      inFlight += 1;
      try {
        response = await fetcher(endpoint, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10_000) });
        // Provider bodies can contain recipients, links and credentials. Never propagate them to logs or HTTP errors.
        if (!response.ok) { await response.body?.cancel(); throw new Error('MHP transactional delivery unavailable'); }
        await response.body?.cancel();
      } catch { throw new Error('MHP transactional delivery unavailable'); }
      finally { inFlight -= 1; }
    },
  });
}
