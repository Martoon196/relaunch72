/**
 * Deterministic in-memory publisher for mechanics testing (no network, no cost,
 * no keys) — mirrors llm/mock.ts. Records every call so tests and dry-runs can
 * assert what WOULD be posted without touching a real account.
 */

import type { AccountRef, PlannedPost, PostStatus, PublishResult, SocialPublisher } from './types.js';

export class MockPublisher implements SocialPublisher {
  readonly mode = 'mock' as const;
  readonly connected = new Set<string>();
  readonly scheduled: PublishResult[] = [];

  async connectAccount(platform: string): Promise<AccountRef> {
    this.connected.add(platform);
    return { platform, connected: true, handle: `mock:${platform}` };
  }

  private record(post: PlannedPost, status: 'scheduled' | 'published'): PublishResult {
    // Deterministic id (no Date/random) so resumes and snapshots are stable.
    const result: PublishResult = {
      id: `mock-${post.platform.toLowerCase().replace(/\s+/g, '-')}-d${post.day}`,
      platform: post.platform,
      day: post.day,
      status,
      costUsd: 0,
    };
    this.scheduled.push(result);
    return result;
  }

  async schedule(post: PlannedPost): Promise<PublishResult> {
    return this.record(post, 'scheduled');
  }

  async publish(post: PlannedPost): Promise<PublishResult> {
    return this.record(post, 'published');
  }

  async status(id: string): Promise<PostStatus> {
    const hit = this.scheduled.find((r) => r.id === id);
    return { id, status: hit?.status ?? 'unknown' };
  }
}
