/**
 * Property Predator controlled-pilot configuration preflight.
 *
 * This module deliberately does not import a provider SDK, open a socket, or
 * expose a credential. Raw environment values are reduced immediately to
 * boolean evidence; the pure evaluator and every serialisable result see only
 * setting names plus pass/fail state.
 */

export type PilotRailId = 'customer_email' | 'whatsapp' | 'owned_social' | 'sms' | 'social_dm';
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
  readonly status: 'configuration-ready' | 'incomplete' | 'not-configured' | 'not-composed';
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
  readonly composed?: boolean;
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

function isEmail(raw: string): boolean {
  const value = raw.trim();
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isInternalRecipientCap(raw: string): boolean {
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= 1 && value <= 25;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const META_ID = /^[1-9][0-9]{4,29}$/;
const SAFE_SECRET = /^[\x21-\x7e]{8,2000}$/;

function isUuid(raw: string): boolean {
  return UUID.test(raw.trim());
}

function isKeyVersion(raw: string): boolean {
  return KEY_VERSION.test(raw.trim());
}

function isMetaId(raw: string): boolean {
  return META_ID.test(raw.trim());
}

function isSafeSecret(raw: string, minimum = 8): boolean {
  const value = raw.trim();
  return value.length >= minimum && SAFE_SECRET.test(value);
}

function isCanonicalBase64Key32(raw: string): boolean {
  const value = raw.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

function isExactMailgunFrom(raw: string): boolean {
  const value = raw.trim();
  return isEmail(value)
    && value === value.toLowerCase()
    && value.split('@')[1] === 'mg.propertypredator.com';
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
  setting('PORTAL_PROXY_MODE', 'Trusted Render proxy boundary', exact('render'), 'Strict Render CF-Connecting-IP source resolution; X-Forwarded-For ignored'),
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
  setting('PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID', 'Database installation identity', isUuid, 'The exact migrated database installation UUID'),
  setting('PROPERTY_PREDATOR_PILOT_WORKSPACE_ID', 'Dedicated pilot workspace', matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i), 'A dedicated Property Predator production workspace UUID'),
  setting('PROPERTY_PREDATOR_PILOT_STAGE', 'Internal seed stage', exact('internal-seed'), 'The internal-seed pilot stage'),
  setting('PROPERTY_PREDATOR_PILOT_RECIPIENT_SCOPE', 'Recipient safety scope', exact('owned-internal-seeds-only'), 'The owned-internal-seeds-only recipient scope'),
  setting('PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS', 'Declared internal recipient cap', isInternalRecipientCap, 'An internal seed-recipient cap from 1 to 25'),
]);

export const PILOT_PROVIDER_CATALOGUE: readonly ProviderSpec[] = Object.freeze([
  Object.freeze({
    rail: 'customer_email', provider: 'Mailgun EU customer email', phase: 'mandatory-first-channel', settings: Object.freeze([
      setting('DATABASE_CUSTOMER_EMAIL_COMMAND_URL', 'Customer-email command database identity', isProductionDatabaseUrl('r72_customer_email_command'), 'The function-only r72_customer_email_command database URL'),
      setting('DATABASE_CUSTOMER_EMAIL_WORKER_URL', 'Customer-email worker database identity', isProductionDatabaseUrl('r72_customer_email_worker_command'), 'The function-only r72_customer_email_worker_command database URL'),
      setting('DATABASE_CUSTOMER_EMAIL_WEBHOOK_URL', 'Customer-email receipt database identity', isProductionDatabaseUrl('r72_customer_email_webhook_command'), 'The function-only r72_customer_email_webhook_command database URL'),
      setting('PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_MODE', 'Customer-email live mode', exact('customer_live'), 'The exact customer_live worker mode'),
      setting('PROPERTY_PREDATOR_CUSTOMER_EMAIL_PROVIDER_ID', 'Customer-email provider binding', exact('mailgun_eu'), 'The exact mailgun_eu provider binding'),
      setting('PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'Provider effects switch', exact('true'), 'The exact reviewed provider-effects switch'),
      setting('PROPERTY_PREDATOR_CUSTOMER_EMAIL_DELIVERY_ENABLED', 'Customer-email delivery switch', exact('true'), 'The exact customer-email delivery switch'),
      setting('PROPERTY_PREDATOR_CUSTOMER_EMAIL_EMERGENCY_PAUSED', 'Customer-email emergency pause', exact('false'), 'The reviewed released customer-email emergency pause'),
      setting('PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_ENABLED', 'Signed receipt projector', exact('true'), 'The signed customer-email receipt projector'),
      setting('PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_CONFIRMED', 'Signed receipt operator attestation', exact('true'), 'The operator attestation recorded only after signed receipt proof'),
      setting('PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_WORKSPACE_ID', 'Customer-email workspace binding', isUuid, 'The exact owned pilot workspace UUID'),
      setting('PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_CONNECTION_ID', 'Customer-email provider connection binding', isUuid, 'The exact Mailgun provider connection UUID'),
      setting('MAILGUN_SIGNING_KEY', 'Mailgun webhook signing key', minLength(24), 'A secret-manager Mailgun webhook signing key'),
      setting('MAILGUN_REGION', 'Mailgun data region', exact('eu'), 'The Mailgun EU region'),
      setting('MAILGUN_SENDING_DOMAIN', 'Verified sending domain', exact('mg.propertypredator.com'), 'The exact verified mg.propertypredator.com sending domain'),
      setting('MAILGUN_KEY_SCOPE', 'Mailgun key scope', exact('domain-sending'), 'A domain-sending-only Mailgun key'),
      setting('MAILGUN_DOMAIN_SENDING_KEY', 'Mailgun domain-sending key', (raw) => isSafeSecret(raw), 'The secret-manager domain-sending key for mg.propertypredator.com'),
      setting('MAILGUN_FROM_EMAIL', 'Verified From identity', isExactMailgunFrom, 'A canonical verified From identity on mg.propertypredator.com'),
      setting('MAILGUN_EVENT_WEBHOOK_URL', 'Signed delivery-event callback', isHttpsUrl, 'An HTTPS Mailgun event callback'),
      setting('PROPERTY_PREDATOR_MAILGUN_WEBHOOK_ENABLED', 'Mailgun signed webhook ingress', exact('true'), 'The canonical signed Mailgun webhook ingress'),
      setting('MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED', 'Webhook signature verification', exact('true'), 'Cryptographic Mailgun webhook verification'),
      setting('MAILGUN_DNS_VERIFIED', 'Mailgun DNS verification evidence', exact('true'), 'Explicit Mailgun SPF/DKIM verification evidence'),
      setting('MAILGUN_SUPPRESSION_SYNC_ENABLED', 'Suppression synchronisation gate', exact('true'), 'Suppression synchronisation'),
    ]),
  }),
  Object.freeze({
    rail: 'whatsapp', provider: 'Meta WhatsApp Cloud', phase: 'deferred', settings: Object.freeze([
      setting('DATABASE_WHATSAPP_LIVE_COMMAND_URL', 'WhatsApp command database identity', isProductionDatabaseUrl('r72_whatsapp_live_command'), 'The function-only r72_whatsapp_live_command database URL'),
      setting('DATABASE_WHATSAPP_LIVE_WORKER_URL', 'WhatsApp worker database identity', isProductionDatabaseUrl('r72_whatsapp_live_worker_command'), 'The function-only r72_whatsapp_live_worker_command database URL'),
      setting('DATABASE_WHATSAPP_LIVE_WEBHOOK_URL', 'WhatsApp webhook database identity', isProductionDatabaseUrl('r72_whatsapp_live_webhook_command'), 'The function-only r72_whatsapp_live_webhook_command database URL'),
      setting('PROPERTY_PREDATOR_WHATSAPP_LIVE_MODE', 'WhatsApp live mode', exact('owned_template_live'), 'The exact owned-template live worker mode'),
      setting('PROPERTY_PREDATOR_WHATSAPP_WEBHOOK_MODE', 'WhatsApp signed webhook mode', exact('signed_live'), 'The exact signed-live webhook mode'),
      setting('PROPERTY_PREDATOR_WHATSAPP_LIVE_PROVIDER_ID', 'WhatsApp provider binding', exact('meta_whatsapp_cloud'), 'The exact Meta WhatsApp Cloud provider binding'),
      setting('PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'Provider effects switch', exact('true'), 'The exact reviewed provider-effects switch'),
      setting('PROPERTY_PREDATOR_WHATSAPP_EMERGENCY_PAUSED', 'WhatsApp emergency pause', exact('false'), 'The reviewed released WhatsApp emergency pause'),
      setting('PROPERTY_PREDATOR_WHATSAPP_LIVE_WORKSPACE_ID', 'WhatsApp workspace binding', isUuid, 'The exact owned pilot workspace UUID'),
      setting('PROPERTY_PREDATOR_WHATSAPP_LIVE_CONNECTION_ID', 'WhatsApp connection binding', isUuid, 'The exact Meta provider connection UUID'),
      setting('PROPERTY_PREDATOR_WHATSAPP_LIVE_BINDING_ID', 'WhatsApp owned-number binding', isUuid, 'The exact non-revoked owned-number binding UUID'),
      setting('PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_BASE64', 'WhatsApp envelope key', isCanonicalBase64Key32, 'A canonical 32-byte job-envelope key'),
      setting('PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_VERSION', 'WhatsApp envelope key version', isKeyVersion, 'A bounded envelope key version'),
      setting('PROPERTY_PREDATOR_META_WHATSAPP_APP_ID', 'Meta app identity', isMetaId, 'The exact owned Meta app ID'),
      setting('PROPERTY_PREDATOR_META_WHATSAPP_WABA_ID', 'Meta WABA identity', isMetaId, 'The exact owned WABA ID'),
      setting('PROPERTY_PREDATOR_META_WHATSAPP_PHONE_NUMBER_ID', 'Meta phone-number identity', isMetaId, 'The exact owned business phone-number ID'),
      setting('PROPERTY_PREDATOR_META_WHATSAPP_APP_SECRET', 'Meta webhook app secret', (raw) => isSafeSecret(raw, 20), 'The webhook-only Meta app secret'),
      setting('PROPERTY_PREDATOR_META_WHATSAPP_VERIFY_TOKEN', 'Meta webhook verify token', (raw) => isSafeSecret(raw, 20), 'The webhook-only Meta verification token'),
    ]),
  }),
  Object.freeze({
    rail: 'owned_social', provider: 'Ayrshare Instagram + LinkedIn', phase: 'deferred', settings: Object.freeze([
      setting('DATABASE_OWNED_SOCIAL_COMMAND_URL', 'Owned-social command database identity', isProductionDatabaseUrl('r72_owned_social_command'), 'The function-only r72_owned_social_command database URL'),
      setting('DATABASE_OWNED_SOCIAL_WORKER_URL', 'Owned-social worker database identity', isProductionDatabaseUrl('r72_owned_social_worker_command'), 'The function-only r72_owned_social_worker_command database URL'),
      setting('PROPERTY_PREDATOR_SOCIAL_PROVIDER', 'Selected social provider', exact('ayrshare'), 'Ayrshare as the pilot social provider'),
      setting('PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE', 'Owned-social live mode', exact('owned_profile_live'), 'The exact owned-profile live worker mode'),
      setting('PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_PROVIDER_ID', 'Owned-social provider binding', exact('ayrshare'), 'The exact Ayrshare provider binding'),
      setting('PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_NETWORK', 'Owned-social network binding', exact('instagram_linkedin'), 'The exact Instagram + LinkedIn network binding'),
      setting('PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'Provider effects switch', exact('true'), 'The exact reviewed provider-effects switch'),
      setting('PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED', 'Owned-social emergency pause', exact('false'), 'The reviewed released owned-social emergency pause'),
      setting('PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_WORKSPACE_ID', 'Owned-social workspace binding', isUuid, 'The exact owned pilot workspace UUID'),
      setting('PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_CONNECTION_ID', 'Owned-social connection binding', isUuid, 'The exact Ayrshare provider connection UUID'),
      setting('PROPERTY_PREDATOR_PUBLIC_SOCIAL_PROFILE_ENCRYPTION_KEY_BASE64', 'Owned-social profile-envelope key', isCanonicalBase64Key32, 'A canonical 32-byte profile-envelope key'),
      setting('PROPERTY_PREDATOR_PUBLIC_SOCIAL_PROFILE_ENCRYPTION_KEY_VERSION', 'Owned-social profile-envelope key version', isKeyVersion, 'A bounded profile-envelope key version'),
      setting('AYRSHARE_API_KEY', 'Ayrshare API key', (raw) => isSafeSecret(raw), 'The Ayrshare account API key'),
      setting('PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_ORIGIN', 'Approved social-media origin', (raw) => isHttpsUrl(raw, true), 'The exact credential-free HTTPS origin for approved social media'),
      setting('AYRSHARE_PROFILE_LINK_COMPLETE', 'Social account-link proof', exact('true'), 'Explicit account-link completion evidence'),
    ]),
  }),
  Object.freeze({
    rail: 'sms', provider: 'Twilio Messaging UK SMS', phase: 'deferred', settings: Object.freeze([
      setting('DATABASE_SMS_COMMAND_URL', 'SMS command database identity', isProductionDatabaseUrl('r72_sms_command'), 'The function-only r72_sms_command database URL'),
      setting('DATABASE_SMS_WORKER_URL', 'SMS worker database identity', isProductionDatabaseUrl('r72_sms_worker_command'), 'The function-only r72_sms_worker_command database URL'),
      setting('DATABASE_SMS_WEBHOOK_URL', 'SMS webhook database identity', isProductionDatabaseUrl('r72_sms_webhook_command'), 'The function-only r72_sms_webhook_command database URL'),
      setting('PROPERTY_PREDATOR_SMS_LIVE_MODE', 'SMS live mode', exact('owned_number_live'), 'The exact owned-number live worker mode'),
      setting('PROPERTY_PREDATOR_SMS_PROVIDER_ID', 'SMS provider binding', exact('twilio_messaging'), 'The exact twilio_messaging provider binding'),
      setting('PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'Provider effects switch', exact('true'), 'The exact reviewed provider-effects switch'),
      setting('PROPERTY_PREDATOR_SMS_DELIVERY_ENABLED', 'SMS delivery switch', exact('true'), 'The exact SMS delivery switch'),
      setting('PROPERTY_PREDATOR_SMS_EMERGENCY_PAUSED', 'SMS emergency pause', exact('false'), 'The reviewed released SMS emergency pause'),
      setting('PROPERTY_PREDATOR_SMS_RECEIPTS_CONFIRMED', 'Signed SMS receipt operator attestation', exact('true'), 'The operator attestation recorded only after signed receipt proof'),
      setting('PROPERTY_PREDATOR_SMS_WEBHOOK_MODE', 'SMS signed webhook mode', exact('signed_live'), 'The exact signed-live webhook mode'),
      setting('PROPERTY_PREDATOR_SMS_LIVE_WORKSPACE_ID', 'SMS workspace binding', isUuid, 'The exact owned pilot workspace UUID'),
      setting('PROPERTY_PREDATOR_SMS_LIVE_CONNECTION_ID', 'SMS provider connection binding', isUuid, 'The exact Twilio provider connection UUID'),
      setting('PROPERTY_PREDATOR_SMS_ACCOUNT_SID', 'Twilio account identity', matches(/^AC[a-f0-9]{32}$/), 'The exact owned Twilio account SID'),
      setting('TWILIO_API_KEY_SID', 'Twilio restricted API key identity', matches(/^SK[a-f0-9]{32}$/), 'The worker-only restricted Twilio API key SID'),
      setting('TWILIO_API_KEY_SECRET', 'Twilio restricted API key secret', (raw) => isSafeSecret(raw, 16), 'The worker-only restricted Twilio API key secret'),
      setting('TWILIO_MESSAGING_SERVICE_SID', 'Twilio Messaging Service identity', matches(/^MG[a-f0-9]{32}$/), 'The exact owned Twilio Messaging Service SID'),
      setting('TWILIO_UK_REGULATORY_BUNDLE_SID', 'Twilio UK regulatory bundle', matches(/^BU[a-f0-9]{32}$/), 'The approved Twilio UK regulatory bundle SID'),
      setting('PROPERTY_PREDATOR_SMS_SENDER_NUMBER', 'Owned UK sender number', matches(/^\+44[0-9]{9,10}$/), 'The exact owned UK E.164 sender number'),
      setting('PROPERTY_PREDATOR_SMS_WEBHOOK_PUBLIC_ORIGIN', 'SMS webhook public origin', (raw) => isHttpsUrl(raw, true), 'A single credential-free HTTPS SMS webhook origin'),
      setting('TWILIO_AUTH_TOKEN', 'Twilio webhook signature key', (raw) => isSafeSecret(raw, 16), 'The webhook-only Twilio auth token'),
      setting('TWILIO_KEY_SCOPE', 'Twilio key scope', exact('restricted-api-key'), 'A restricted-api-key-only Twilio key'),
    ]),
  }),
  Object.freeze({
    rail: 'social_dm',
    provider: 'Meta Facebook and Instagram DMs',
    phase: 'deferred',
    composed: false,
    settings: Object.freeze([]),
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
    // The provider-effects switch is shared by every live worker. It must not
    // make an otherwise untouched deferred rail look partially configured.
    const configuredCount = checks.filter((check) => (
      check.setting !== 'PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED'
      && check.state !== 'missing'
    )).length;
    const status = provider.composed === false
      ? 'not-composed'
      : checks.every((check) => check.state === 'pass')
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
      'Run schema and installation readiness through migration 0057 using each exact function-only runtime identity; this preflight does not access a database.',
      'Provision the dedicated workspace and named operator through an audited operator workflow; automatic PostgreSQL onboarding is currently locked.',
      'Verify the exact Mailgun domain, Meta app/WABA/phone and Ayrshare-owned X profile in their provider consoles without inferring any customer target.',
      'Apply credentials to their isolated services only: Mailgun sending versus webhook keys, and WhatsApp worker envelope key versus webhook app secret/verify token, must never share a process.',
      'Record the exact live provider connection, channel binding/profile, current content approval, operator authority and consent/suppression evidence in PostgreSQL.',
      'Prove the signed Mailgun and Meta webhook challenge/status/inbound paths with provider test events before releasing receipt attestations.',
      'Prove the signed Twilio inbound and status callback paths with provider test events against the founder-owned UK test number before releasing receipt attestations.',
      'Prove the existing enqueue and durable pre-call pause/effects fences using one explicitly supplied owned internal recipient or account per rail.',
      'Stage one exact approved owned test email, parameter-free WhatsApp template and link-free X post; no customer recipient or inferred account is allowed.',
      'Record a separate channel-specific activation approval before enabling any provider effect.',
      'Keep Facebook and Instagram DMs unavailable until their dedicated live adapter, signed webhook binding and reply receipt path are composed; environment values cannot bypass that missing implementation.',
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
