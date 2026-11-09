import type { Pool } from 'pg';
import { createTestInboxWebhookCommandDatabasePool } from '../../db/pool.js';
import {
  PgTestInboxWebhookRepository,
  assertPgTestInboxWebhookIngressReady,
  type TestInboxWebhookTrustedBinding,
} from '../../test-inbox-webhook-pg/index.js';
import { loadPropertyPredatorSimulatedInboundConfig } from './config.js';
import { createRepositoryBackedSimulatedInboundCommandService } from './repository-command-service.js';
import {
  createSimulatedMetaDmInboundWebhookHandler,
  createSimulatedWhatsAppInboundWebhookHandler,
  type PropertyPredatorSimulatedMetaDmInboundMount,
  type PropertyPredatorSimulatedWhatsAppInboundMount,
} from './router.js';

type TestInboxWebhookPool = Pick<Pool, 'query' | 'connect' | 'end'>;

export interface PropertyPredatorSimulatedInboundComposition {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly whatsapp: PropertyPredatorSimulatedWhatsAppInboundMount;
  readonly metaDm: PropertyPredatorSimulatedMetaDmInboundMount;
  assertReady(): Promise<void>;
  close(): Promise<void>;
}

export interface PropertyPredatorSimulatedInboundCompositionDependencies {
  readonly createPool?: (env: NodeJS.ProcessEnv) => TestInboxWebhookPool;
  readonly assertBindingReady?: (
    pool: Pick<Pool, 'query' | 'connect'>,
    binding: Readonly<TestInboxWebhookTrustedBinding>,
    installationId: string,
  ) => Promise<void>;
}

function trustedBinding(
  providerId: TestInboxWebhookTrustedBinding['providerId'],
  binding: Readonly<{
    workspaceId: string;
    connectionId: string;
    inboxId: string;
    contactId: string;
    contactPointId: string;
  }>,
): TestInboxWebhookTrustedBinding {
  return Object.freeze({
    workspaceId: binding.workspaceId,
    providerConnectionId: binding.connectionId,
    providerId,
    inboxId: binding.inboxId,
    contactId: binding.contactId,
    contactPointId: binding.contactPointId,
  });
}

function darkMount(enabled: boolean, blockers: readonly string[]):
PropertyPredatorSimulatedWhatsAppInboundMount {
  return Object.freeze({
    enabled,
    ready: false,
    blockers: Object.freeze([...blockers]),
  });
}

/**
 * Compose one least-privilege TEST inbox pool. This function has no provider
 * client or outbound network seam: it only verifies signed simulated events
 * and invokes the function-only PostgreSQL recorder.
 */
export async function composePropertyPredatorSimulatedInbound(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: PropertyPredatorSimulatedInboundCompositionDependencies = {},
): Promise<PropertyPredatorSimulatedInboundComposition> {
  const config = loadPropertyPredatorSimulatedInboundConfig(env);
  const createPool = dependencies.createPool
    ?? ((sourceEnv: NodeJS.ProcessEnv) => createTestInboxWebhookCommandDatabasePool(sourceEnv));
  const assertBindingReady = dependencies.assertBindingReady
    ?? assertPgTestInboxWebhookIngressReady;
  let pool: TestInboxWebhookPool | undefined;
  let closed = false;
  let readinessBindings: readonly TestInboxWebhookTrustedBinding[] = Object.freeze([]);

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const ownedPool = pool;
    pool = undefined;
    await ownedPool?.end();
  };
  const assertReady = async (): Promise<void> => {
    if (!config.enabled) return;
    if (closed || !pool || !config.configurationReady || !config.installationId) {
      throw new Error('Simulated inbound protected runtime is unavailable');
    }
    await Promise.all(readinessBindings.map((binding) =>
      assertBindingReady(pool!, binding, config.installationId!)));
  };

  if (!config.enabled) {
    return Object.freeze({
      enabled: false,
      ready: false,
      whatsapp: darkMount(false, []),
      metaDm: darkMount(false, []),
      assertReady,
      close,
    });
  }
  if (!config.configurationReady || !config.installationId) {
    return Object.freeze({
      enabled: true,
      ready: false,
      whatsapp: darkMount(
        config.whatsapp.enabled,
        config.whatsapp.enabled ? config.blockers : [],
      ),
      metaDm: darkMount(
        config.metaDm.enabled,
        config.metaDm.enabled ? config.blockers : [],
      ),
      assertReady,
      close,
    });
  }

  const bindings: TestInboxWebhookTrustedBinding[] = [];
  if (config.whatsapp.enabled && config.whatsapp.binding) {
    bindings.push(trustedBinding('whatsapp_dark_simulator', config.whatsapp.binding));
  }
  if (config.metaDm.enabled && config.metaDm.bindings) {
    bindings.push(
      trustedBinding('social_dm_dark_simulator', config.metaDm.bindings.facebook),
      trustedBinding('social_dm_dark_simulator', config.metaDm.bindings.instagram),
    );
  }
  readinessBindings = Object.freeze([...bindings]);

  try {
    pool = createPool(env);
    await assertReady();

    let whatsapp: PropertyPredatorSimulatedWhatsAppInboundMount = darkMount(false, []);
    if (config.whatsapp.enabled && config.whatsapp.binding && config.whatsapp.testSecret) {
      const repository = new PgTestInboxWebhookRepository({
        commandPool: pool,
        binding: trustedBinding('whatsapp_dark_simulator', config.whatsapp.binding),
      });
      whatsapp = Object.freeze({
        enabled: true,
        ready: true,
        blockers: Object.freeze([]),
        handle: createSimulatedWhatsAppInboundWebhookHandler({
          testSecret: config.whatsapp.testSecret,
          binding: config.whatsapp.binding,
          commandService: createRepositoryBackedSimulatedInboundCommandService(repository),
        }),
      });
    }

    let metaDm: PropertyPredatorSimulatedMetaDmInboundMount = darkMount(false, []);
    if (config.metaDm.enabled && config.metaDm.bindings && config.metaDm.testSecret) {
      const facebookRepository = new PgTestInboxWebhookRepository({
        commandPool: pool,
        binding: trustedBinding(
          'social_dm_dark_simulator',
          config.metaDm.bindings.facebook,
        ),
      });
      const instagramRepository = new PgTestInboxWebhookRepository({
        commandPool: pool,
        binding: trustedBinding(
          'social_dm_dark_simulator',
          config.metaDm.bindings.instagram,
        ),
      });
      metaDm = Object.freeze({
        enabled: true,
        ready: true,
        blockers: Object.freeze([]),
        handle: createSimulatedMetaDmInboundWebhookHandler({
          testSecret: config.metaDm.testSecret,
          bindings: config.metaDm.bindings,
          commandServices: {
            facebook: createRepositoryBackedSimulatedInboundCommandService(facebookRepository),
            instagram: createRepositoryBackedSimulatedInboundCommandService(instagramRepository),
          },
        }),
      });
    }

    return Object.freeze({
      enabled: true,
      ready: true,
      whatsapp,
      metaDm,
      assertReady,
      close,
    });
  } catch {
    await Promise.allSettled([close()]);
    const blockers = Object.freeze([
      'Simulated inbound protected runtime did not pass readiness',
    ]);
    return Object.freeze({
      enabled: true,
      ready: false,
      whatsapp: darkMount(
        config.whatsapp.enabled,
        config.whatsapp.enabled ? blockers : [],
      ),
      metaDm: darkMount(
        config.metaDm.enabled,
        config.metaDm.enabled ? blockers : [],
      ),
      assertReady,
      close,
    });
  }
}
