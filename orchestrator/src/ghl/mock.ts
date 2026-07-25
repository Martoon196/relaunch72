/**
 * Deterministic in-memory GHL client — no network, no token. Records ensured
 * locations and pushed artifacts so tests and dry runs can assert what WOULD hit
 * a sub-account. Locations are created once per tenant (find-or-create).
 */

import type { GhlArtifact, GhlClient, GhlLocationRef, GhlPushResult } from './types.js';

export class MockGhlClient implements GhlClient {
  readonly mode = 'mock' as const;
  readonly locations = new Map<string, string>(); // tenantId → locationId
  readonly artifacts: GhlPushResult[] = [];

  async ensureLocation(tenant: { id: string; name: string }): Promise<GhlLocationRef> {
    const existing = this.locations.get(tenant.id);
    if (existing) return { tenantId: tenant.id, locationId: existing, created: false };
    const locationId = `ghl-loc-${tenant.id}`;
    this.locations.set(tenant.id, locationId);
    return { tenantId: tenant.id, locationId, created: true };
  }

  async pushArtifact(locationId: string, artifact: GhlArtifact): Promise<GhlPushResult> {
    // Deterministic id (no Date/random): type + running count of same-type pushes.
    const seq = this.artifacts.filter((a) => a.type === artifact.type).length;
    const result: GhlPushResult = { locationId, artifactId: `ghl-art-${artifact.type}-${seq}`, type: artifact.type };
    this.artifacts.push(result);
    return result;
  }
}
