import {
  loadPropertyPredatorProviderIngressConfig,
  type PropertyPredatorProviderIngressRail,
} from './config.js';
import {
  createPropertyPredatorProviderIngressMount,
  darkPropertyPredatorProviderIngressMount,
  type PropertyPredatorProviderIngressEndpoint,
  type PropertyPredatorProviderIngressMount,
} from './router.js';

export interface PropertyPredatorProviderIngressCompositionDependencies {
  /** Endpoints are composed only after credentials and durable stores pass readiness. */
  readonly endpoints?: Readonly<Partial<Record<
    PropertyPredatorProviderIngressRail,
    PropertyPredatorProviderIngressEndpoint
  >>>;
}

/**
 * Runtime gate only. Credentials remain in the deployment secret manager and
 * durable stores remain injected; this function never loads or prints either.
 */
export function composePropertyPredatorProviderIngress(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: PropertyPredatorProviderIngressCompositionDependencies = {},
): PropertyPredatorProviderIngressMount {
  const config = loadPropertyPredatorProviderIngressConfig(env);
  if (!config.enabled) return darkPropertyPredatorProviderIngressMount(false, []);
  if (!config.configurationReady) {
    return darkPropertyPredatorProviderIngressMount(true, config.blockers);
  }
  const endpoints: PropertyPredatorProviderIngressEndpoint[] = [];
  const blockers: string[] = [];
  for (const rail of config.enabledRails) {
    const endpoint = dependencies.endpoints?.[rail];
    if (!endpoint) blockers.push(`${rail} protected endpoint did not pass readiness`);
    else endpoints.push(endpoint);
  }
  if (blockers.length > 0) return darkPropertyPredatorProviderIngressMount(true, blockers);
  return createPropertyPredatorProviderIngressMount(endpoints);
}
