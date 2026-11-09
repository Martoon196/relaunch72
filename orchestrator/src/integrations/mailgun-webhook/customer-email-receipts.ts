const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface CustomerEmailSignedReceiptConfig {
  readonly enabled: boolean;
  readonly configurationReady: boolean;
  readonly blockers: readonly string[];
  readonly workspaceId: string | null;
  readonly providerConnectionId: string | null;
}

function exactUuid(value: string | undefined): string | null {
  const candidate = value?.trim().toLowerCase() ?? '';
  return UUID.test(candidate) ? candidate : null;
}

/**
 * This switch adds no route and performs no provider action. It only allows an
 * already authenticated event on the canonical Mailgun route to be projected
 * through the receipt-only 0054 database identity.
 */
export function loadCustomerEmailSignedReceiptConfig(
  env: NodeJS.ProcessEnv,
): CustomerEmailSignedReceiptConfig {
  const rawEnable = env.PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_ENABLED?.trim() ?? '';
  const attemptedEnable = rawEnable !== '' && rawEnable !== 'false';
  if (!attemptedEnable) {
    return Object.freeze({
      enabled: false,
      configurationReady: true,
      blockers: Object.freeze([]),
      workspaceId: null,
      providerConnectionId: null,
    });
  }

  const blockers: string[] = [];
  if (rawEnable !== 'true') blockers.push('Customer-email receipt enablement must be exact true');
  if (env.PROPERTY_PREDATOR_MAILGUN_WEBHOOK_ENABLED?.trim() !== 'true') {
    blockers.push('Canonical signed Mailgun webhook ingress is not enabled');
  }
  if (env.MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED?.trim() !== 'true') {
    blockers.push('Mailgun signature verification is not explicitly enabled');
  }
  const workspaceId = exactUuid(env.PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_WORKSPACE_ID);
  if (!workspaceId) blockers.push('Customer-email receipt workspace binding is invalid');
  const ingressWorkspaceId = exactUuid(env.PROPERTY_PREDATOR_PILOT_WORKSPACE_ID);
  if (workspaceId && ingressWorkspaceId !== workspaceId) {
    blockers.push('Customer-email workspace does not match canonical Mailgun ingress');
  }
  const providerConnectionId = exactUuid(
    env.PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_CONNECTION_ID,
  );
  if (!providerConnectionId) {
    blockers.push('Customer-email receipt provider-connection binding is invalid');
  }
  const ingressProviderConnectionId = exactUuid(
    env.PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID,
  );
  if (providerConnectionId && ingressProviderConnectionId !== providerConnectionId) {
    blockers.push('Customer-email connection does not match canonical Mailgun ingress');
  }
  return Object.freeze({
    enabled: true,
    configurationReady: blockers.length === 0,
    blockers: Object.freeze(blockers),
    workspaceId,
    providerConnectionId,
  });
}
