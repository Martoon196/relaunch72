/**
 * Ayrshare adapter — the live publisher (see docs/socials-manager-spike.md).
 *
 * Ayrshare is a social-media API built for products: one integration posts +
 * schedules across 13+ networks, multi-tenant via per-customer "profile keys"
 * (Business plan), priced per active profile not per seat. This adapter is a
 * thin, honest wrapper over its REST API. It is NOT exercised in tests or mock
 * runs — it activates only when AYRSHARE_API_KEY is set, which is the founder-
 * gated live proof step. Endpoints/fields are per Ayrshare docs as of Jan 2026;
 * verify against current docs before the live run.
 */

import type { AccountRef, PlannedPost, PostStatus, PublishResult, SocialPublisher } from './types.js';

const API_BASE = 'https://api.ayrshare.com/api';

// S8 platform names → Ayrshare platform ids. Verify against current Ayrshare docs.
const PLATFORM_MAP: Record<string, string> = {
  'facebook': 'facebook',
  'instagram': 'instagram',
  'linkedin': 'linkedin',
  'tiktok': 'tiktok',
  'x': 'twitter',
  'youtube shorts': 'youtube',
  'google business profile': 'gmb',
};

function ayrsharePlatform(s8Platform: string): string {
  const key = s8Platform.trim().toLowerCase();
  const mapped = PLATFORM_MAP[key];
  if (!mapped) throw new Error(`No Ayrshare platform mapping for "${s8Platform}"`);
  return mapped;
}

export class AyrsharedPublisher implements SocialPublisher {
  readonly mode = 'live' as const;

  constructor(
    private readonly apiKey = process.env.AYRSHARE_API_KEY ?? '',
    /** Business-plan multi-user: the customer's profile key. Omit for a single-brand key. */
    private readonly profileKey = process.env.AYRSHARE_PROFILE_KEY ?? '',
  ) {
    if (!this.apiKey) {
      throw new Error(
        'No Ayrshare credentials: set AYRSHARE_API_KEY (and AYRSHARE_PROFILE_KEY for a specific customer profile) in <repo root>/.env — or run --mock for a no-cost dry run.',
      );
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.profileKey) h['Profile-Key'] = this.profileKey; // Business-plan multi-user routing
    return h;
  }

  private async postToApi(post: PlannedPost, opts: { schedule: boolean }): Promise<PublishResult> {
    const body: Record<string, unknown> = {
      post: post.text,
      platforms: [ayrsharePlatform(post.platform)],
    };
    if (opts.schedule) body.scheduleDate = post.scheduleDate; // ISO; Ayrshare queues it

    let res: Response;
    try {
      res = await fetch(`${API_BASE}/post`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    } catch (err) {
      return { id: '', platform: post.platform, day: post.day, status: 'failed', error: `network: ${(err as Error).message}` };
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string; status?: string; errors?: unknown };
    if (!res.ok || json.status === 'error') {
      return { id: json.id ?? '', platform: post.platform, day: post.day, status: 'failed', error: `HTTP ${res.status}: ${JSON.stringify(json.errors ?? json)}` };
    }
    return {
      id: json.id ?? '',
      platform: post.platform,
      day: post.day,
      status: opts.schedule ? 'scheduled' : 'published',
    };
  }

  async connectAccount(platform: string): Promise<AccountRef> {
    // Account linking is done by the customer through Ayrshare's hosted linking
    // page (SSO/JWT), not a server call — so here we only confirm the platform is
    // already linked on this profile via /user. Full linking-URL generation is a
    // later step (needs the JWT endpoint + our own platform apps for white-label).
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/user`, { headers: this.headers() });
    } catch (err) {
      return { platform, connected: false, handle: `error: ${(err as Error).message}` };
    }
    const json = (await res.json().catch(() => ({}))) as { activeSocialAccounts?: string[] };
    const active = (json.activeSocialAccounts ?? []).map((s) => s.toLowerCase());
    return { platform, connected: active.includes(ayrsharePlatform(platform)) };
  }

  async schedule(post: PlannedPost): Promise<PublishResult> {
    return this.postToApi(post, { schedule: true });
  }

  async publish(post: PlannedPost): Promise<PublishResult> {
    return this.postToApi(post, { schedule: false });
  }

  async status(id: string): Promise<PostStatus> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/history/${encodeURIComponent(id)}`, { headers: this.headers() });
    } catch (err) {
      return { id, status: `error: ${(err as Error).message}` };
    }
    const json = (await res.json().catch(() => ({}))) as { status?: string };
    return { id, status: json.status ?? `http_${res.status}` };
  }
}
