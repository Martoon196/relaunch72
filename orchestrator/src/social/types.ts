/**
 * AI Socials Manager — the swappable publishing layer.
 *
 * `SocialPublisher` is the seam between our content (S8) and whatever actually
 * puts posts on a customer's accounts. It mirrors the LLM client's mock/live
 * split: a MockPublisher (deterministic, zero external calls — for tests and
 * dry-runs) and an Ayrshare adapter (live). The interface is deliberately thin
 * so a later self-hosted backend (Postiz/Mixpost) is a new adapter, not a
 * rewrite. See docs/socials-manager-spike.md + decisions D-054.
 */

/** One post to publish, composed from an S8 post and stamped with a send time. */
export interface PlannedPost {
  day: number;
  platform: string; // S8 platform name, e.g. "Facebook", "X", "YouTube Shorts"
  format: string;
  pillar: string;
  /** hook + body + cta, composed into the post body the network receives. */
  text: string;
  /** ISO-8601 send time. */
  scheduleDate: string;
}

export interface AccountRef {
  platform: string;
  connected: boolean;
  handle?: string;
}

export interface PublishResult {
  /** Provider-side id (or a deterministic mock id). */
  id: string;
  platform: string;
  day: number;
  status: 'scheduled' | 'published' | 'failed';
  error?: string;
  /** Provider cost attributed to this post, if known (real COGS signal). */
  costUsd?: number;
}

export interface PostStatus {
  id: string;
  status: string;
}

export interface SocialPublisher {
  readonly mode: 'mock' | 'live';
  /** Confirm (or begin) the customer's account link for a platform. */
  connectAccount(platform: string): Promise<AccountRef>;
  /** Queue a post for its scheduleDate. */
  schedule(post: PlannedPost): Promise<PublishResult>;
  /** Publish a post immediately. */
  publish(post: PlannedPost): Promise<PublishResult>;
  /** Look up the current status of a queued/published post. */
  status(id: string): Promise<PostStatus>;
}
