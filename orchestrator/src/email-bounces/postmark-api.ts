/**
 * Read-only Postmark calls used by the catch-up sweep: a stream's suppression
 * list, its recent bounces, and its own sent/bounced totals. The HTTP client is
 * injected so tests never touch the network. Response bodies can contain
 * recipients, so no error ever carries one.
 */

import { parsePostmarkJson, readPostmarkBounceRow, readPostmarkSuppressionRow, type PostmarkBounceRow, type PostmarkSuppressionRow } from './postmark-events.js';

export class PostmarkReadError extends Error {
  constructor(readonly status: number | null) { super('Postmark could not be read'); }
}

export interface PostmarkBouncePage { readonly total: number; readonly rows: readonly PostmarkBounceRow[]; readonly received: number }
export interface PostmarkStreamTotals { readonly sent: number | null; readonly bounced: number | null; readonly complaints: number | null }
export interface PostmarkBounceApi {
  suppressions(stream: string): Promise<readonly PostmarkSuppressionRow[]>;
  bounces(stream: string, fromDate: string, toDate: string, offset: number, count: number): Promise<PostmarkBouncePage>;
  totals(stream: string, fromDate: string, toDate: string): Promise<PostmarkStreamTotals>;
}

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function createPostmarkBounceApi(token: string, fetcher: typeof fetch = fetch): PostmarkBounceApi {
  const get = async (path: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetcher(`https://api.postmarkapp.com${path}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000),
        headers: { accept: 'application/json', 'X-Postmark-Server-Token': token } });
    } catch { throw new PostmarkReadError(null); }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new PostmarkReadError(response.status); }
    let text: string;
    try { text = await response.text(); } catch { throw new PostmarkReadError(null); }
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new PostmarkReadError(null);
    try { return parsePostmarkJson(text); } catch { throw new PostmarkReadError(null); }
  };
  return Object.freeze({
    async suppressions(stream: string) {
      const body = await get(`/message-streams/${encodeURIComponent(stream)}/suppressions/dump`);
      if (!record(body) || !Array.isArray(body.Suppressions)) throw new PostmarkReadError(null);
      return body.Suppressions.map(readPostmarkSuppressionRow).filter((row): row is PostmarkSuppressionRow => row !== null);
    },
    async bounces(stream: string, fromDate: string, toDate: string, offset: number, pageSize: number) {
      // Postmark refuses count > 500 and count + offset > 10,000; never send a query it would reject.
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(pageSize) || offset < 0 || pageSize < 1 || pageSize > 500 || offset + pageSize > 10_000) throw new PostmarkReadError(null);
      const query = new URLSearchParams({ count: String(pageSize), offset: String(offset), fromdate: fromDate, todate: toDate, messagestream: stream });
      const body = await get(`/bounces?${query.toString()}`);
      if (!record(body) || !Array.isArray(body.Bounces)) throw new PostmarkReadError(null);
      const total = count(body.TotalCount) ?? body.Bounces.length;
      return { total, received: body.Bounces.length, rows: body.Bounces.map(readPostmarkBounceRow).filter((row): row is PostmarkBounceRow => row !== null) };
    },
    async totals(stream: string, fromDate: string, toDate: string) {
      const query = new URLSearchParams({ fromdate: fromDate, todate: toDate, messagestream: stream });
      const body = await get(`/stats/outbound?${query.toString()}`);
      if (!record(body)) throw new PostmarkReadError(null);
      return { sent: count(body.Sent), bounced: count(body.Bounced), complaints: count(body.SpamComplaints) };
    },
  });
}
