import { canonicalCompanyContentEmailDraft, canonicalCompanyContentJson, parseCompanyContentEmailDraft } from '../company-content-pg/index.js';
import { TWILIO_SMS_GSM_BASIC_TEXT, twilioSmsSegmentCount } from '../sms-live/foundation.js';
import { followupSequenceSha, type FollowupBrand, type FollowupChannel } from './definition.js';

export const FLOW_SMS_DRAFT_SCHEMA = 'growthhq.sms-draft/v1' as const;
export const FLOW_WHATSAPP_DRAFT_SCHEMA = 'growthhq.whatsapp-template-draft/v1' as const;
export interface FlowSmsDraft { readonly schema: typeof FLOW_SMS_DRAFT_SCHEMA; readonly bodyText: string }
export interface FlowWhatsAppDraft { readonly schema: typeof FLOW_WHATSAPP_DRAFT_SCHEMA; readonly templateName: string; readonly language: string; readonly bodyText: string }
export interface FlowEmailDraft { readonly schema: 'propertypredator.email-draft/v1'; readonly subject: string; readonly bodyText: string }
export type FlowMessageDraft = FlowEmailDraft | FlowSmsDraft | FlowWhatsAppDraft;
export class FlowDraftValidationError extends Error { constructor(message: string) { super(message); this.name = 'FlowDraftValidationError'; } }
const fail = (message: string): never => { throw new FlowDraftValidationError(message); };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail('Refresh the message form before saving.');
}
function text(value: unknown, maximum: number, bytes: number): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > maximum || Buffer.byteLength(value, 'utf8') > bytes
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return fail('Use non-empty message text within the displayed limit.');
  return value;
}
function namedFields(value: string, allowed: readonly string[]): void {
  const remaining = value.replace(/\{\{([A-Z]+)\}\}/gu, (whole, name: string) => allowed.includes(name) ? '' : whole);
  if (remaining.includes('{{') || remaining.includes('}}')) fail(`Use only ${allowed.join(', ')} in double braces.`);
}
export function parseFlowMessageDraft(channel: FollowupChannel, value: unknown): FlowMessageDraft {
  if (!['email', 'sms', 'whatsapp'].includes(channel)) return fail('Choose a supported message channel.');
  if (!record(value)) return fail('Choose a message to edit.');
  if (channel === 'email') {
    keys(value, ['schema', 'subject', 'bodyText']);
    if (value.schema !== 'propertypredator.email-draft/v1' || typeof value.subject !== 'string') return fail('Use a saved email subject and body.');
    const body = text(value.bodyText, 50_000, 50_000); namedFields(`${value.subject}\n${body}`, ['FIRSTNAME', 'LABEL', 'LINK', 'UNSUBSCRIBE']);
    try { return Object.freeze(parseCompanyContentEmailDraft(canonicalCompanyContentEmailDraft(value.subject, body))); }
    catch { return fail('Use a subject on one line and a non-empty text email body.'); }
  }
  if (channel === 'sms') {
    keys(value, ['schema', 'bodyText']);
    if (value.schema !== FLOW_SMS_DRAFT_SCHEMA) return fail('Choose a text message draft.');
    const bodyText = text(value.bodyText, 1530, 8000); namedFields(bodyText, ['FIRSTNAME', 'LINK']);
    return Object.freeze({ schema: FLOW_SMS_DRAFT_SCHEMA, bodyText });
  }
  keys(value, ['schema', 'templateName', 'language', 'bodyText']);
  if (value.schema !== FLOW_WHATSAPP_DRAFT_SCHEMA || typeof value.templateName !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/u.test(value.templateName)
      || typeof value.language !== 'string' || !/^[a-z]{2}(?:_[A-Z]{2})?$/u.test(value.language)) return fail('Use a lowercase template name and a language such as en_GB.');
  const bodyText = text(value.bodyText, 4096, 16000), parameters = new Set<number>();
  const remaining = bodyText.replace(/\{\{([1-9]|10)\}\}/gu, (_whole, position: string) => { parameters.add(Number(position)); return ''; });
  if (remaining.includes('{{') || remaining.includes('}}') || [...parameters].sort((a, b) => a - b).some((n, at) => n !== at + 1)) return fail('Template variables must be numbered consecutively from {{1}}, with at most ten.');
  return Object.freeze({ schema: FLOW_WHATSAPP_DRAFT_SCHEMA, templateName: value.templateName, language: value.language, bodyText });
}
export const canonicalFlowMessage = (channel: FollowupChannel, value: unknown): string => canonicalCompanyContentJson(parseFlowMessageDraft(channel, value));
export function readFlowMessage(channel: FollowupChannel, canonical: string): FlowMessageDraft {
  if (Buffer.byteLength(canonical, 'utf8') > 56_000) return fail('The saved message is too large.');
  let value: unknown; try { value = JSON.parse(canonical); } catch { return fail('The saved message is invalid.'); }
  const draft = parseFlowMessageDraft(channel, value);
  if (canonicalCompanyContentJson(draft) !== canonical) return fail('The message is not its exact saved canonical version.');
  return draft;
}
export function flowMessageContract(brand: FollowupBrand, channel: FollowupChannel) {
  return Object.freeze({ source: `${brand}.owner-${channel === 'email' ? 'email' : channel === 'sms' ? 'sms' : 'whatsapp'}`,
    kind: channel === 'email' ? 'email' as const : 'other' as const,
    mime: channel === 'email' ? 'application/vnd.propertypredator.email-draft+json' : channel === 'sms' ? 'application/vnd.growthhq.sms-draft+json' : 'application/vnd.growthhq.whatsapp-template-draft+json' });
}
export interface FlowSmsFeedback { readonly supported: boolean; readonly characters: number; readonly segments: number | null; readonly message: string }
export function flowSmsFeedback(body: string): FlowSmsFeedback {
  const supported = TWILIO_SMS_GSM_BASIC_TEXT.test(body) && body.length <= 1530;
  const segments = supported ? twilioSmsSegmentCount(body) : null;
  return Object.freeze({ supported, characters: [...body].length, segments,
    message: supported ? `${segments} estimated segment${segments === 1 ? '' : 's'} for this exact draft text. Recipient permission and final merged size still need checking.`
      : 'Draft retained. This text or its variables are outside the current rail’s supported encoding; live segment count is unavailable.' });
}
/** Fixed synthetic values only. This is never a provider payload or recipient merge. */
export function previewFlowMessage(channel: FollowupChannel, value: unknown) {
  const draft = parseFlowMessageDraft(channel, value), sample: Record<string, string> = { FIRSTNAME: 'Alex', LABEL: 'Sample webinar', LINK: 'https://example.invalid/sample', UNSUBSCRIBE: 'https://example.invalid/unsubscribe' };
  const render = (body: string) => body.replace(/\{\{(FIRSTNAME|LABEL|LINK|UNSUBSCRIBE)\}\}/gu, (_all, field: string) => sample[field]!)
    .replace(/\{\{([1-9]|10)\}\}/gu, (_all, field: string) => `Sample ${field}`);
  return Object.freeze({ channel, subject: 'subject' in draft ? render(draft.subject) : null, text: render(draft.bodyText),
    sha256: followupSequenceSha(canonicalCompanyContentJson(draft)), simulation: true as const, providerApproved: false as const,
    feedback: channel === 'sms' ? flowSmsFeedback(draft.bodyText) : null,
    parameterCount: channel === 'whatsapp' ? new Set(draft.bodyText.match(/\{\{(?:[1-9]|10)\}\}/gu) ?? []).size : 0 });
}
