export const PROPERTY_PREDATOR_PROVIDER_INGRESS_RAILS = [
  'meta_whatsapp',
  'meta_facebook',
  'meta_instagram',
  'whereby',
] as const;

export type PropertyPredatorProviderIngressRail =
  (typeof PROPERTY_PREDATOR_PROVIDER_INGRESS_RAILS)[number];

export interface PropertyPredatorProviderIngressConfig {
  readonly enabled: boolean;
  readonly configurationReady: boolean;
  readonly enabledRails: readonly PropertyPredatorProviderIngressRail[];
  readonly blockers: readonly string[];
}

const ENV_BY_RAIL: Readonly<Record<PropertyPredatorProviderIngressRail, string>> = Object.freeze({
  meta_whatsapp: 'PROPERTY_PREDATOR_META_WHATSAPP_INGRESS_ENABLED',
  meta_facebook: 'PROPERTY_PREDATOR_META_FACEBOOK_INGRESS_ENABLED',
  meta_instagram: 'PROPERTY_PREDATOR_META_INSTAGRAM_INGRESS_ENABLED',
  whereby: 'PROPERTY_PREDATOR_WHEREBY_INGRESS_ENABLED',
});

/**
 * Missing/false is dark. Any other non-empty value is an attempted activation
 * and therefore fails visibly rather than silently disabling the callback.
 */
export function loadPropertyPredatorProviderIngressConfig(
  env: NodeJS.ProcessEnv,
): PropertyPredatorProviderIngressConfig {
  const enabledRails: PropertyPredatorProviderIngressRail[] = [];
  const blockers: string[] = [];
  let attempted = false;
  for (const rail of PROPERTY_PREDATOR_PROVIDER_INGRESS_RAILS) {
    const name = ENV_BY_RAIL[rail];
    const value = env[name]?.trim() ?? '';
    if (value !== '' && value !== 'false') attempted = true;
    if (value === 'true') enabledRails.push(rail);
    else if (value !== '' && value !== 'false') blockers.push(`${rail} ingress enablement must be exact true`);
  }
  if (!attempted && enabledRails.length === 0) {
    return Object.freeze({
      enabled: false,
      configurationReady: true,
      enabledRails: Object.freeze([]),
      blockers: Object.freeze([]),
    });
  }
  if (env.PROPERTY_PREDATOR_PROVIDER_INBOUND_CAPABILITY?.trim() !== 'meta_whereby_v1') {
    blockers.push('provider inbound capability grant is missing');
  }
  if (env.PROPERTY_PREDATOR_PROVIDER_EFFECTS?.trim() !== 'false') {
    blockers.push('provider effects must be exact false');
  }
  if (env.PROPERTY_PREDATOR_PROVIDER_EMERGENCY_PAUSED?.trim() !== 'true') {
    blockers.push('provider emergency pause must be engaged');
  }
  if (enabledRails.length === 0) blockers.push('no provider inbound rail is exactly enabled');
  return Object.freeze({
    enabled: true,
    configurationReady: blockers.length === 0,
    enabledRails: Object.freeze([...enabledRails]),
    blockers: Object.freeze(blockers),
  });
}
