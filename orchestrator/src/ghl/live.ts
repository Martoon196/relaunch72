/**
 * GoHighLevel API v2 client — live adapter (see decisions D-056/D-057).
 *
 * Activates only when GHL_API_TOKEN (an OAuth 2.0 access token) + GHL_AGENCY_ID
 * (company id) are set — the founder-gated step that also requires a SaaS-Pro
 * agency plan. NOT exercised in tests/mock runs. GHL v2 uses the
 * services.leadconnectorhq.com host and a required `Version` header. Endpoints/
 * fields per GHL API v2 docs as of Jan 2026; verify before the live run. Content
 * artifacts map to a GHL blog post when GHL_BLOG_ID is configured; without it,
 * content pushes return a clear failed result rather than guessing an endpoint.
 */

import type { GhlArtifact, GhlClient, GhlLocationRef, GhlPushResult } from './types.js';

const API_BASE = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

export class GhlLiveClient implements GhlClient {
  readonly mode = 'live' as const;

  constructor(
    private readonly token = process.env.GHL_API_TOKEN ?? '',
    private readonly agencyId = process.env.GHL_AGENCY_ID ?? '',
    private readonly blogId = process.env.GHL_BLOG_ID ?? '',
  ) {
    if (!this.token || !this.agencyId) {
      throw new Error(
        'No GHL credentials: set GHL_API_TOKEN and GHL_AGENCY_ID in <repo root>/.env (SaaS-Pro agency plan + a Developer Marketplace app) — or run --mock for a no-cost dry run.',
      );
    }
  }

  private headers(): Record<string, string> {
    return { 'Authorization': `Bearer ${this.token}`, 'Version': API_VERSION, 'Content-Type': 'application/json' };
  }

  async ensureLocation(tenant: { id: string; name: string }): Promise<GhlLocationRef> {
    // Find-or-create: search the agency's locations by name, else create one.
    try {
      const search = await fetch(`${API_BASE}/locations/search?companyId=${encodeURIComponent(this.agencyId)}&limit=100`, { headers: this.headers() });
      if (search.ok) {
        const json = (await search.json().catch(() => ({}))) as { locations?: Array<{ id: string; name?: string }> };
        const hit = (json.locations ?? []).find((l) => (l.name ?? '') === tenant.name);
        if (hit) return { tenantId: tenant.id, locationId: hit.id, created: false };
      }
    } catch {
      /* fall through to create */
    }
    const res = await fetch(`${API_BASE}/locations/`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name: tenant.name, companyId: this.agencyId }),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    if (!res.ok || !json.id) throw new Error(`GHL create location failed: HTTP ${res.status}`);
    return { tenantId: tenant.id, locationId: json.id, created: true };
  }

  async pushArtifact(locationId: string, artifact: GhlArtifact): Promise<GhlPushResult> {
    // Content-like artifacts → a GHL blog post (needs a configured blog).
    if (artifact.type === 'content_cluster' || artifact.type === 'pack' || artifact.type === 'note') {
      if (!this.blogId) {
        return { locationId, artifactId: '', type: artifact.type, } as GhlPushResult; // caller sees empty id = not pushed
      }
      const res = await fetch(`${API_BASE}/blogs/posts`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ locationId, blogId: this.blogId, title: artifact.title, rawHTML: JSON.stringify(artifact.payload ?? {}), status: 'DRAFT' }),
      });
      const json = (await res.json().catch(() => ({}))) as { data?: { id?: string } };
      if (!res.ok || !json.data?.id) throw new Error(`GHL blog post failed: HTTP ${res.status}`);
      return { locationId, artifactId: json.data.id, type: artifact.type };
    }
    // social_post / ad_campaign live pushes are handled by their own rails
    // (Ayrshare / Meta) — GHL just records the activity as a note here.
    const res = await fetch(`${API_BASE}/locations/${encodeURIComponent(locationId)}/notes`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ body: `[Relaunch72] ${artifact.title}` }),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    if (!res.ok) throw new Error(`GHL note failed: HTTP ${res.status}`);
    return { locationId, artifactId: json.id ?? '', type: artifact.type };
  }
}
