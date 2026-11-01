/**
 * Website publisher adapter contract. Adapter identity is a connection TYPE,
 * never a brand: any brand whose website matches a type can connect it from
 * its own workspace with configuration alone.
 */

import type { ArticleBody, Destination, DestinationType } from '../types.js';
import { SeoBlogError } from '../types.js';
import type { FetchTransport } from '../safe-fetch.js';

export interface DestinationConfigField {
  readonly key: string;
  readonly label: string;
  readonly help: string;
  readonly required: boolean;
  readonly placeholder?: string;
}

export interface ValidatedDestination {
  readonly config: Readonly<Record<string, string>>;
  readonly publicBaseUrl: string;
}

export interface PublishInput {
  readonly operationId: string;
  readonly destination: Destination;
  readonly credential: string;
  readonly brandName: string;
  readonly locale: string;
  readonly articleId: string;
  readonly versionId: string;
  readonly contentSha: string;
  readonly body: ArticleBody;
  readonly publishedAt: string;
}

export interface PublishOutcome {
  readonly status: 'accepted' | 'already_present';
  readonly providerRef: string;
  readonly publicUrl: string;
}

export type ExistingState = 'present' | 'absent' | 'other_version';

/** The provider may or may not have applied the change. Never retry blindly: reconcile. */
export class PublisherOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublisherOutcomeUnknownError';
  }
}

/** The provider definitely refused; the change was not applied. */
export class PublisherRejectedError extends SeoBlogError {
  constructor(message: string, readonly retryable = false) {
    super(409, message, 'publisher_rejected');
  }
}

export interface WebsitePublisher {
  readonly type: DestinationType;
  readonly label: string;
  readonly description: string;
  readonly fields: readonly DestinationConfigField[];
  readonly credentialLabel: string;
  validateConfig(raw: Readonly<Record<string, string>>): ValidatedDestination;
  publicUrlFor(destination: Destination, slug: string): string;
  indexUrlFor(destination: Destination): string;
  checkConnection(destination: Destination, credential: string): Promise<{ ok: boolean; detail: string }>;
  /** Idempotent. Throws PublisherOutcomeUnknownError when the outcome cannot be known. */
  publish(input: PublishInput): Promise<PublishOutcome>;
  /** Read the provider's current state for this exact article/version (reconciliation). */
  findExisting(input: PublishInput): Promise<{ state: ExistingState; providerRef: string | null }>;
}

/** Read the public page and confirm it serves this exact article version. */
export async function verifyPublicUrl(transport: FetchTransport, url: string, marker: string): Promise<'served' | 'not_yet' | 'different'> {
  try {
    const page = await transport.fetch(url, { maxBytes: 3 * 1024 * 1024 });
    if (page.status !== 200) return 'not_yet';
    const html = page.body.toString('utf8');
    if (html.includes(marker)) return 'served';
    return /r72-blog:/.test(html) ? 'different' : 'not_yet';
  } catch {
    return 'not_yet';
  }
}

export function requireHttpsBase(raw: string | undefined, field: string): string {
  let url: URL;
  try { url = new URL(String(raw ?? '').trim()); } catch { throw new SeoBlogError(400, `${field} must be a full https:// address.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new SeoBlogError(400, `${field} must be a plain https:// address.`);
  return url.toString().replace(/\/+$/, '');
}

export function cleanPath(raw: string | undefined, fallback: string, field: string): string {
  const value = String(raw ?? '').trim().replace(/^\/+|\/+$/g, '') || fallback;
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value) || value.split('/').some((s) => s === '..' || s === '.')) {
    throw new SeoBlogError(400, `${field} must be a simple relative path.`);
  }
  return value;
}
