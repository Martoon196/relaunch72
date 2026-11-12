/**
 * Property Predator follow-up email delivery settings (PP-FOLLOWUP-001).
 *
 * PP_MARKETING_MODE: off (default; nothing is claimed or sent and runs wait), test (only the
 * addresses in PP_MARKETING_TEST_TO can receive anything, checked at claim and again at send),
 * live (every enrolled person with current permission). A mode other than off that is missing
 * any required setting is reported as not ready and sends nothing; it never takes the portal down.
 */
export type PpMarketingMode = 'off' | 'test' | 'live';
export interface PpMarketingConfig {
  readonly mode: 'test' | 'live'; readonly token: string; readonly from: string; readonly fromName: string; readonly replyTo: string;
  readonly stream: string; readonly testRecipients: readonly string[] | null; readonly link: string; readonly unsubscribeOrigin: string;
}
export interface PpMarketingStatus { readonly mode: PpMarketingMode; readonly ready: boolean; readonly problems: readonly string[] }
export const PP_MARKETING_DEFAULT_LINK = 'https://propertypredator.com/';

export function normalizePpEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>"',;:()[\]\\]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(email) ? email : null;
}

export function ppMarketingConfig(env: NodeJS.ProcessEnv): { status: PpMarketingStatus; config: PpMarketingConfig | null } {
  const raw = env.PP_MARKETING_MODE?.trim() || 'off';
  if (raw === 'off') return { status: Object.freeze({ mode: 'off', ready: false, problems: Object.freeze([]) }), config: null };
  const problems: string[] = [];
  if (raw !== 'test' && raw !== 'live') return { status: Object.freeze({ mode: 'off', ready: false, problems: Object.freeze(['PP_MARKETING_MODE must be off, test or live']) }), config: null };
  const mode = raw as 'test' | 'live';
  const token = env.PP_POSTMARK_SERVER_TOKEN?.trim() ?? '';
  const from = normalizePpEmail(env.PP_MARKETING_FROM ?? '');
  const replyTo = normalizePpEmail(env.PP_MARKETING_REPLY_TO ?? env.PP_MARKETING_FROM ?? '');
  const fromName = (env.PP_MARKETING_FROM_NAME ?? 'Property Predator').trim();
  const stream = env.PP_POSTMARK_BROADCAST_STREAM?.trim() || 'broadcast';
  if (!/^[A-Za-z0-9-]{20,100}$/u.test(token)) problems.push('PP_POSTMARK_SERVER_TOKEN is missing');
  if (!from) problems.push('PP_MARKETING_FROM must be a sender address on the verified Postmark domain');
  if (!replyTo) problems.push('PP_MARKETING_REPLY_TO must be an email address');
  if (!/^[\p{L}\p{N} .&'-]{1,60}$/u.test(fromName)) problems.push('PP_MARKETING_FROM_NAME must be 1-60 plain characters');
  if (!/^[a-z0-9-]{1,60}$/u.test(stream)) problems.push('PP_POSTMARK_BROADCAST_STREAM must be a Postmark stream id');
  let link = PP_MARKETING_DEFAULT_LINK;
  try { const url = new URL(env.PP_MARKETING_LINK?.trim() || PP_MARKETING_DEFAULT_LINK);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('unsafe'); link = url.href; }
  catch { problems.push('PP_MARKETING_LINK must be an https address'); }
  let unsubscribeOrigin = '';
  try { const url = new URL(env.PORTAL_BASE_URL?.trim() ?? ''); if (url.protocol !== 'https:') throw new Error('unsafe'); unsubscribeOrigin = url.origin; }
  catch { problems.push('PORTAL_BASE_URL must be the https portal origin that serves the unsubscribe link'); }
  if (!(env.SESSION_SECRET?.trim().length ?? 0)) problems.push('SESSION_SECRET signs unsubscribe links and is missing');
  let testRecipients: string[] | null = null;
  if (mode === 'test') {
    testRecipients = (env.PP_MARKETING_TEST_TO ?? '').split(',').map(value => normalizePpEmail(value)).filter((value): value is string => Boolean(value));
    if (testRecipients.length < 1 || testRecipients.length > 20) problems.push('PP_MARKETING_TEST_TO needs one to twenty addresses in test mode');
  }
  if (problems.length) return { status: Object.freeze({ mode, ready: false, problems: Object.freeze(problems) }), config: null };
  return { status: Object.freeze({ mode, ready: true, problems: Object.freeze([]) }),
    config: Object.freeze({ mode, token, from: from!, fromName, replyTo: replyTo!, stream, testRecipients: testRecipients ? Object.freeze([...new Set(testRecipients)]) : null, link, unsubscribeOrigin }) };
}
