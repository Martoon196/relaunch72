export type DatabaseActorKind = 'user' | 'worker' | 'webhook' | 'system';

export interface DatabaseRequestContext {
  actorKind: DatabaseActorKind;
  workspaceId: string;
  userId?: string;
  requestId: string;
  /** Exact opaque portal token hash, revalidated in the domain transaction. */
  portalSessionTokenHash?: Buffer;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;
const DATABASE_ACTOR_KINDS = new Set<DatabaseActorKind>(['user', 'worker', 'webhook', 'system']);

export function validateDatabaseContext(context: DatabaseRequestContext): void {
  if (!DATABASE_ACTOR_KINDS.has(context.actorKind)) {
    throw new Error('Database context actorKind must be user, worker, webhook or system');
  }
  if (!UUID_PATTERN.test(context.workspaceId)) {
    throw new Error('Database context workspaceId must be a UUID');
  }
  if (context.userId !== undefined && !UUID_PATTERN.test(context.userId)) {
    throw new Error('Database context userId must be a UUID when supplied');
  }
  if (context.actorKind === 'user' && !context.userId) {
    throw new Error('A user database context requires userId');
  }
  if (context.actorKind !== 'user' && context.userId !== undefined) {
    throw new Error('A non-user database context must not carry userId');
  }
  if (!REQUEST_ID_PATTERN.test(context.requestId)) {
    throw new Error('Database context requestId must be 1-128 printable ASCII characters');
  }
  if (context.portalSessionTokenHash !== undefined
      && (!Buffer.isBuffer(context.portalSessionTokenHash) || context.portalSessionTokenHash.length !== 32)) {
    throw new Error('Database context portalSessionTokenHash must be a 32-byte Buffer when supplied');
  }
  if (context.portalSessionTokenHash !== undefined && context.actorKind !== 'user') {
    throw new Error('Only a user database context may carry a portal session hash');
  }
}

export function requestDatabaseContext(input: {
  workspaceId: string;
  userId: string;
  requestId: string;
  portalSessionTokenHash?: Buffer;
}): DatabaseRequestContext {
  return { ...input, actorKind: 'user' };
}

export function workerDatabaseContext(input: {
  workspaceId: string;
  requestId: string;
}): DatabaseRequestContext {
  return { ...input, actorKind: 'worker' };
}
