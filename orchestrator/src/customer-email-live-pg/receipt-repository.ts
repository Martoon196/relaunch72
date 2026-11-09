import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';
import {
  CustomerEmailLivePgContractError,
  type CustomerEmailSignedReceiptDisposition,
  type CustomerEmailSignedReceiptProjector,
  type CustomerEmailSignedReceiptProjectorDependencies,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EVENT_ID = /^[A-Za-z0-9._:+/=-]{1,255}$/u;
const DISPOSITIONS = new Set<CustomerEmailSignedReceiptDisposition>([
  'applied', 'replayed', 'not_applicable',
]);

interface DispositionRow extends QueryResultRow { disposition: unknown }

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new CustomerEmailLivePgContractError(`${label} must be a UUID`);
  }
  return value;
}

export class PgCustomerEmailSignedReceiptProjector
implements CustomerEmailSignedReceiptProjector {
  readonly #workspaceId: string;
  readonly #providerConnectionId: string;

  constructor(private readonly dependencies: CustomerEmailSignedReceiptProjectorDependencies) {
    this.#workspaceId = uuid(dependencies.workspaceId, 'workspaceId');
    this.#providerConnectionId = uuid(
      dependencies.providerConnectionId,
      'providerConnectionId',
    );
  }

  async recordSignedReceipt(
    externalEventId: string,
  ): Promise<CustomerEmailSignedReceiptDisposition> {
    if (typeof externalEventId !== 'string' || !EVENT_ID.test(externalEventId)) {
      throw new CustomerEmailLivePgContractError('externalEventId is invalid');
    }
    const requestId = `customer-email-receipt:${createHash('sha256')
      .update(externalEventId, 'utf8').digest('hex').slice(0, 48)}`;
    return withTransaction(
      this.dependencies.commandPool,
      {
        actorKind: 'webhook',
        workspaceId: this.#workspaceId,
        requestId,
      },
      async (transaction) => {
        const result = await transaction.query<DispositionRow>(
          `/* customer-email-live.record-signed-receipt */
           SELECT app_private.record_customer_email_signed_receipt(
             $1::uuid, $2::uuid, $3::text
           ) AS disposition`,
          [this.#workspaceId, this.#providerConnectionId, externalEventId],
        );
        const disposition = result.rows[0]?.disposition;
        if (result.rows.length !== 1 || typeof disposition !== 'string'
            || !DISPOSITIONS.has(disposition as CustomerEmailSignedReceiptDisposition)) {
          throw new CustomerEmailLivePgContractError(
            'signed receipt projector returned an invalid disposition',
          );
        }
        return disposition as CustomerEmailSignedReceiptDisposition;
      },
      { isolation: 'serializable' },
    );
  }
}

export function createPgCustomerEmailSignedReceiptProjector(
  dependencies: CustomerEmailSignedReceiptProjectorDependencies,
): CustomerEmailSignedReceiptProjector {
  return new PgCustomerEmailSignedReceiptProjector(dependencies);
}
