export type CrmCommandErrorCode =
  | 'invalid_command'
  | 'idempotency_key_reused'
  | 'command_in_progress'
  | 'not_found'
  | 'optimistic_conflict'
  | 'invalid_state';

export class CrmCommandError extends Error {
  constructor(
    readonly code: CrmCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidCrmCommandError extends CrmCommandError {
  constructor(message: string) {
    super('invalid_command', message);
  }
}

export class IdempotencyKeyReusedError extends CrmCommandError {
  constructor() {
    super('idempotency_key_reused', 'Idempotency key was already used with a different request');
  }
}

export class CommandInProgressError extends CrmCommandError {
  constructor() {
    super('command_in_progress', 'A command with this idempotency key is already in progress');
  }
}

export class CrmEntityNotFoundError extends CrmCommandError {
  constructor(entity: string) {
    super('not_found', `${entity} was not found in this workspace`);
  }
}

export class OptimisticConflictError extends CrmCommandError {
  constructor(entity: string) {
    super('optimistic_conflict', `${entity} changed since it was loaded`);
  }
}

export class InvalidCrmStateError extends CrmCommandError {
  constructor(message: string) {
    super('invalid_state', message);
  }
}

