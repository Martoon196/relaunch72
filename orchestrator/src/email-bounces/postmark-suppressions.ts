/**
 * Postmark's side of "This address works now": POST /message-streams/{stream}/suppressions/delete with the SERVER
 * token of the stream's own server (https://postmarkapp.com/developer/api/suppressions-api). Deleting a HardBounce
 * suppression reactivates the bounce. Postmark never deletes a SpamComplaint suppression (it answers Failed for it),
 * and an address that was not suppressed answers Deleted. At most 50 addresses a call. The answer is read for the
 * status per address only; Postmark's message text is never kept or shown.
 */
const MAX_RESPONSE_BYTES = 256 * 1024;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export class PostmarkSuppressionError extends Error {
  constructor(readonly status: number | null) { super('Postmark suppressions could not be changed'); }
}

/** Per address (lower-cased): 'deleted' (Postmark will send to it again) or 'failed' (Postmark kept it, e.g. a spam complaint). */
export async function deletePostmarkSuppressions(input: { token: string; stream: string; emails: readonly string[]; fetcher?: typeof fetch }): Promise<ReadonlyMap<string, 'deleted' | 'failed'>> {
  const emails = [...new Set(input.emails.map(email => email.trim().toLowerCase()))];
  if (!/^[a-z0-9-]{1,60}$/u.test(input.stream) || emails.length < 1 || emails.length > 50) throw new PostmarkSuppressionError(null);
  let response: Response;
  try {
    response = await (input.fetcher ?? fetch)(`https://api.postmarkapp.com/message-streams/${encodeURIComponent(input.stream)}/suppressions/delete`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json', 'content-type': 'application/json', 'X-Postmark-Server-Token': input.token },
      body: JSON.stringify({ Suppressions: emails.map(email => ({ EmailAddress: email })) }),
    });
  } catch { throw new PostmarkSuppressionError(null); }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new PostmarkSuppressionError(response.status); }
  let body: unknown;
  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('too large');
    body = JSON.parse(text);
  } catch { throw new PostmarkSuppressionError(null); }
  if (!record(body) || !Array.isArray(body.Suppressions)) throw new PostmarkSuppressionError(null);
  const out = new Map<string, 'deleted' | 'failed'>();
  for (const row of body.Suppressions) {
    if (!record(row) || typeof row.EmailAddress !== 'string') continue;
    const email = row.EmailAddress.trim().toLowerCase();
    if (emails.includes(email)) out.set(email, row.Status === 'Deleted' ? 'deleted' : 'failed');
  }
  // An address Postmark did not mention is not known to be reactivated.
  for (const email of emails) if (!out.has(email)) out.set(email, 'failed');
  return out;
}
