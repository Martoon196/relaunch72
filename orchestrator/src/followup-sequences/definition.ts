import { createHash } from 'node:crypto';
import { canonicalCompanyContentJson } from '../company-content-pg/index.js';

export const FOLLOWUP_SEQUENCE_SCHEMA = 'growthhq.followup-sequence/v1' as const;
export const FOLLOWUP_SEQUENCE_MIME = 'application/vnd.growthhq.followup-sequence+json';
export const FOLLOWUP_SEQUENCE_MAX_STEPS = 24;
export const FOLLOWUP_SEQUENCE_SOURCE = 'mhp.followup-sequence';
export const FOLLOWUP_SEQUENCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const KEY = /^[a-z][a-z0-9_-]{0,49}$/u;
export type FollowupBrand = 'mhp' | 'pp';
export type FollowupChannel = 'email' | 'sms' | 'whatsapp';
export interface FollowupWait { readonly key: string; readonly kind: 'wait'; readonly minutes: number }
export interface FollowupMessage {
  readonly key: string; readonly kind: FollowupChannel;
  readonly contentItemId: string; readonly contentVersionId: string; readonly contentSha256: string;
}
export type FollowupStep = FollowupWait | FollowupMessage;
export interface FollowupSequenceDefinition {
  readonly schema: typeof FOLLOWUP_SEQUENCE_SCHEMA; readonly brand: FollowupBrand;
  readonly campaign: string; readonly title: string; readonly expiryHours: number;
  readonly stopOn: Readonly<{ reply: boolean; booked: boolean; purchased: boolean }>;
  readonly steps: readonly FollowupStep[];
}
export class FollowupSequenceValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'FollowupSequenceValidationError'; }
}
const fail = (message: string): never => { throw new FollowupSequenceValidationError(message); };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail('Refresh the sequence form before saving.');
}
export const followupSequenceSha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** One shared persisted contract; brands/channels remain explicit, never inferred from another sender. */
export function parseFollowupSequence(value: unknown): FollowupSequenceDefinition {
  if (!record(value)) return fail('Choose a sequence to edit.');
  keys(value, ['schema', 'brand', 'campaign', 'title', 'expiryHours', 'stopOn', 'steps']);
  if (value.schema !== FOLLOWUP_SEQUENCE_SCHEMA || !['mhp', 'pp'].includes(String(value.brand))) fail('Choose a supported workspace.');
  if (typeof value.campaign !== 'string' || !/^[a-z0-9_-]{1,60}$/u.test(value.campaign)) fail('The webinar audience is unavailable.');
  if (typeof value.title !== 'string' || value.title !== value.title.trim() || value.title.length < 1 || value.title.length > 180
      || /[\u0000-\u001f\u007f]/u.test(value.title)) fail('Give the sequence a name of 1–180 characters.');
  if (!Number.isSafeInteger(value.expiryHours) || Number(value.expiryHours) < 1 || Number(value.expiryHours) > 168) fail('Choose a retry window from 1 to 168 hours.');
  if (!record(value.stopOn)) return fail('Choose the stop rules.');
  keys(value.stopOn, ['reply', 'booked', 'purchased']);
  if (Object.values(value.stopOn).some(flag => typeof flag !== 'boolean')) fail('Choose valid stop rules.');
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > FOLLOWUP_SEQUENCE_MAX_STEPS) return fail('Use between 1 and 24 steps.');
  const seen = new Set<string>(); let totalWait = 0, messages = 0;
  const steps = value.steps.map((step: unknown): FollowupStep => {
    if (!record(step) || typeof step.key !== 'string' || !KEY.test(step.key) || seen.has(step.key)) return fail('Each step needs its own stable identity.');
    seen.add(step.key);
    if (step.kind === 'wait') {
      keys(step, ['key', 'kind', 'minutes']);
      if (!Number.isSafeInteger(step.minutes) || Number(step.minutes) < 0 || Number(step.minutes) > 525600) fail('Waits must be whole minutes within one year.');
      totalWait += Number(step.minutes);
      return Object.freeze({ key: step.key, kind: 'wait', minutes: Number(step.minutes) });
    }
    keys(step, ['key', 'kind', 'contentItemId', 'contentVersionId', 'contentSha256']);
    if (!['email', 'sms', 'whatsapp'].includes(String(step.kind)) || typeof step.contentItemId !== 'string'
        || !FOLLOWUP_SEQUENCE_UUID.test(step.contentItemId) || typeof step.contentVersionId !== 'string'
        || !FOLLOWUP_SEQUENCE_UUID.test(step.contentVersionId) || typeof step.contentSha256 !== 'string'
        || !DIGEST.test(step.contentSha256)) fail('Choose a saved content version for each message.');
    messages++;
    return Object.freeze({ key: step.key, kind: step.kind as FollowupChannel, contentItemId: step.contentItemId as string,
      contentVersionId: step.contentVersionId as string, contentSha256: step.contentSha256 as string });
  });
  if (!messages || steps.at(-1)?.kind === 'wait') fail('End the sequence with a message, not a wait.');
  if (totalWait > 525600) fail('The total wait time must stay within one year.');
  return Object.freeze({ schema: FOLLOWUP_SEQUENCE_SCHEMA, brand: value.brand as FollowupBrand, campaign: value.campaign as string,
    title: value.title as string, expiryHours: Number(value.expiryHours), stopOn: Object.freeze({ reply: value.stopOn.reply as boolean,
      booked: value.stopOn.booked as boolean, purchased: value.stopOn.purchased as boolean }), steps: Object.freeze(steps) });
}
export function canonicalFollowupSequence(value: unknown): string { return canonicalCompanyContentJson(parseFollowupSequence(value)); }
export function readCanonicalFollowupSequence(content: string): FollowupSequenceDefinition {
  if (Buffer.byteLength(content) > 32_000) fail('This sequence is too large.');
  let parsed: unknown; try { parsed = JSON.parse(content); } catch { return fail('This sequence could not be read.'); }
  const definition = parseFollowupSequence(parsed);
  if (canonicalCompanyContentJson(definition) !== content) fail('The saved sequence bytes do not match the canonical version.');
  return definition;
}
export interface FollowupTimelineStep { readonly position: number; readonly step: FollowupMessage; readonly waitMinutes: number; readonly earliestOffsetMinutes: number }
/** Waits run from the preceding accepted message, not from an assumed inbox arrival. */
export function followupTimeline(definition: FollowupSequenceDefinition): readonly FollowupTimelineStep[] {
  const result: FollowupTimelineStep[] = []; let wait = 0, offset = 0;
  definition.steps.forEach((step, position) => {
    if (step.kind === 'wait') { wait += step.minutes; return; }
    offset += wait; result.push(Object.freeze({ position, step, waitMinutes: wait, earliestOffsetMinutes: offset })); wait = 0;
  });
  return Object.freeze(result);
}
export interface FollowupSequenceReadiness { readonly email: boolean; readonly sms: boolean; readonly whatsapp: boolean;
  readonly reply: boolean; readonly booked: boolean; readonly purchased: boolean }
export function followupActivationBlockers(definition: FollowupSequenceDefinition, readiness: FollowupSequenceReadiness): readonly string[] {
  const result = new Set<string>();
  for (const step of definition.steps) if (step.kind !== 'wait' && !readiness[step.kind]) result.add(`${step.kind}_not_connected`);
  for (const event of ['reply', 'booked', 'purchased'] as const) if (definition.stopOn[event] && !readiness[event]) result.add(`${event}_stop_not_connected`);
  return Object.freeze([...result]);
}
