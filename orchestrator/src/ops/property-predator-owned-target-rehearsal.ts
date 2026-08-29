/**
 * Zero-effect validation for the exact founder-owned targets used in the first
 * live-channel rehearsals. Raw addresses and identifiers are reduced to
 * boolean evidence before a report is created; this module never enqueues,
 * opens a database connection or calls a provider.
 */

export type RehearsalRailId = 'customer_email' | 'whatsapp' | 'owned_social' | 'sms' | 'social_dm';
export type RehearsalCheckState = 'pass' | 'missing' | 'invalid';

export interface RehearsalCheck {
  readonly setting: string;
  readonly label: string;
  readonly state: RehearsalCheckState;
}

export interface RehearsalRail {
  readonly rail: RehearsalRailId;
  readonly status: 'ready-for-command-rehearsal' | 'incomplete' | 'not-composed';
  readonly checks: readonly RehearsalCheck[];
}

export interface OwnedTargetRehearsalReport {
  readonly schemaVersion: 1;
  readonly result: 'blocked' | 'ready-for-composed-rail-rehearsal';
  readonly providerEffects: false;
  readonly networkCallsMade: false;
  readonly databaseCallsMade: false;
  readonly customerDataAccessed: false;
  readonly common: readonly RehearsalCheck[];
  readonly rails: readonly RehearsalRail[];
  readonly blockers: readonly string[];
  readonly nextStep: string;
}

interface Spec {
  readonly setting: string;
  readonly label: string;
  readonly valid: (raw: string) => boolean;
}

interface RailSpec {
  readonly rail: RehearsalRailId;
  readonly composed: boolean;
  readonly settings: readonly Spec[];
}

interface Evidence {
  readonly present: boolean;
  readonly valid: boolean;
}

export type SanitizedOwnedTargetEvidence = Readonly<Record<string, Evidence>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[a-z][a-z0-9_]{2,127}$/;
const UK_E164 = /^\+44[0-9]{9,10}$/;

const exact = (expected: string): ((raw: string) => boolean) =>
  (raw) => raw.trim().toLowerCase() === expected.toLowerCase();
const matches = (pattern: RegExp): ((raw: string) => boolean) =>
  (raw) => pattern.test(raw.trim());
const spec = (setting: string, label: string, valid: (raw: string) => boolean): Spec =>
  Object.freeze({ setting, label, valid });

function isOwnedXProfile(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    const parts = url.pathname.split('/').filter(Boolean);
    return url.protocol === 'https:'
      && url.hostname === 'x.com'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && parts.length === 1
      && /^[A-Za-z0-9_]{1,15}$/.test(parts[0] ?? '');
  } catch {
    return false;
  }
}

const COMMON: readonly Spec[] = Object.freeze([
  spec('PROPERTY_PREDATOR_REHEARSAL_WORKSPACE_ID', 'Exact Property Predator workspace', matches(UUID)),
  spec('PROPERTY_PREDATOR_REHEARSAL_OPERATOR_USER_ID', 'Founder/operator authority', matches(UUID)),
]);

const personEvidence = (prefix: string, label: string): readonly Spec[] => Object.freeze([
  spec(`${prefix}_PERSON_ID`, `${label} owned person`, matches(UUID)),
  spec(`${prefix}_ENDPOINT_ID`, `${label} verified endpoint`, matches(UUID)),
  spec(`${prefix}_CONSENT_EVIDENCE_ID`, `${label} consent evidence`, matches(UUID)),
  spec(`${prefix}_SUPPRESSION_CLEAR`, `${label} suppression clear`, exact('true')),
  spec(`${prefix}_APPROVAL_ID`, `${label} content approval`, matches(UUID)),
]);

const RAILS: readonly RailSpec[] = Object.freeze([
  Object.freeze({
    rail: 'customer_email', composed: true, settings: Object.freeze([
      spec('PROPERTY_PREDATOR_REHEARSAL_EMAIL_RECIPIENT', 'Owned office mailbox', exact('office@propertypredator.com')),
      ...personEvidence('PROPERTY_PREDATOR_REHEARSAL_EMAIL', 'Email'),
      spec('PROPERTY_PREDATOR_REHEARSAL_EMAIL_MESSAGE_SHA256', 'Exact approved email bytes', matches(SHA256)),
    ]),
  }),
  Object.freeze({
    rail: 'whatsapp', composed: true, settings: Object.freeze([
      spec('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT', 'Founder-owned WhatsApp recipient', matches(UK_E164)),
      spec('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED', 'WhatsApp ownership attestation', exact('true')),
      ...personEvidence('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP', 'WhatsApp'),
      spec('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_TEMPLATE_NAME', 'Approved parameter-free Meta template', matches(SAFE_NAME)),
      spec('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_TEMPLATE_SHA256', 'Exact approved WhatsApp template bytes', matches(SHA256)),
      spec('PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_TEMPLATE_PARAMETER_COUNT', 'Zero WhatsApp template parameters', exact('0')),
    ]),
  }),
  Object.freeze({
    rail: 'owned_social', composed: true, settings: Object.freeze([
      spec('PROPERTY_PREDATOR_REHEARSAL_SOCIAL_NETWORK', 'Owned social network', exact('x')),
      spec('PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_URL', 'Exact owned X profile', isOwnedXProfile),
      spec('PROPERTY_PREDATOR_REHEARSAL_SOCIAL_PROFILE_OWNED', 'Owned X profile attestation', exact('true')),
      spec('PROPERTY_PREDATOR_REHEARSAL_SOCIAL_POST_SHA256', 'Exact approved link-free post bytes', matches(SHA256)),
      spec('PROPERTY_PREDATOR_REHEARSAL_SOCIAL_APPROVAL_ID', 'Social post approval', matches(UUID)),
    ]),
  }),
  Object.freeze({
    rail: 'sms', composed: true, settings: Object.freeze([
      spec('PROPERTY_PREDATOR_REHEARSAL_SMS_RECIPIENT', 'Founder-owned UK SMS recipient', matches(UK_E164)),
      spec('PROPERTY_PREDATOR_REHEARSAL_SMS_RECIPIENT_OWNED', 'SMS ownership attestation', exact('true')),
      ...personEvidence('PROPERTY_PREDATOR_REHEARSAL_SMS', 'SMS'),
      spec('PROPERTY_PREDATOR_REHEARSAL_SMS_MESSAGE_SHA256', 'Exact approved SMS bytes', matches(SHA256)),
    ]),
  }),
  Object.freeze({ rail: 'social_dm', composed: false, settings: Object.freeze([]) }),
]);

const ALL_SPECS = Object.freeze([...COMMON, ...RAILS.flatMap((rail) => rail.settings)]);

export function sanitizeOwnedTargetRehearsalEnvironment(
  env: NodeJS.ProcessEnv,
): SanitizedOwnedTargetEvidence {
  const evidence: Record<string, Evidence> = Object.create(null) as Record<string, Evidence>;
  for (const item of ALL_SPECS) {
    const raw = env[item.setting];
    const present = Boolean(raw?.trim());
    evidence[item.setting] = Object.freeze({ present, valid: present ? item.valid(raw ?? '') : false });
  }
  return Object.freeze(evidence);
}

function check(item: Spec, evidence: SanitizedOwnedTargetEvidence): RehearsalCheck {
  const value = evidence[item.setting] ?? { present: false, valid: false };
  return Object.freeze({
    setting: item.setting,
    label: item.label,
    state: !value.present ? 'missing' : value.valid ? 'pass' : 'invalid',
  });
}

export function evaluateOwnedTargetRehearsal(
  evidence: SanitizedOwnedTargetEvidence,
): OwnedTargetRehearsalReport {
  const common = Object.freeze(COMMON.map((item) => check(item, evidence)));
  const rails = Object.freeze(RAILS.map((rail): RehearsalRail => {
    if (!rail.composed) return Object.freeze({ rail: rail.rail, status: 'not-composed', checks: Object.freeze([]) });
    const checks = Object.freeze(rail.settings.map((item) => check(item, evidence)));
    return Object.freeze({
      rail: rail.rail,
      status: checks.every((item) => item.state === 'pass') ? 'ready-for-command-rehearsal' : 'incomplete',
      checks,
    });
  }));
  const blockers = Object.freeze([
    ...common.filter((item) => item.state !== 'pass').map((item) => `${item.setting}: ${item.state}`),
    ...rails.filter((rail) => rail.status === 'incomplete').flatMap((rail) =>
      rail.checks.filter((item) => item.state !== 'pass').map((item) => `${item.setting}: ${item.state}`)),
  ]);
  return Object.freeze({
    schemaVersion: 1,
    result: blockers.length === 0 ? 'ready-for-composed-rail-rehearsal' : 'blocked',
    providerEffects: false,
    networkCallsMade: false,
    databaseCallsMade: false,
    customerDataAccessed: false,
    common,
    rails,
    blockers,
    nextStep: blockers.length === 0
      ? 'Review the redacted pack, then separately authorise one rail-specific command rehearsal.'
      : 'Supply only the missing owned-target evidence; no command or provider action was attempted.',
  });
}

export function runOwnedTargetRehearsal(env: NodeJS.ProcessEnv): OwnedTargetRehearsalReport {
  return evaluateOwnedTargetRehearsal(sanitizeOwnedTargetRehearsalEnvironment(env));
}

export function formatOwnedTargetRehearsal(report: OwnedTargetRehearsalReport): string {
  const token = (state: RehearsalCheckState): string => state.toUpperCase();
  const lines = [
    'Property Predator owned-target rehearsal',
    'ZERO EFFECTS — no database, provider or customer-data access occurred.',
    `Result: ${report.result === 'ready-for-composed-rail-rehearsal' ? 'READY FOR SEPARATE COMMAND REHEARSAL APPROVAL' : 'BLOCKED'}`,
    '',
    'Common evidence',
    ...report.common.map((item) => `[${token(item.state)}] ${item.setting} — ${item.label}`),
  ];
  for (const rail of report.rails) {
    lines.push('', `${rail.rail} — ${rail.status}`);
    lines.push(...rail.checks.map((item) => `[${token(item.state)}] ${item.setting} — ${item.label}`));
  }
  lines.push('', report.nextStep);
  return lines.join('\n');
}
