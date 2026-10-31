import { createHash } from 'node:crypto';
import { FOLLOWUP_SEQUENCE_UUID, parseFollowupSequence, type FollowupChannel, type FollowupSequenceDefinition } from './definition.js';
import { canonicalFlowMessage, FlowDraftValidationError, parseFlowMessageDraft, type FlowMessageDraft } from './channel-drafts.js';
export interface FlowInlineMessage { readonly channel: FollowupChannel; readonly title: string; readonly contentItemId: string; readonly previousVersionId: string; readonly payload: FlowMessageDraft }
export interface FlowComposition { readonly definition: FollowupSequenceDefinition; readonly inlineMessages: Readonly<Record<string, FlowInlineMessage>> }
export interface FlowSavedMessageRef { readonly contentItemId: string; readonly contentVersionId: string; readonly contentSha256: string }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (message: string): never => { throw new FlowDraftValidationError(message); };
export function flowCommandUuid(commandId: string, stepKey: string): string {
  if (!FOLLOWUP_SEQUENCE_UUID.test(commandId) || !/^[a-z][a-z0-9_-]{0,49}$/u.test(stepKey)) return fail('Refresh the flow command before saving.');
  return localUuid(`growthhq.flow-message:${commandId}:${stepKey}`);
}
function localUuid(input: string): string {
  const bytes = createHash('sha256').update(input).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Unsaved form only. Synthetic refs support pure preview; persistence must resolve actual saved versions. */
export function parseFlowComposition(value: unknown, inlineValue: unknown): FlowComposition {
  if (!record(value) || !Array.isArray(value.steps) || !record(inlineValue) || Object.keys(inlineValue).length > 24
      || Buffer.byteLength(JSON.stringify({ value, inlineValue }), 'utf8') > 230_000) return fail('Keep the flow and inline messages within the form limit.');
  const steps = value.steps.map(step => record(step) ? { ...step } : step), inline: Record<string, FlowInlineMessage> = {};
  for (const [key, message] of Object.entries(inlineValue)) {
    if (!/^[a-z][a-z0-9_-]{0,49}$/u.test(key) || !record(message)
        || Object.keys(message).sort().join(',') !== ['channel', 'title', 'contentItemId', 'previousVersionId', 'payload'].sort().join(',')) return fail('Refresh the inline message form.');
    const matches = steps.filter(step => record(step) && step.key === key);
    const step = matches[0];
    if (matches.length !== 1 || !record(step) || step.kind === 'wait' || step.kind !== message.channel || !['email', 'sms', 'whatsapp'].includes(String(message.channel))) return fail('Inline messages must belong to exactly one matching message step.');
    if (typeof message.title !== 'string' || message.title !== message.title.trim() || message.title.length < 1 || message.title.length > 180 || /[\u0000-\u001f\u007f]/u.test(message.title)
        || typeof message.contentItemId !== 'string' || typeof message.previousVersionId !== 'string'
        || Boolean(message.contentItemId) !== Boolean(message.previousVersionId)
        || (message.contentItemId && (!FOLLOWUP_SEQUENCE_UUID.test(message.contentItemId) || !FOLLOWUP_SEQUENCE_UUID.test(message.previousVersionId)
          || step.contentItemId !== message.contentItemId || step.contentVersionId !== message.previousVersionId))) return fail('Choose the exact saved message predecessor before editing it.');
    const channel = message.channel as FollowupChannel, payload = parseFlowMessageDraft(channel, message.payload), canonical = canonicalFlowMessage(channel, payload);
    inline[key] = Object.freeze({ channel, title: message.title, contentItemId: message.contentItemId, previousVersionId: message.previousVersionId, payload });
    step.contentItemId = localUuid(`simulation-item:${key}:${canonical}`); step.contentVersionId = localUuid(`simulation-version:${key}:${canonical}`);
    step.contentSha256 = createHash('sha256').update(canonical).digest('hex');
  }
  return Object.freeze({ definition: parseFollowupSequence({ ...value, steps }), inlineMessages: Object.freeze(inline) });
}
/** Called after real0021 writes; synthetic preview identities can never be used as a successful save result. */
export function resolveFlowComposition(composition: FlowComposition, saved: Readonly<Record<string, FlowSavedMessageRef>>): FollowupSequenceDefinition {
  const expected = Object.keys(composition.inlineMessages).sort();
  if (Object.keys(saved).sort().join(',') !== expected.join(',')) return fail('Every inline message must be saved before the flow.');
  const steps = composition.definition.steps.map(step => {
    if (step.kind === 'wait' || !composition.inlineMessages[step.key]) return step;
    const actual = saved[step.key]!;
    if (!FOLLOWUP_SEQUENCE_UUID.test(actual.contentItemId) || !FOLLOWUP_SEQUENCE_UUID.test(actual.contentVersionId)
        || actual.contentSha256 !== step.contentSha256 || actual.contentItemId === step.contentItemId || actual.contentVersionId === step.contentVersionId) return fail('The saved message does not match this exact inline draft.');
    return { ...step, contentItemId: actual.contentItemId, contentVersionId: actual.contentVersionId, contentSha256: actual.contentSha256 };
  });
  return parseFollowupSequence({ ...composition.definition, steps });
}
