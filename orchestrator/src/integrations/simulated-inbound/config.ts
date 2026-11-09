import { socialDmDarkTestAddress } from '../../social-dm-dark/contracts.js';
import { assertReservedWhatsAppTestNumber } from '../../whatsapp-dark/contracts.js';
import type { OwnInboxWhatsAppBinding } from '../../whatsapp-dark/webhook.js';
import type { FacebookInstagramDmOwnInboxBindings } from './router.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SECRET = /^[\x21-\x7e]{32,256}$/u;

export interface PropertyPredatorSimulatedInboundConfig {
  readonly enabled: boolean;
  readonly configurationReady: boolean;
  /** Fixed, non-sensitive operator messages only. */
  readonly blockers: readonly string[];
  readonly installationId: string | null;
  readonly whatsapp: Readonly<{
    enabled: boolean;
    testSecret: string | null;
    binding: OwnInboxWhatsAppBinding | null;
  }>;
  readonly metaDm: Readonly<{
    enabled: boolean;
    testSecret: string | null;
    bindings: FacebookInstagramDmOwnInboxBindings | null;
  }>;
}

function enablement(raw: string | undefined): Readonly<{
  enabled: boolean;
  exact: boolean;
}> {
  if (raw === undefined || raw === '' || raw === 'false') {
    return Object.freeze({ enabled: false, exact: true });
  }
  return Object.freeze({ enabled: true, exact: raw === 'true' });
}

function uuid(raw: string | undefined): string | null {
  return typeof raw === 'string' && UUID.test(raw) ? raw : null;
}

function secret(raw: string | undefined): string | null {
  return typeof raw === 'string' && SECRET.test(raw) ? raw : null;
}

function whatsappAddress(raw: string | undefined): string | null {
  try {
    return assertReservedWhatsAppTestNumber(raw, 'test number');
  } catch {
    return null;
  }
}

function metaAddress(
  raw: string | undefined,
  network: 'facebook' | 'instagram',
): string | null {
  try {
    return socialDmDarkTestAddress(raw, network, 'test address');
  } catch {
    return null;
  }
}

function pushOnce(blockers: string[], blocker: string): void {
  if (!blockers.includes(blocker)) blockers.push(blocker);
}

/**
 * Load only TEST simulator ingress. Missing/exact-false stays fully dark;
 * malformed opt-in remains visibly enabled-but-blocked instead of silently
 * weakening into a 404. No blocker contains an environment value or key name.
 */
export function loadPropertyPredatorSimulatedInboundConfig(
  env: NodeJS.ProcessEnv = process.env,
): PropertyPredatorSimulatedInboundConfig {
  const whatsappEnablement = enablement(
    env.PROPERTY_PREDATOR_SIMULATED_WHATSAPP_INBOUND_ENABLED,
  );
  const metaEnablement = enablement(
    env.PROPERTY_PREDATOR_SIMULATED_META_DM_INBOUND_ENABLED,
  );
  const enabled = whatsappEnablement.enabled || metaEnablement.enabled;
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      configurationReady: true,
      blockers: Object.freeze([]),
      installationId: null,
      whatsapp: Object.freeze({ enabled: false, testSecret: null, binding: null }),
      metaDm: Object.freeze({ enabled: false, testSecret: null, bindings: null }),
    });
  }

  const blockers: string[] = [];
  if (!whatsappEnablement.exact || !metaEnablement.exact) {
    blockers.push('Simulated inbound enablement must be exact');
  }
  if (!env.DATABASE_TEST_INBOX_WEBHOOK_URL?.trim()) {
    blockers.push('Simulated inbound database identity is unavailable');
  }
  const installationId = uuid(env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID);
  if (!installationId) {
    blockers.push('Simulated inbound installation binding is unavailable');
  }
  const workspaceId = uuid(env.PROPERTY_PREDATOR_SIMULATED_INBOUND_WORKSPACE_ID);
  if (!workspaceId) {
    blockers.push('Simulated inbound workspace binding is unavailable');
  }

  let whatsappBinding: OwnInboxWhatsAppBinding | null = null;
  let whatsappSecret: string | null = null;
  if (whatsappEnablement.enabled) {
    whatsappSecret = secret(env.PROPERTY_PREDATOR_SIMULATED_WHATSAPP_SIGNING_SECRET);
    if (!whatsappSecret) {
      blockers.push('Simulated WhatsApp signing secret is unavailable');
    }
    const connectionId = uuid(env.PROPERTY_PREDATOR_SIMULATED_WHATSAPP_CONNECTION_ID);
    const inboxId = uuid(env.PROPERTY_PREDATOR_SIMULATED_WHATSAPP_INBOX_ID);
    const contactId = uuid(env.PROPERTY_PREDATOR_SIMULATED_WHATSAPP_CONTACT_ID);
    const contactPointId = uuid(env.PROPERTY_PREDATOR_SIMULATED_WHATSAPP_CONTACT_POINT_ID);
    const ownedTestNumber = whatsappAddress(
      env.PROPERTY_PREDATOR_SIMULATED_WHATSAPP_OWNED_TEST_NUMBER,
    );
    const sourceTestNumber = whatsappAddress(
      env.PROPERTY_PREDATOR_SIMULATED_WHATSAPP_SOURCE_TEST_NUMBER,
    );
    if (!workspaceId || !connectionId || !inboxId || !contactId || !contactPointId
        || !ownedTestNumber || !sourceTestNumber || ownedTestNumber === sourceTestNumber) {
      blockers.push('Simulated WhatsApp TEST binding is incomplete');
    } else {
      whatsappBinding = Object.freeze({
        workspaceId,
        connectionId,
        inboxId,
        contactId,
        contactPointId,
        ownedTestNumber,
        sourceTestNumber,
      });
    }
  }

  let metaBindings: FacebookInstagramDmOwnInboxBindings | null = null;
  let metaSecret: string | null = null;
  if (metaEnablement.enabled) {
    metaSecret = secret(env.PROPERTY_PREDATOR_SIMULATED_META_DM_SIGNING_SECRET);
    if (!metaSecret) {
      blockers.push('Simulated Meta DM signing secret is unavailable');
    }
    const facebook = {
      connectionId: uuid(env.PROPERTY_PREDATOR_SIMULATED_FACEBOOK_CONNECTION_ID),
      inboxId: uuid(env.PROPERTY_PREDATOR_SIMULATED_FACEBOOK_INBOX_ID),
      contactId: uuid(env.PROPERTY_PREDATOR_SIMULATED_FACEBOOK_CONTACT_ID),
      contactPointId: uuid(env.PROPERTY_PREDATOR_SIMULATED_FACEBOOK_CONTACT_POINT_ID),
      ownedTestAddress: metaAddress(
        env.PROPERTY_PREDATOR_SIMULATED_FACEBOOK_OWNED_TEST_ADDRESS,
        'facebook',
      ),
      sourceTestAddress: metaAddress(
        env.PROPERTY_PREDATOR_SIMULATED_FACEBOOK_SOURCE_TEST_ADDRESS,
        'facebook',
      ),
    } as const;
    const instagram = {
      connectionId: uuid(env.PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_CONNECTION_ID),
      inboxId: uuid(env.PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_INBOX_ID),
      contactId: uuid(env.PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_CONTACT_ID),
      contactPointId: uuid(env.PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_CONTACT_POINT_ID),
      ownedTestAddress: metaAddress(
        env.PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_OWNED_TEST_ADDRESS,
        'instagram',
      ),
      sourceTestAddress: metaAddress(
        env.PROPERTY_PREDATOR_SIMULATED_INSTAGRAM_SOURCE_TEST_ADDRESS,
        'instagram',
      ),
    } as const;
    const facebookReady = Object.values(facebook).every((value) => value !== null)
      && facebook.ownedTestAddress !== facebook.sourceTestAddress;
    const instagramReady = Object.values(instagram).every((value) => value !== null)
      && instagram.ownedTestAddress !== instagram.sourceTestAddress;
    if (!workspaceId || !facebookReady || !instagramReady
        || facebook.connectionId === instagram.connectionId) {
      blockers.push('Simulated Meta DM TEST bindings are incomplete');
    } else {
      metaBindings = Object.freeze({
        facebook: Object.freeze({
          workspaceId,
          connectionId: facebook.connectionId!,
          inboxId: facebook.inboxId!,
          contactId: facebook.contactId!,
          contactPointId: facebook.contactPointId!,
          network: 'facebook' as const,
          ownedTestAddress: facebook.ownedTestAddress!,
          sourceTestAddress: facebook.sourceTestAddress!,
        }),
        instagram: Object.freeze({
          workspaceId,
          connectionId: instagram.connectionId!,
          inboxId: instagram.inboxId!,
          contactId: instagram.contactId!,
          contactPointId: instagram.contactPointId!,
          network: 'instagram' as const,
          ownedTestAddress: instagram.ownedTestAddress!,
          sourceTestAddress: instagram.sourceTestAddress!,
        }),
      });
    }
  }

  if (whatsappSecret && metaSecret && whatsappSecret === metaSecret) {
    pushOnce(blockers, 'Simulated inbound signing secrets are not isolated');
  }
  const unrelatedSecrets = [env.SESSION_SECRET, env.MAILGUN_SIGNING_KEY]
    .filter((value): value is string => typeof value === 'string' && value !== '');
  if ((whatsappSecret && unrelatedSecrets.includes(whatsappSecret))
      || (metaSecret && unrelatedSecrets.includes(metaSecret))) {
    pushOnce(blockers, 'Simulated inbound signing secrets are not isolated');
  }

  return Object.freeze({
    enabled: true,
    configurationReady: blockers.length === 0,
    blockers: Object.freeze([...blockers]),
    installationId,
    whatsapp: Object.freeze({
      enabled: whatsappEnablement.enabled,
      testSecret: whatsappSecret,
      binding: whatsappBinding,
    }),
    metaDm: Object.freeze({
      enabled: metaEnablement.enabled,
      testSecret: metaSecret,
      bindings: metaBindings,
    }),
  });
}
