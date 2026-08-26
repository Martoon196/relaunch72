/**
 * First-deploy control-plane policy for Property Predator Growth HQ.
 *
 * This is deliberately narrower than the future activation policy. It proves
 * the public web process cannot send, charge, import or run live generators.
 */
export function propertyPredatorDarkProductionBlockers(
  env: NodeJS.ProcessEnv,
): readonly string[] {
  if (env.NODE_ENV?.trim() !== 'production'
      || env.PORTAL_PRODUCT_PROFILE?.trim() !== 'property_predator_growth') {
    return Object.freeze([]);
  }
  const blockers: string[] = [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const exact = (name: string, expected: string, label: string): void => {
    if (env[name]?.trim() !== expected) blockers.push(`${label} is not locked to ${expected}`);
  };
  exact('PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'false', 'Provider effects');
  exact('PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED', 'false', 'Email delivery');
  exact('PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED', 'true', 'Email emergency pause');
  exact('PUBLIC_LEAD_CAPTURE_ENABLED', 'false', 'Public lead capture');
  exact('PLATFORM_SUBSCRIPTIONS_ENABLED', 'false', 'Platform subscriptions');
  exact('BILLING_ENFORCED', 'false', 'Billing enforcement');
  exact('PORTAL_DEMO_SEED', 'false', 'Portal demo seed');
  exact('RELAUNCH72_FORCE_MOCK_BUILDS', 'true', 'Build execution');
  exact('PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED', 'false', 'External source events');
  exact(
    'PORTAL_BASE_URL',
    'https://hq.propertypredator.com',
    'Canonical Growth HQ origin',
  );
  if (!uuid.test(env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim() ?? '')) {
    blockers.push('Database installation identity is missing or invalid');
  }
  exact('PROPERTY_PREDATOR_MAILGUN_WEBHOOK_ENABLED', 'true', 'Signed Mailgun ingress');
  exact(
    'MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED',
    'true',
    'Mailgun signature verification',
  );

  const forbidden = [
    ['STRIPE_SECRET_KEY', 'Stripe credential'],
    ['POSTMARK_SERVER_TOKEN', 'Postmark credential'],
    ['BREVO_API_KEY', 'Brevo credential'],
    ['ANTHROPIC_API_KEY', 'Live build credential'],
    ['MAILGUN_API_KEY', 'Outbound Mailgun credential'],
    ['DATABASE_URL', 'Generic database credential'],
    ['DATABASE_MIGRATOR_URL', 'Migration-owner database credential'],
    ['DATABASE_IMPORT_COMMAND_URL', 'Import database credential'],
    ['DATABASE_MAILGUN_WORKER_URL', 'Outbound worker database credential'],
  ] as const;
  for (const [name, label] of forbidden) {
    if (env[name]?.trim()) blockers.push(`${label} is forbidden in the public web process`);
  }
  return Object.freeze(blockers);
}
