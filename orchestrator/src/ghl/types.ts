/**
 * GoHighLevel adapter — the (optional) platform backbone. If we take the GHL
 * path (decisions D-056/D-057), this is the seam the manager pushes each client's
 * work through: ensure the client's GHL sub-account (location) exists, then push
 * artifacts (the pack, a Soro cluster, a social post, an ad campaign) into it via
 * GHL's API v2. Same swappable mock/live shape as every other rail — a
 * MockGhlClient runs at £0 and in tests; the live client activates on a SaaS-Pro
 * token. Building the seam now costs nothing and keeps the platform decision open.
 */

export type GhlArtifactType = 'pack' | 'content_cluster' | 'social_post' | 'ad_campaign' | 'note';

export interface GhlLocationRef {
  tenantId: string;
  locationId: string;
  /** True if this call created the sub-account (vs found an existing one). */
  created: boolean;
}

export interface GhlArtifact {
  type: GhlArtifactType;
  title: string;
  payload?: unknown;
}

export interface GhlPushResult {
  locationId: string;
  artifactId: string;
  type: GhlArtifactType;
}

export interface GhlClient {
  readonly mode: 'mock' | 'live';
  /** Find-or-create the client's GHL sub-account (location). */
  ensureLocation(tenant: { id: string; name: string }): Promise<GhlLocationRef>;
  /** Push one artifact into a location. */
  pushArtifact(locationId: string, artifact: GhlArtifact): Promise<GhlPushResult>;
}
