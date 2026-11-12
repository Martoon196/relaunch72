import type { IncomingMessage, ServerResponse } from 'node:http';
import { PP_FOLLOWUP_UNSUBSCRIBE_ROUTE, verifyPpUnsubscribeToken } from './content.js';
import type { PpFollowupUnsubscriber } from './repository.js';

const escape = (value: string): string => value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
function page(res: ServerResponse, status: number, title: string, body: string): void {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Property Predator</title><style>body{margin:0;background:#f4f3ef;color:#172b30;font:17px/1.65 system-ui,sans-serif}main{max-width:640px;margin:auto;padding:32px 16px}section{background:#fff;border:1px solid #d2dbdb;border-radius:18px;padding:28px}button{padding:14px 20px;border:0;border-radius:9px;background:#e8a33d;color:#172b30;font:700 17px/1.4 system-ui;cursor:pointer}</style></head><body><main><section><h1>${escape(title)}</h1>${body}</section></main></body></html>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(html)), 'cache-control': 'no-store',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(html);
}

/**
 * Public signed unsubscribe for PP follow-up emails. GET only shows a confirmation (link scanners must not
 * unsubscribe people); POST, including RFC 8058 one-click from the mailbox provider, records the suppression
 * for both Property Predator marketing purposes, so every other PP marketing email to this address stops too.
 */
export async function handlePpFollowupUnsubscribe(req: IncomingMessage, res: ServerResponse, url: URL,
  deps: { secret: string; unsubscriber: PpFollowupUnsubscriber }): Promise<boolean> {
  if (url.pathname !== PP_FOLLOWUP_UNSUBSCRIBE_ROUTE) return false;
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') { page(res, 405, 'Use the unsubscribe link', '<p>Open the unsubscribe link from your email.</p>'); return true; }
  const point = url.searchParams.get('p') ?? '', token = url.searchParams.get('t') ?? '';
  if (url.searchParams.size !== 2 || !verifyPpUnsubscribeToken(deps.secret, point, token)) {
    page(res, 400, 'This link is not valid', '<p>Reply to any of our emails and we will remove you by hand.</p>'); return true;
  }
  if (method === 'GET') {
    page(res, 200, 'Unsubscribe from Property Predator emails', `<p>Stop receiving marketing emails from Property Predator at this address?</p><form method="post" action="${escape(`${PP_FOLLOWUP_UNSUBSCRIBE_ROUTE}?p=${encodeURIComponent(point)}&t=${encodeURIComponent(token)}`)}"><button>Unsubscribe</button></form>`);
    return true;
  }
  let size = 0;
  for await (const chunk of req) { size += (chunk as Buffer).length; if (size > 1024) { page(res, 413, 'Request too large', '<p>Open the unsubscribe link from your email.</p>'); return true; } }
  try { await deps.unsubscriber.unsubscribe(point); }
  catch { page(res, 503, 'Please try again', '<p>We could not record this just now. Try again shortly, or reply to any email and we will remove you by hand.</p>'); return true; }
  page(res, 200, 'You’re unsubscribed', '<p>You won’t receive any more Property Predator marketing emails at this address.</p>');
  return true;
}
