/**
 * Plain-step follow-up sequences for the operator API. Claude writes
 *   { title, entry?, retryWindowHours?, stopOn?, steps: [ {wait}|{email}|{sms}|{saved} ] }
 * and this converts it to the exact stored definition plus inline message drafts
 * that the existing sequence services validate (keys, schemas, hashes). Nothing
 * here saves or sends; the services do their own full validation afterwards.
 */
import { FOLLOWUP_SEQUENCE_V2_SCHEMA, FOLLOWUP_SEQUENCE_MAX_STEPS, type FollowupSequenceDefinition } from '../followup-sequences/definition.js';
import { FLOW_SMS_DRAFT_SCHEMA } from '../followup-sequences/channel-drafts.js';
import type { OperatorBrand } from './config.js';
import { isUuid } from './tool-kit.js';

export const EMAIL_PLACEHOLDERS = '{{FIRSTNAME}}, {{LABEL}}, {{LINK}}, {{UNSUBSCRIBE}}';
export const SMS_PLACEHOLDERS = '{{FIRSTNAME}}, {{LINK}}';

export const SEQUENCE_INPUT_SCHEMA = {
  type: 'object',
  description: 'A follow-up sequence as plain steps. It must end with a message, not a wait.',
  properties: {
    title: { type: 'string', description: '1–180 characters' },
    entry: { type: 'string', enum: ['manual', 'webinar_signup'], description: 'manual (default): people are enrolled by hand in the portal. webinar_signup (MHP only): new webinar registrants enter once you switch the entry rule on in the portal.' },
    retryWindowHours: { type: 'integer', minimum: 1, maximum: 168, description: 'How long a due message may still be sent if delivery is delayed (default 48).' },
    stopOn: { type: 'object', properties: { reply: { type: 'boolean' }, booked: { type: 'boolean' }, purchased: { type: 'boolean' } }, description: 'Stop rules; each needs its event connected or it shows as a blocker.' },
    steps: {
      type: 'array', minItems: 1, maxItems: FOLLOWUP_SEQUENCE_MAX_STEPS,
      items: {
        type: 'object',
        description: `Exactly one of: {"wait":{"days":1,"hours":0,"minutes":0}} | {"email":{"subject":"…","body":"…","name":"optional label","replaces":{"contentItemId","contentVersionId"}}} | {"sms":{"body":"…","name":"…","replaces":{…}}} | {"saved":{"channel":"email|sms|whatsapp","contentItemId","contentVersionId","contentSha256"}}. Email placeholders: ${EMAIL_PLACEHOLDERS}. SMS placeholders: ${SMS_PLACEHOLDERS}. Use "replaces" to write a new version of a message already in the sequence.`,
      },
    },
  },
  required: ['title', 'steps'],
} as const;

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, label: string, max: number): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${label} is required.`);
  const out = v.replace(/\r\n?/g, '\n');
  if (out.length > max) throw new Error(`${label} is longer than ${max} characters.`);
  return out;
};
const whole = (v: unknown, label: string, max: number): number => {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw new Error(`${label} must be a whole number from 0 to ${max}.`);
  return v;
};

export interface BuiltSequence { readonly definition: Rec; readonly inlineMessages: Rec }

export function buildSequence(target: OperatorBrand, campaign: string, input: unknown): BuiltSequence {
  if (!record(input)) throw new Error('sequence must be an object with title and steps.');
  const title = text(input.title, 'title', 180).trim();
  const entryMode = input.entry === undefined ? 'manual' : input.entry;
  if (entryMode !== 'manual' && entryMode !== 'webinar_signup') throw new Error('entry must be "manual" or "webinar_signup".');
  if (entryMode === 'webinar_signup' && target !== 'mhp') throw new Error('Automatic webinar entry exists only for MHP.');
  const expiryHours = input.retryWindowHours === undefined ? 48 : input.retryWindowHours;
  if (typeof expiryHours !== 'number' || !Number.isInteger(expiryHours) || expiryHours < 1 || expiryHours > 168) throw new Error('retryWindowHours must be 1–168.');
  const stop = record(input.stopOn) ? input.stopOn : {};
  for (const k of Object.keys(stop)) if (!['reply', 'booked', 'purchased'].includes(k) || typeof stop[k] !== 'boolean') throw new Error('stopOn takes only reply, booked and purchased as true/false.');
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > FOLLOWUP_SEQUENCE_MAX_STEPS) throw new Error(`Use between 1 and ${FOLLOWUP_SEQUENCE_MAX_STEPS} steps.`);

  const steps: Rec[] = [];
  const inlineMessages: Rec = {};
  input.steps.forEach((raw, index) => {
    const key = `s${index + 1}`;
    const n = index + 1;
    // currentText is what followup_sequence_get returns beside a saved step; it is ignored on the way back in.
    const entries = record(raw) ? Object.entries(raw).filter(([k]) => k !== 'currentText') : [];
    if (entries.length !== 1) throw new Error(`Step ${n} must have exactly one of wait, email, sms or saved.`);
    const [kind, body] = entries[0]!;
    if (!record(body)) throw new Error(`Step ${n}: ${kind} must be an object.`);
    if (kind === 'wait') {
      const minutes = whole(body.days, `Step ${n} days`, 365) * 1440 + whole(body.hours, `Step ${n} hours`, 8760) * 60 + whole(body.minutes, `Step ${n} minutes`, 525600);
      steps.push({ key, kind: 'wait', minutes });
      return;
    }
    if (kind === 'saved') {
      const channel = body.channel;
      if (channel !== 'email' && channel !== 'sms' && channel !== 'whatsapp') throw new Error(`Step ${n}: saved.channel must be email, sms or whatsapp.`);
      if (!isUuid(body.contentItemId) || !isUuid(body.contentVersionId) || typeof body.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.contentSha256)) {
        throw new Error(`Step ${n}: saved needs contentItemId, contentVersionId and contentSha256 exactly as returned by followup_sequence_get.`);
      }
      steps.push({ key, kind: channel, contentItemId: body.contentItemId.toLowerCase(), contentVersionId: body.contentVersionId.toLowerCase(), contentSha256: body.contentSha256 });
      return;
    }
    if (kind !== 'email' && kind !== 'sms') throw new Error(`Step ${n}: use wait, email, sms or saved (WhatsApp templates are chosen from saved messages).`);
    const name = body.name === undefined ? `${title} · step ${n}` : text(body.name, `Step ${n} name`, 180).trim();
    const replaces = record(body.replaces) ? body.replaces : null;
    if (replaces && (!isUuid(replaces.contentItemId) || !isUuid(replaces.contentVersionId))) throw new Error(`Step ${n}: replaces needs contentItemId and contentVersionId.`);
    const payload = kind === 'email'
      ? { schema: 'propertypredator.email-draft/v1', subject: text(body.subject, `Step ${n} subject`, 300).trim(), bodyText: text(body.body, `Step ${n} body`, 50_000) }
      : { schema: FLOW_SMS_DRAFT_SCHEMA, bodyText: text(body.body, `Step ${n} body`, 1530) };
    steps.push(replaces ? { key, kind, contentItemId: String(replaces.contentItemId).toLowerCase(), contentVersionId: String(replaces.contentVersionId).toLowerCase() } : { key, kind });
    inlineMessages[key] = { channel: kind, title: name.slice(0, 180), contentItemId: replaces ? String(replaces.contentItemId).toLowerCase() : '',
      previousVersionId: replaces ? String(replaces.contentVersionId).toLowerCase() : '', payload };
  });

  return {
    definition: {
      schema: FOLLOWUP_SEQUENCE_V2_SCHEMA, brand: target, campaign, title, expiryHours,
      entry: entryMode === 'manual' ? { mode: 'manual', source: 'manual_owner' } : { mode: 'webinar_signup', source: 'mhp.capture/v2' },
      stopOn: { reply: stop.reply === true, booked: stop.booked === true, purchased: stop.purchased === true },
      steps,
    },
    inlineMessages,
  };
}

/** The stored definition back in plain steps, so Claude can edit and resubmit it. */
export function describeSequence(definition: FollowupSequenceDefinition, messages: readonly { review: { contentVersionId: string }; payload?: unknown }[] = []) {
  const payloads = new Map(messages.map((m) => [m.review.contentVersionId, m.payload]));
  return {
    title: definition.title,
    entry: definition.entry?.mode ?? 'manual',
    retryWindowHours: definition.expiryHours,
    stopOn: definition.stopOn,
    steps: definition.steps.map((step) => step.kind === 'wait'
      ? { wait: { minutes: step.minutes } }
      : { saved: { channel: step.kind, contentItemId: step.contentItemId, contentVersionId: step.contentVersionId, contentSha256: step.contentSha256 },
          ...(payloads.has(step.contentVersionId) ? { currentText: payloads.get(step.contentVersionId) } : {}) }),
  };
}
