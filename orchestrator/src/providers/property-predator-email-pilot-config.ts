import { domainToASCII } from 'node:url';

export const PROPERTY_PREDATOR_EMAIL_PROVIDER_ID = 'mailgun_eu';
export const PROPERTY_PREDATOR_EMAIL_PILOT_STAGE = 'internal-seed';
export const PROPERTY_PREDATOR_EMAIL_RECIPIENT_SCOPE = 'owned-internal-seeds-only';
export const PROPERTY_PREDATOR_EMAIL_HARD_MAX_RECIPIENTS = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ASCII_LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export interface PropertyPredatorEmailPilotPolicy {
  readonly providerEffectsEnabled: boolean;
  readonly emailDeliveryEnabled: boolean;
  readonly emergencyPaused: boolean;
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  readonly stage: typeof PROPERTY_PREDATOR_EMAIL_PILOT_STAGE;
  readonly recipientScope: typeof PROPERTY_PREDATOR_EMAIL_RECIPIENT_SCOPE;
  readonly maxRecipients: number;
  readonly internalSeedAllowlist: readonly string[];
  readonly maxMessagesPerRun: number;
  readonly maxMessagesPerUtcMonth: number;
  readonly estimatedCostUsdMicrosPerRecipient: number;
  readonly maxSpendUsdMicrosPerRun: number;
  readonly maxSpendUsdMicrosPerUtcMonth: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the controlled email pilot`);
  return value;
}

function exactUuid(value: string, name: string): string {
  const canonical = value.toLowerCase();
  if (!UUID.test(canonical)) throw new Error(`${name} must be a canonical UUID`);
  return canonical;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const raw = required(env, name);
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${name} must be a base-10 integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

/**
 * Canonicalise one deliberately narrow pilot recipient.
 *
 * We support internationalised domains through IDNA, but deliberately reject
 * SMTPUTF8 local parts. This removes Unicode/confusable ambiguity at an
 * irreversible pilot boundary while still accepting addresses such as
 * `seed@caf\u00e9.example` in their canonical punycode form.
 */
export function normalizeOwnedInternalSeedEmail(input: string): string {
  if (typeof input !== 'string') throw new Error('Pilot recipient must be a string');
  const candidate = input.normalize('NFC').trim();
  if (!candidate || /[\u0000-\u0020\u007f\p{Cf}\p{Zl}\p{Zp}]/u.test(candidate)
      || /[<>()\[\],;:\\"]/u.test(candidate)) {
    throw new Error('Pilot recipient is not a plain mailbox address');
  }
  const at = candidate.lastIndexOf('@');
  if (at < 1 || at !== candidate.indexOf('@') || at === candidate.length - 1) {
    throw new Error('Pilot recipient must contain one mailbox and one domain');
  }
  const local = candidate.slice(0, at);
  const rawDomain = candidate.slice(at + 1);
  if (!ASCII_LOCAL_PART.test(local) || local.length > 64
      || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    throw new Error('Pilot recipient local part is not supported');
  }
  const domain = domainToASCII(rawDomain).toLowerCase();
  const labels = domain.split('.');
  if (!domain || domain.length > 253 || labels.length < 2
      || labels.some((label) => !DOMAIN_LABEL.test(label))) {
    throw new Error('Pilot recipient domain is invalid');
  }
  const canonical = `${local.toLowerCase()}@${domain}`;
  if (Buffer.byteLength(canonical, 'utf8') > 254) {
    throw new Error('Pilot recipient is too long');
  }
  return canonical;
}

function safetySwitch(env: NodeJS.ProcessEnv, name: string): boolean {
  // Missing, malformed and mixed-case values all fail closed.
  return env[name]?.trim() === 'true';
}

function emergencyPause(env: NodeJS.ProcessEnv): boolean {
  // The pause is released only by one deliberate, exact value.
  return env.PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED?.trim() !== 'false';
}

/**
 * Read non-secret runtime policy. Provider credentials remain exclusively in
 * the Mailgun adapter and are never returned from this function.
 */
export function loadPropertyPredatorEmailPilotPolicy(
  env: NodeJS.ProcessEnv,
): PropertyPredatorEmailPilotPolicy {
  if (required(env, 'PROPERTY_PREDATOR_EMAIL_PROVIDER') !== 'mailgun') {
    throw new Error('PROPERTY_PREDATOR_EMAIL_PROVIDER must be mailgun');
  }
  const stage = required(env, 'PROPERTY_PREDATOR_PILOT_STAGE');
  if (stage !== PROPERTY_PREDATOR_EMAIL_PILOT_STAGE) {
    throw new Error('PROPERTY_PREDATOR_PILOT_STAGE must remain internal-seed');
  }
  const recipientScope = required(env, 'PROPERTY_PREDATOR_PILOT_RECIPIENT_SCOPE');
  if (recipientScope !== PROPERTY_PREDATOR_EMAIL_RECIPIENT_SCOPE) {
    throw new Error('PROPERTY_PREDATOR_PILOT_RECIPIENT_SCOPE must remain owned-internal-seeds-only');
  }
  const maxRecipients = integer(
    env,
    'PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS',
    1,
    PROPERTY_PREDATOR_EMAIL_HARD_MAX_RECIPIENTS,
  );
  const rawSeeds = required(env, 'PROPERTY_PREDATOR_EMAIL_INTERNAL_SEEDS').split(',');
  const seeds = rawSeeds.map(normalizeOwnedInternalSeedEmail);
  const uniqueSeeds = [...new Set(seeds)];
  if (uniqueSeeds.length !== seeds.length) {
    throw new Error('PROPERTY_PREDATOR_EMAIL_INTERNAL_SEEDS contains a duplicate canonical recipient');
  }
  if (uniqueSeeds.length < 1 || uniqueSeeds.length > maxRecipients) {
    throw new Error('PROPERTY_PREDATOR_EMAIL_INTERNAL_SEEDS exceeds the declared recipient scope');
  }

  const maxMessagesPerRun = integer(env, 'PROPERTY_PREDATOR_EMAIL_RUN_MESSAGE_CAP', 1, maxRecipients);
  const maxMessagesPerUtcMonth = integer(
    env,
    'PROPERTY_PREDATOR_EMAIL_MONTHLY_MESSAGE_CAP',
    maxMessagesPerRun,
    10_000,
  );
  const estimatedCostUsdMicrosPerRecipient = integer(
    env,
    'PROPERTY_PREDATOR_EMAIL_ESTIMATED_RECIPIENT_COST_USD_MICROS',
    1,
    1_000_000,
  );
  const maxSpendUsdMicrosPerRun = integer(
    env,
    'PROPERTY_PREDATOR_EMAIL_RUN_SPEND_CAP_USD_MICROS',
    estimatedCostUsdMicrosPerRecipient,
    100_000_000,
  );
  const maxSpendUsdMicrosPerUtcMonth = integer(
    env,
    'PROPERTY_PREDATOR_EMAIL_MONTHLY_SPEND_CAP_USD_MICROS',
    maxSpendUsdMicrosPerRun,
    100_000_000,
  );
  if (estimatedCostUsdMicrosPerRecipient * maxMessagesPerRun > maxSpendUsdMicrosPerRun) {
    throw new Error('The per-run spend cap cannot cover its declared message cap');
  }
  if (estimatedCostUsdMicrosPerRecipient * maxMessagesPerUtcMonth
      > maxSpendUsdMicrosPerUtcMonth) {
    throw new Error('The monthly spend cap cannot cover its declared message cap');
  }

  return Object.freeze({
    providerEffectsEnabled: safetySwitch(env, 'PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED'),
    emailDeliveryEnabled: safetySwitch(env, 'PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED'),
    emergencyPaused: emergencyPause(env),
    workspaceId: exactUuid(
      required(env, 'PROPERTY_PREDATOR_PILOT_WORKSPACE_ID'),
      'PROPERTY_PREDATOR_PILOT_WORKSPACE_ID',
    ),
    providerConnectionId: exactUuid(
      required(env, 'PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID'),
      'PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID',
    ),
    stage: PROPERTY_PREDATOR_EMAIL_PILOT_STAGE,
    recipientScope: PROPERTY_PREDATOR_EMAIL_RECIPIENT_SCOPE,
    maxRecipients,
    internalSeedAllowlist: Object.freeze(uniqueSeeds),
    maxMessagesPerRun,
    maxMessagesPerUtcMonth,
    estimatedCostUsdMicrosPerRecipient,
    maxSpendUsdMicrosPerRun,
    maxSpendUsdMicrosPerUtcMonth,
  });
}
