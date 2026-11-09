/**
 * Production control-plane policy for Property Predator Growth HQ.
 *
 * Social read/reply and calendar effects are activated in the public web
 * process. Every communication, payment, import and generation rail remains
 * independently gated and privileged worker credentials remain forbidden.
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
  // This shared prerequisite must agree with the production Blueprint. The
  // individual email, WhatsApp, SMS, payment, import and generation switches
  // below still fail closed; requiring `false` here made the activated social
  // Blueprint impossible to boot.
  exact('PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED', 'true', 'Provider effects');
  exact('PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED', 'false', 'Email delivery');
  exact('PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED', 'true', 'Email emergency pause');
  exact('PUBLIC_LEAD_CAPTURE_ENABLED', 'false', 'Public lead capture');
  exact('PLATFORM_SUBSCRIPTIONS_ENABLED', 'false', 'Platform subscriptions');
  exact('BILLING_ENFORCED', 'false', 'Billing enforcement');
  exact('PORTAL_DEMO_SEED', 'false', 'Portal demo seed');
  exact('RELAUNCH72_FORCE_MOCK_BUILDS', 'true', 'Build execution');
  // The signed Property Predator bridge is inbound-only. Its own loader,
  // dedicated database identities and HMAC boundary fail closed, so enabling
  // it is not a provider effect and must not trip the outbound safety policy.
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
