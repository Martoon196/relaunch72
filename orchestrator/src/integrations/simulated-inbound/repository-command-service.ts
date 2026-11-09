import {
  TestInboxWebhookBindingError,
  TestInboxWebhookEventConflictError,
  TestInboxWebhookSignatureReplayError,
  type TestInboxWebhookRepository,
} from '../../test-inbox-webhook-pg/types.js';
import {
  SimulatedInboundBindingUnavailableError,
  SimulatedInboundEventConflictError,
  type AuthenticatedSimulatedInboundCommand,
  type DurableSimulatedInboundCommandService,
} from './router.js';

/**
 * Honest bridge from the authenticated HTTP boundary to the durable TEST-only
 * recorder. It forwards the authenticated message body plus hashes only;
 * signatures, addresses and the raw HTTP envelope do not cross this seam.
 */
export function createRepositoryBackedSimulatedInboundCommandService(
  repository: TestInboxWebhookRepository,
): DurableSimulatedInboundCommandService {
  return Object.freeze({
    async recordAuthenticatedTestInbound(
      input: AuthenticatedSimulatedInboundCommand,
    ): Promise<Readonly<{ disposition: 'applied' | 'replayed' }>> {
      try {
        const result = await repository.record(Object.freeze({
          workspaceId: input.workspaceId,
          providerConnectionId: input.connectionId,
          providerId: input.providerId,
          inboxId: input.command.inboxId,
          contactId: input.command.contactId,
          contactPointId: input.command.contactPointId,
          externalEventId: input.externalEventId,
          occurredAt: input.occurredAt,
          payloadSha256: Uint8Array.from(input.payloadSha256),
          eventIdentitySha256: Uint8Array.from(input.eventIdentitySha256),
          signatureSha256: Uint8Array.from(input.signatureSha256),
          sourceIdentitySha256: Uint8Array.from(input.sourceIdentitySha256),
          destinationIdentitySha256: Uint8Array.from(input.destinationIdentitySha256),
          body: input.command.body,
        }));
        return Object.freeze({
          disposition: result.replayed ? 'replayed' : 'applied',
        });
      } catch (error) {
        if (error instanceof TestInboxWebhookEventConflictError
            || error instanceof TestInboxWebhookSignatureReplayError) {
          throw new SimulatedInboundEventConflictError();
        }
        if (error instanceof TestInboxWebhookBindingError) {
          throw new SimulatedInboundBindingUnavailableError();
        }
        throw error;
      }
    },
  });
}
