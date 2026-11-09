/**
 * Prove the Property Predator conversion-event receiver is ready to accept the
 * source worker's signed deliveries, without exposing any secret material.
 *
 * This is the receiving half of the bridge. It answers whether the exact route
 * is composed, whether the dedicated source key configuration is complete and
 * genuinely dedicated, and whether the shadow store schema behind it is
 * installed. It reports every answer as a safe operator-facing fact.
 *
 * Three things it deliberately never does. It performs no network call, so it
 * cannot and does not claim the Property Predator sender is reachable or that
 * any event has been delivered. It never prints a key's secret, only its
 * decoded byte length. And it never turns the bridge on: an enabled bridge is
 * reported, never arranged.
 */

import {
  loadPropertyPredatorExternalEventConfig,
  type PropertyPredatorExternalEventEnvConfig,
} from '../integrations/external-events/config.js';
import {
  PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH,
} from '../integrations/external-events/router.js';
import {
  PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES,
} from '../integrations/external-events/contracts.js';
import {
  PROPERTY_PREDATOR_SIGNATURE_TOLERANCE_SECONDS,
} from '../integrations/external-events/signature.js';

/** Receipts the source worker accepts, restated here so drift is visible. */
export const PROPERTY_PREDATOR_RECEIVER_RECEIPTS = Object.freeze({
  fresh: Object.freeze({ status: 202, replayed: false }),
  replay: Object.freeze({ status: 200, replayed: true }),
});

export type PropertyPredatorReceiverCheckStatus = 'ok' | 'blocked' | 'unverifiable';

export interface PropertyPredatorReceiverCheck {
  readonly name: string;
  readonly status: PropertyPredatorReceiverCheckStatus;
  readonly detail: string;
  /** Safe, low-cardinality facts only. Never a configured value. */
  readonly facts?: Readonly<Record<string, string | number | boolean>>;
}

export interface PropertyPredatorReceiverPreflightReport {
  readonly command: 'property-predator-source-receiver-preflight';
  readonly networkCallsMade: 0;
  readonly result: 'ready-for-activation-review' | 'blocked';
  readonly blockers: readonly string[];
  /** Always false: a preflight cannot prove a sender ever delivered. */
  readonly senderProven: false;
  readonly checks: readonly PropertyPredatorReceiverCheck[];
}

export interface PropertyPredatorReceiverSchemaProbe {
  /** Resolves when the shadow store schema is installed and correctly owned. */
  assertReady(): Promise<void>;
}

function check(
  name: string,
  status: PropertyPredatorReceiverCheckStatus,
  detail: string,
  facts?: Readonly<Record<string, string | number | boolean>>,
): PropertyPredatorReceiverCheck {
  return Object.freeze(facts ? { name, status, detail, facts } : { name, status, detail });
}

/** The route half: composed in code, independent of any configured value. */
export function checkReceiverRoute(): PropertyPredatorReceiverCheck[] {
  return [
    check(
      'receiver_route',
      'ok',
      'The exact signed ingress path is composed.',
      {
        path: PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH,
        method: 'POST',
        maxBodyBytes: PROPERTY_PREDATOR_EXTERNAL_EVENT_MAX_BODY_BYTES,
      },
    ),
    check(
      'receipt_contract',
      'ok',
      'A fresh event receipts 202 replayed:false; an exact replay receipts 200 replayed:true.',
      {
        freshStatus: PROPERTY_PREDATOR_RECEIVER_RECEIPTS.fresh.status,
        replayStatus: PROPERTY_PREDATOR_RECEIVER_RECEIPTS.replay.status,
        signatureToleranceSeconds: PROPERTY_PREDATOR_SIGNATURE_TOLERANCE_SECONDS,
      },
    ),
  ];
}

/**
 * The key half: complete, dedicated and never printed.
 *
 * `config` reports the real switch. `keyConfig` is the same environment loaded
 * with the switch forced on, because the loader short-circuits before it
 * validates any key while the bridge is dark. Without that a pre-activation
 * run could only ever say "disabled", which is exactly the question a
 * preflight is not being asked.
 */
export function checkSourceKeyConfiguration(
  config: PropertyPredatorExternalEventEnvConfig,
  keyConfig: PropertyPredatorExternalEventEnvConfig = config,
): PropertyPredatorReceiverCheck[] {
  const checks: PropertyPredatorReceiverCheck[] = [];
  if (!config.enabled) {
    // Not a blocker. A dark production deploy is the intended resting state.
    checks.push(check(
      'bridge_switch',
      'unverifiable',
      'The bridge is OFF. The route stays closed until it is explicitly enabled.',
    ));
  } else {
    checks.push(check('bridge_switch', 'ok', 'The bridge is explicitly enabled.'));
  }
  if (keyConfig.binding) {
    checks.push(check(
      'source_key_binding',
      'ok',
      'A dedicated source key is bound to exactly one workspace.',
      {
        keyId: keyConfig.binding.keyId,
        // Length only. The secret itself never enters this report.
        secretBytes: keyConfig.binding.sharedSecret.byteLength,
        workspaceBound: true,
      },
    ));
  } else {
    // The loader's blockers are already written to be safe for health output:
    // they name the variable, never its value.
    for (const blocker of keyConfig.blockers) {
      checks.push(check('source_key_binding', 'blocked', blocker));
    }
    if (keyConfig.blockers.length === 0) {
      checks.push(check(
        'source_key_binding',
        'blocked',
        'No dedicated Property Predator source key is configured.',
      ));
    }
  }
  checks.push(check(
    'transport',
    'ok',
    config.production
      ? 'Production requires HTTPS; only exact trusted proxy peers may assert X-Forwarded-Proto.'
      : 'Non-production composition; HTTPS is not enforced by the route.',
    {
      production: config.production,
      trustedProxyCount: keyConfig.trustedProxyAddresses.length,
    },
  ));
  return checks;
}

/** The store half: schema installed, or honestly reported as unproven. */
export async function checkReceiverSchema(
  probe: PropertyPredatorReceiverSchemaProbe | undefined,
): Promise<PropertyPredatorReceiverCheck> {
  if (!probe) {
    return check(
      'shadow_store_schema',
      'unverifiable',
      'No database was supplied, so the shadow store schema is unproven here. '
      + 'Run this against the target database before enabling the bridge.',
    );
  }
  try {
    await probe.assertReady();
  } catch (error) {
    // The message is the readiness assertion's own operator-facing text. It
    // names relations and owners, never credentials or event payloads.
    return check(
      'shadow_store_schema',
      'blocked',
      `Shadow store is not ready: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
  return check('shadow_store_schema', 'ok', 'Shadow store schema is installed and owned correctly.');
}

export async function runPropertyPredatorReceiverPreflight(
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly schemaProbe?: PropertyPredatorReceiverSchemaProbe } = {},
): Promise<PropertyPredatorReceiverPreflightReport> {
  const config = loadPropertyPredatorExternalEventConfig(env);
  // A copy, never the live environment, so proving the key shape here can
  // never be mistaken for enabling the bridge.
  const keyConfig = loadPropertyPredatorExternalEventConfig({
    ...env,
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED: 'true',
  });
  const checks: PropertyPredatorReceiverCheck[] = [
    ...checkReceiverRoute(),
    ...checkSourceKeyConfiguration(config, keyConfig),
    await checkReceiverSchema(options.schemaProbe),
    check(
      'source_worker_delivery',
      'unverifiable',
      'This command makes no network call, so it cannot prove the Property '
      + 'Predator worker reached this receiver. Only an accepted signed '
      + 'delivery proves that, and obtaining one is an authorised activation.',
    ),
  ];
  const blockers = checks
    .filter((entry) => entry.status === 'blocked')
    .map((entry) => entry.detail);
  return Object.freeze({
    command: 'property-predator-source-receiver-preflight' as const,
    networkCallsMade: 0 as const,
    result: blockers.length === 0 ? 'ready-for-activation-review' : 'blocked',
    blockers: Object.freeze(blockers),
    senderProven: false as const,
    checks: Object.freeze(checks),
  });
}

export function formatPropertyPredatorReceiverPreflight(
  report: PropertyPredatorReceiverPreflightReport,
): string {
  const lines = report.checks.map((entry) => {
    const facts = entry.facts
      ? ` (${Object.entries(entry.facts).map(([key, value]) => `${key}=${value}`).join(', ')})`
      : '';
    return `[${entry.status.padStart(12)}] ${entry.name}: ${entry.detail}${facts}`;
  });
  lines.push('');
  lines.push(
    report.result === 'ready-for-activation-review'
      ? 'ready for activation review'
      : `BLOCKED: ${report.blockers.length} blocker(s)`,
  );
  lines.push('Property Predator worker delivery is NOT proven by this command.');
  return lines.join('\n');
}
