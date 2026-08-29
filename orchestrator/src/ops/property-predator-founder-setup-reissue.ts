import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { PROPERTY_PREDATOR_FOUNDER_EMAIL, PROPERTY_PREDATOR_FOUNDER_PORTAL_ORIGIN } from './property-predator-founder-bootstrap.js';
import { PgSetupDeliveryService, type SetupDeliveryKeyring } from '../portal/setup-delivery-pg-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CHANGE_REFERENCE = /^[a-z][a-z0-9._:-]{7,79}$/u;

export interface PropertyPredatorFounderSetupReissueConfig {
  readonly workspaceId: string;
  readonly founderUserId: string;
  readonly changeReference: string;
  readonly setupUrl: `${typeof PROPERTY_PREDATOR_FOUNDER_PORTAL_ORIGIN}/portal/setup`;
}

export interface PropertyPredatorFounderSetupReissueHandoff {
  readonly purpose: 'property-predator-founder-setup-reissue';
  readonly createdNow: boolean;
  readonly workspaceId: string;
  readonly founderUserId: string;
  readonly setupActionTokenId: string;
  readonly setupDeliveryId: string;
  readonly setupDeliveryGeneration: number;
  readonly setupExpiresAt: string;
  readonly recipientEmail: typeof PROPERTY_PREDATOR_FOUNDER_EMAIL;
  readonly setupUrl?: string;
}

export function loadPropertyPredatorFounderSetupReissueConfig(
  env: NodeJS.ProcessEnv = process.env,
): PropertyPredatorFounderSetupReissueConfig {
  const workspaceId = env.PROPERTY_PREDATOR_PILOT_WORKSPACE_ID?.trim().toLowerCase() ?? '';
  const founderUserId = env.PROPERTY_PREDATOR_FOUNDER_USER_ID?.trim().toLowerCase() ?? '';
  const changeReference = env.PROPERTY_PREDATOR_FOUNDER_SETUP_REISSUE_CHANGE_REFERENCE?.trim() ?? '';
  const origin = env.PORTAL_BASE_URL?.trim() ?? '';
  if (workspaceId !== env.PROPERTY_PREDATOR_PILOT_WORKSPACE_ID || !UUID.test(workspaceId)) {
    throw new Error('PROPERTY_PREDATOR_PILOT_WORKSPACE_ID must be a canonical UUID');
  }
  if (founderUserId !== env.PROPERTY_PREDATOR_FOUNDER_USER_ID || !UUID.test(founderUserId)) {
    throw new Error('PROPERTY_PREDATOR_FOUNDER_USER_ID must be a canonical UUID');
  }
  if (changeReference !== env.PROPERTY_PREDATOR_FOUNDER_SETUP_REISSUE_CHANGE_REFERENCE
      || !CHANGE_REFERENCE.test(changeReference)) {
    throw new Error('PROPERTY_PREDATOR_FOUNDER_SETUP_REISSUE_CHANGE_REFERENCE must be a canonical change reference');
  }
  if (origin !== PROPERTY_PREDATOR_FOUNDER_PORTAL_ORIGIN) {
    throw new Error(`PORTAL_BASE_URL must be exactly ${PROPERTY_PREDATOR_FOUNDER_PORTAL_ORIGIN}`);
  }
  return Object.freeze({
    workspaceId,
    founderUserId,
    changeReference,
    setupUrl: `${PROPERTY_PREDATOR_FOUNDER_PORTAL_ORIGIN}/portal/setup`,
  });
}

export async function reissuePropertyPredatorFounderSetup(
  dependencies: Readonly<{
    reissueCommandPool: Pick<Pool, 'query'>;
    keyring: SetupDeliveryKeyring;
    setupTokenBytes?: () => Buffer;
  }>,
  config: PropertyPredatorFounderSetupReissueConfig,
): Promise<PropertyPredatorFounderSetupReissueHandoff> {
  const tokenBytes = (dependencies.setupTokenBytes ?? (() => randomBytes(32)))();
  if (!Buffer.isBuffer(tokenBytes) || tokenBytes.byteLength !== 32) {
    throw new Error('Founder setup reissue token source must return exactly 32 random bytes');
  }
  const setupToken = tokenBytes.toString('base64url');
  try {
    const service = new PgSetupDeliveryService({
      deliveryCommandPool: dependencies.reissueCommandPool,
      reissueCommandPool: dependencies.reissueCommandPool,
      keyring: dependencies.keyring,
      setupUrl: config.setupUrl,
      createSetupToken: () => setupToken,
    });
    const result = await service.reissue({
      idempotencyKey: `pp-founder-setup-reissue:${config.changeReference}`,
      workspaceId: config.workspaceId,
      userId: config.founderUserId,
      operatorRequest: `Property Predator founder setup reissue ${config.changeReference}`,
      recipientEmail: PROPERTY_PREDATOR_FOUNDER_EMAIL,
    });
    return Object.freeze({
      purpose: 'property-predator-founder-setup-reissue' as const,
      createdNow: result.createdNow,
      workspaceId: config.workspaceId,
      founderUserId: config.founderUserId,
      setupActionTokenId: result.setupActionTokenId,
      setupDeliveryId: result.setupDeliveryId,
      setupDeliveryGeneration: result.setupDeliveryGeneration,
      setupExpiresAt: result.setupExpiresAt,
      recipientEmail: PROPERTY_PREDATOR_FOUNDER_EMAIL,
      ...(result.createdNow
        ? { setupUrl: `${config.setupUrl}?token=${encodeURIComponent(setupToken)}` }
        : {}),
    });
  } finally {
    tokenBytes.fill(0);
  }
}
