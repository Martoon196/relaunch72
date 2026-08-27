/**
 * Property Predator controlled-pilot configuration preflight.
 *
 * This module deliberately does not import a provider SDK, open a socket, or
 * expose a credential. Raw environment values are reduced immediately to
 * boolean evidence; the pure evaluator and every serialisable result see only
 * setting names plus pass/fail state.
 */

export type PilotRailId = 'email' | 'whatsapp' | 'sms' | 'social' | 'webinar' | 'calendar';
export type PilotPhase = 'mandatory-first-channel' | 'deferred';
export type PreflightCheckState = 'pass' | 'missing' | 'invalid';

export interface SanitizedSettingEvidence {
  readonly present: boolean;
  readonly valid: boolean;
}

export type SanitizedPilotEnvironment = Readonly<Record<string, SanitizedSettingEvidence>>;

export interface PilotPreflightCheck {
  readonly setting: string;
  readonly label: string;
  readonly state: PreflightCheckState;
  readonly blocking: boolean;
  readonly detail: string;
}

export interface PilotProviderPreflight {
  readonly rail: PilotRailId;
  readonly provider: string;
  readonly phase: PilotPhase;
  readonly status: 'configuration-ready' | 'incomplete' | 'not-configured';
  readonly checks: readonly PilotPreflightCheck[];
}

export interface PropertyPredatorPilotPreflightReport {
  readonly schemaVersion: 1;
  readonly result: 'blocked' | 'ready-for-activation-review';
  /** Always false: this command proves configuration shape, never provider connectivity. */
  readonly liveEffectsVerified: false;
  readonly networkCallsMade: false;
  readonly foundation: readonly PilotPreflightCheck[];
  readonly providers: readonly PilotProviderPreflight[];
  readonly blockers: readonly string[];
  readonly manualProofGates: readonly string[];
}

interface SettingSpec {
  readonly setting: string;
  readonly label: string;
  readonly validator: (raw: string) => boolean;
  readonly missingDetail: string;
  readonly invalidDetail: string;
}

interface ProviderSpec {
  readonly rail: PilotRailId;
  readonly provider: string;
  readonly phase: PilotPhase;
  readonly settings: readonly SettingSpec[];
}

const exact = (expected: string): ((raw: string) => boolean) =>
  (raw) => raw.trim().toLowerCase() === expected.toLowerCase();

const minLength = (minimum: number): ((raw: string) => boolean) =>
  (raw) => raw.trim().length >= minimum;

const matches = (pattern: RegExp): ((raw: string) => boolean) =>
  (raw) => pattern.test(raw.trim());

function isHttpsUrl(raw: string, originOnly = false): boolean {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:'
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && (!originOnly || ((url.pathname === '/' || url.pathname === '') && !url.search && !url.hash));
  } catch {
    return false;
  }
}

function isDomain(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value.length <= 253
    && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);
}

function isEmail(raw: string): boolean {
  const value = raw.trim();
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isInternalRecipientCap(raw: string): boolean {
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= 1 && value <= 25;
}

function isProductionDatabaseUrl(expectedUser: string): (raw: string) => boolean {
  return (raw) => {
    try {
      const url = new URL(raw.trim());
      return (url.protocol === 'postgres:' || url.protocol === 'postgresql:')
        && Boolean(url.hostname)
        && decodeURIComponent(url.username) === expectedUser
        && Boolean(url.pathname && url.pathname !== '/')
        && url.searchParams.get('sslmode') !== 'disable';
    } catch {
      return false;
    }
  };
}

function setting(
  settingName: string,
  label: string,
  validator: (raw: string) => boolean,
  requirement: string,
): SettingSpec {
  return Object.freeze({
    setting: settingName,
    label,
    validator,
    missingDetail: `${requirement} is not declared`,
    invalidDetail: `${requirement} is declared in an unsafe or unsupported form`,
  });
}

const FOUNDATION_SETTINGS: readonly SettingSpec[] = Object.freeze([
  setting('NODE_ENV', 'Production runtime mode', exact('production'), 'Production runtime mode'),
  setting('PORTAL_POSTGRES_ENABLED', 'PostgreSQL portal cutover', exact('true'), 'PostgreSQL portal cutover'),
  setting('PORTAL_PRODUCT_PROFILE', 'Property Predator product profile', exact('property_predator_growth'), 'Property Predator product profile'),
  setting('PORTAL_BASE_URL', 'Growth HQ HTTPS origin', (raw) => isHttpsUrl(raw, true), 'A single credential-free HTTPS Growth HQ origin'),
  setting('PUBLIC_BASE_URL', 'Public HTTPS origin', (raw) => isHttpsUrl(raw, true), 'A single credential-free public HTTPS origin'),
  setting('SESSION_SECRET', 'Dedicated session-signing secret', (raw) => raw.trim().length >= 32 && raw.trim() !== 'r72-dev-session-secret', 'A dedicated session-signing secret of at least 32 characters'),
  setting('PORTAL_PROXY_MODE', 'Trusted Render proxy boundary', exact('render'), 'Render trusted-proxy client-address resolution'),
  setting('PORTAL_ABUSE_HASH_SECRET', 'Dedicated abuse-evidence HMAC secret', minLength(32), 'A dedicated abuse-evidence HMAC secret of at least 32 characters'),
  setting('DATABASE_SSL_MODE', 'Verified database TLS', exact('verify-full'), 'Certificate-verifying database TLS'),
  setting('DATABASE_WEB_URL', 'Read-model database identity', isProductionDatabaseUrl('r72_web'), 'The least-privilege r72_web database URL'),
  setting('DATABASE_IDENTITY_COMMAND_URL', 'Identity command database identity', isProductionDatabaseUrl('r72_identity_command'), 'The least-privilege r72_identity_command database URL'),
  setting('DATABASE_CRM_COMMAND_URL', 'CRM command database identity', isProductionDatabaseUrl('r72_crm_command'), 'The least-privilege r72_crm_command database URL'),
  setting('DATABASE_ABUSE_COMMAND_URL', 'Abuse command database identity', isProductionDatabaseUrl('r72_abuse_command'), 'The least-privilege r72_abuse_command database URL'),
  setting('DATABASE_CONTENT_COMMAND_URL', 'Content command database identity', isProductionDatabaseUrl('r72_content_command'), 'The least-privilege r72_content_command database URL'),
  setting('DATABASE_CONTENT_ADAPTER_URL', 'Company asset metadata database identity', isProductionDatabaseUrl('r72_content_adapter'), 'The metadata-only r72_content_adapter database URL'),
  setting('DATABASE_WORKER_URL', 'Outbox worker database identity', isProductionDatabaseUrl('r72_worker'), 'The least-privilege r72_worker database URL'),
  setting('DATABASE_WEBHOOK_URL', 'Webhook database identity', isProductionDatabaseUrl('r72_webhook'), 'The least-privilege r72_webhook database URL'),
  setting('PROPERTY_PREDATOR_PILOT_WORKSPACE_ID', 'Dedicated pilot workspace', matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i), 'A dedicated Property Predator production workspace UUID'),
  setting('PROPERTY_PREDATOR_PILOT_STAGE', 'Internal seed stage', exact('internal-seed'), 'The internal-seed pilot stage'),
  setting('PROPERTY_PREDATOR_PILOT_RECIPIENT_SCOPE', 'Recipient safety scope', exact('owned-internal-seeds-only'), 'The owned-internal-seeds-only recipient scope'),
  setting('PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS', 'Declared internal recipient cap', isInternalRecipientCap, 'An internal seed-recipient cap from 1 to 25'),
]);

export const PILOT_PROVIDER_CATALOGUE: readonly ProviderSpec[] = Object.freeze([
  Object.freeze({
    rail: 'email', provider: 'Mailgun Basic', phase: 'mandatory-first-channel', settings: Object.freeze([
      setting('PROPERTY_PREDATOR_EMAIL_PROVIDER', 'Selected email provider', exact('mailgun'), 'Mailgun as the pilot email provider'),
      setting('MAILGUN_API_KEY', 'Mailgun API key', minLength(8), 'A secret-manager Mailgun API key'),
      setting('MAILGUN_SIGNING_KEY', 'Mailgun webhook signing key', minLength(24), 'A secret-manager Mailgun webhook signing key'),
      setting('MAILGUN_REGION', 'Mailgun data region', exact('eu'), 'The Mailgun EU region'),
      setting('MAILGUN_SENDING_DOMAIN', 'Verified sending domain', isDomain, 'A verified Mailgun sending domain'),
      setting('MAILGUN_FROM_EMAIL', 'Verified From identity', isEmail, 'A verified Mailgun From email identity'),
      setting('MAILGUN_EVENT_WEBHOOK_URL', 'Signed delivery-event callback', isHttpsUrl, 'An HTTPS Mailgun event callback'),
      setting('MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED', 'Webhook signature verification', exact('true'), 'Cryptographic Mailgun webhook verification'),
      setting('MAILGUN_DNS_VERIFIED', 'Mailgun DNS verification evidence', exact('true'), 'Explicit Mailgun SPF/DKIM verification evidence'),
      setting('MAILGUN_SUPPRESSION_SYNC_ENABLED', 'Suppression synchronisation gate', exact('true'), 'Suppression synchronisation'),
    ]),
  }),
  Object.freeze({
    rail: 'whatsapp', provider: '360dialog Regular', phase: 'deferred', settings: Object.freeze([
      setting('PROPERTY_PREDATOR_WHATSAPP_PROVIDER', 'Selected WhatsApp provider', exact('360dialog'), '360dialog as the pilot WhatsApp provider'),
      setting('DIALOG360_API_KEY', '360dialog API key', minLength(8), 'A secret-manager 360dialog API key'),
      setting('DIALOG360_WABA_ID', 'WhatsApp Business Account identity', minLength(1), 'A verified WABA identity'),
      setting('DIALOG360_PHONE_NUMBER_ID', 'WhatsApp number identity', minLength(1), 'A verified WhatsApp phone-number identity'),
      setting('DIALOG360_WEBHOOK_URL', 'WhatsApp callback', isHttpsUrl, 'An HTTPS WhatsApp callback'),
      setting('DIALOG360_WEBHOOK_AUTH_SECRET', 'WhatsApp ingress authentication secret', minLength(24), 'A dedicated WhatsApp ingress authentication secret'),
      setting('DIALOG360_BUSINESS_VERIFIED', 'Meta business verification evidence', exact('true'), 'Explicit Meta business verification evidence'),
    ]),
  }),
  Object.freeze({
    rail: 'sms', provider: 'Twilio UK SMS', phase: 'deferred', settings: Object.freeze([
      setting('PROPERTY_PREDATOR_SMS_PROVIDER', 'Selected SMS provider', exact('twilio'), 'Twilio as the pilot SMS provider'),
      setting('TWILIO_ACCOUNT_SID', 'Twilio account identity', matches(/^AC[a-f0-9]{32}$/i), 'A Twilio Account SID'),
      setting('TWILIO_API_KEY_SID', 'Restricted Twilio API key identity', matches(/^SK[a-f0-9]{32}$/i), 'A restricted Twilio API key SID'),
      setting('TWILIO_API_KEY_SECRET', 'Twilio API key secret', minLength(16), 'A secret-manager Twilio API key secret'),
      setting('TWILIO_MESSAGING_SERVICE_SID', 'Messaging Service identity', matches(/^MG[a-f0-9]{32}$/i), 'A Twilio Messaging Service SID'),
      setting('TWILIO_UK_REGULATORY_BUNDLE_SID', 'UK regulatory bundle', matches(/^BU[a-f0-9]{32}$/i), 'An approved UK regulatory bundle SID'),
      setting('TWILIO_WEBHOOK_URL', 'SMS status callback', isHttpsUrl, 'An HTTPS Twilio status callback'),
      setting('TWILIO_SIGNATURE_VALIDATION_ENABLED', 'Twilio signature validation', exact('true'), 'Twilio request-signature validation'),
    ]),
  }),
  Object.freeze({
    rail: 'social', provider: 'Ayrshare Launch', phase: 'deferred', settings: Object.freeze([
      setting('PROPERTY_PREDATOR_SOCIAL_PROVIDER', 'Selected social provider', exact('ayrshare'), 'Ayrshare as the pilot social provider'),
      setting('AYRSHARE_API_KEY', 'Ayrshare API key', minLength(8), 'A secret-manager Ayrshare API key'),
      setting('AYRSHARE_PROFILE_KEY', 'Isolated social profile identity', minLength(8), 'A Property Predator Ayrshare Profile Key'),
      setting('AYRSHARE_DOMAIN_ID', 'Branded linking domain identity', minLength(1), 'An Ayrshare domain identity'),
      setting('AYRSHARE_WEBHOOK_URL', 'Social event callback', isHttpsUrl, 'An HTTPS Ayrshare event callback'),
      setting('AYRSHARE_WEBHOOK_SECRET', 'Social webhook secret', minLength(24), 'A dedicated Ayrshare webhook secret'),
      setting('AYRSHARE_PROFILE_LINK_COMPLETE', 'Social account-link proof', exact('true'), 'Explicit account-link completion evidence'),
    ]),
  }),
  Object.freeze({
    rail: 'webinar', provider: 'Whereby Embedded Build', phase: 'deferred', settings: Object.freeze([
      setting('PROPERTY_PREDATOR_WEBINAR_PROVIDER', 'Selected webinar provider', exact('whereby'), 'Whereby as the pilot webinar provider'),
      setting('WHEREBY_API_KEY', 'Whereby API key', minLength(8), 'A secret-manager Whereby API key'),
      setting('WHEREBY_WEBHOOK_URL', 'Attendance callback', isHttpsUrl, 'An HTTPS Whereby attendance callback'),
      setting('WHEREBY_WEBHOOK_SECRET', 'Whereby webhook secret', minLength(24), 'A dedicated Whereby webhook secret'),
      setting('WHEREBY_ALLOWED_ORIGIN', 'Embedded-room origin', (raw) => isHttpsUrl(raw, true), 'One approved credential-free HTTPS embedded-room origin'),
    ]),
  }),
  Object.freeze({
    rail: 'calendar', provider: 'Nylas Calendar/Scheduler', phase: 'deferred', settings: Object.freeze([
      setting('PROPERTY_PREDATOR_CALENDAR_PROVIDER', 'Selected calendar provider', exact('nylas'), 'Nylas as the pilot calendar provider'),
      setting('NYLAS_API_KEY', 'Nylas API key', minLength(8), 'A secret-manager Nylas API key'),
      setting('NYLAS_APPLICATION_ID', 'Nylas application identity', minLength(1), 'A Nylas application identity'),
      setting('NYLAS_REGION', 'Nylas data region', exact('eu'), 'The Nylas EU data region'),
      setting('NYLAS_OAUTH_CALLBACK_URL', 'Calendar OAuth callback', isHttpsUrl, 'An HTTPS Nylas OAuth callback'),
      setting('NYLAS_WEBHOOK_URL', 'Calendar event callback', isHttpsUrl, 'An HTTPS Nylas event callback'),
      setting('NYLAS_WEBHOOK_SECRET', 'Nylas webhook secret', minLength(24), 'A dedicated Nylas webhook secret'),
    ]),
  }),
]);

const ALL_SETTING_SPECS = Object.freeze([
  ...FOUNDATION_SETTINGS,
  ...PILOT_PROVIDER_CATALOGUE.flatMap((provider) => provider.settings),
]);

/**
 * Convert raw process environment values into non-secret pass/fail evidence.
 * No raw value, URL, identifier, address, or credential survives this boundary.
 */
export function sanitizePropertyPredatorPilotEnvironment(
  env: NodeJS.ProcessEnv,
): SanitizedPilotEnvironment {
  const evidence: Record<string, SanitizedSettingEvidence> = Object.create(null) as Record<string, SanitizedSettingEvidence>;
  for (const spec of ALL_SETTING_SPECS) {
    const raw = env[spec.setting];
    const present = Boolean(raw?.trim());
    evidence[spec.setting] = Object.freeze({
      present,
      valid: present ? spec.validator(raw ?? '') : false,
    });
  }
  // Reduce cross-secret reuse to one invalid bit before returning. Raw secret
  // material still never crosses this sanitizer boundary.
  if (env.PORTAL_ABUSE_HASH_SECRET?.trim()
      && env.PORTAL_ABUSE_HASH_SECRET.trim() === env.SESSION_SECRET?.trim()) {
    evidence.PORTAL_ABUSE_HASH_SECRET = Object.freeze({ present: true, valid: false });
  }
  return Object.freeze(evidence);
}

function checkFromEvidence(
  spec: SettingSpec,
  evidence: SanitizedPilotEnvironment,
  blocking: boolean,
): PilotPreflightCheck {
  const proof = evidence[spec.setting] ?? { present: false, valid: false };
  const state: PreflightCheckState = !proof.present ? 'missing' : proof.valid ? 'pass' : 'invalid';
  return Object.freeze({
    setting: spec.setting,
    label: spec.label,
    state,
    blocking,
    detail: state === 'pass'
      ? 'Configured; value deliberately redacted'
      : state === 'missing'
        ? spec.missingDetail
        : spec.invalidDetail,
  });
}

/** Pure, network-free evaluation of already-sanitized evidence. */
export function evaluatePropertyPredatorPilotPreflight(
  evidence: SanitizedPilotEnvironment,
): PropertyPredatorPilotPreflightReport {
  const foundation = Object.freeze(FOUNDATION_SETTINGS.map((spec) => checkFromEvidence(spec, evidence, true)));
  const providers = Object.freeze(PILOT_PROVIDER_CATALOGUE.map((provider): PilotProviderPreflight => {
    const blocking = provider.phase === 'mandatory-first-channel';
    const checks = Object.freeze(provider.settings.map((spec) => checkFromEvidence(spec, evidence, blocking)));
    const configuredCount = checks.filter((check) => check.state !== 'missing').length;
    const status = checks.every((check) => check.state === 'pass')
      ? 'configuration-ready'
      : configuredCount === 0
        ? 'not-configured'
        : 'incomplete';
    return Object.freeze({
      rail: provider.rail,
      provider: provider.provider,
      phase: provider.phase,
      status,
      checks,
    });
  }));
  const blockingChecks = [
    ...foundation,
    ...providers.flatMap((provider) => provider.checks.filter((check) => check.blocking)),
  ];
  const blockers = Object.freeze(blockingChecks
    .filter((check) => check.state !== 'pass')
    .map((check) => `${check.label}: ${check.detail}`));

  return Object.freeze({
    schemaVersion: 1,
    result: blockers.length === 0 ? 'ready-for-activation-review' : 'blocked',
    liveEffectsVerified: false,
    networkCallsMade: false,
    foundation,
    providers,
    blockers,
    manualProofGates: Object.freeze([
      'Run the current production schema readiness check using the deployment identity; this preflight does not access a database.',
      'Provision the dedicated workspace and named operator through an audited operator workflow; automatic PostgreSQL onboarding is currently locked.',
      'Replace every pilot-facing TEST fixture projection with workspace-scoped production reads before exposing that surface.',
      'Verify provider ownership, billing cap and domain identity in the provider consoles.',
      'Prove authenticated, idempotent webhook receipt and reconciliation with provider test events.',
      'Prove consent, suppression, opt-out, immutable approval and emergency-pause behaviour using owned internal seed contacts.',
      'Prove the live dispatch boundary enforces the dedicated workspace, internal-seed stage, owned-recipient scope and declared maximum recipient count.',
      'Implement and test a runtime-enforced provider-effect kill switch at every live adapter composition and dispatch boundary; configuration declarations are not proof.',
      'Record a separate channel-specific activation approval before enabling any provider effect.',
    ]),
  });
}

export function runPropertyPredatorPilotPreflight(
  env: NodeJS.ProcessEnv,
): PropertyPredatorPilotPreflightReport {
  return evaluatePropertyPredatorPilotPreflight(sanitizePropertyPredatorPilotEnvironment(env));
}

function stateToken(state: PreflightCheckState): string {
  return state === 'pass' ? 'PASS' : state === 'missing' ? 'MISSING' : 'INVALID';
}

/** Human-readable output containing setting names only; values are never rendered. */
export function formatPropertyPredatorPilotPreflight(
  report: PropertyPredatorPilotPreflightReport,
): string {
  const lines = [
    'Property Predator controlled live-pilot preflight',
    'Configuration proof only — no database or provider connection was attempted.',
    `Result: ${report.result === 'ready-for-activation-review' ? 'READY FOR MANUAL ACTIVATION REVIEW' : 'BLOCKED'}`,
    'Live effects verified: NO',
    '',
    'Mandatory foundation',
    ...report.foundation.map((check) => `[${stateToken(check.state)}] ${check.setting} — ${check.label}`),
  ];
  for (const provider of report.providers) {
    lines.push(
      '',
      `${provider.phase === 'mandatory-first-channel' ? 'Mandatory first channel' : 'Deferred rail'}: ${provider.provider} (${provider.rail}) — ${provider.status}`,
      ...provider.checks.map((check) => `[${stateToken(check.state)}] ${check.setting} — ${check.label}`),
    );
  }
  if (report.blockers.length) {
    lines.push('', 'Blocking configuration', ...report.blockers.map((blocker) => `- ${blocker}`));
  }
  lines.push('', 'Manual proof gates (always required)', ...report.manualProofGates.map((gate) => `- ${gate}`));
  return lines.join('\n');
}
