/** Read-only Meta-owned WABA/phone relationship check; never a send adapter. */
export interface WhatsAppOwnershipTarget { readonly wabaId: string; readonly phoneNumberId: string; readonly normalizedNumber: string }
export interface WhatsAppOwnershipObservation { readonly wabaId: string; readonly phoneNumberId: string; readonly normalizedNumber: string; readonly observedAt: string }
export class WhatsAppOwnershipError extends Error {
  constructor(readonly code: 'access_denied' | 'ownership_mismatch' | 'provider_unavailable' | 'response_invalid' | 'timeout') {
    super(`WhatsApp ownership check: ${code}`); this.name = 'WhatsAppOwnershipError';
  }
}
const fail = (code: WhatsAppOwnershipError['code']): never => { throw new WhatsAppOwnershipError(code); };
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const META_ID = /^[1-9][0-9]{4,29}$/u;
async function bounded(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 65_536)) return fail('response_invalid');
  if (!response.body) return fail('response_invalid');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength;
      if (total > 65_536) { await reader.cancel().catch(() => {}); return fail('response_invalid'); } chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) { if (error instanceof WhatsAppOwnershipError) throw error; return fail('response_invalid'); }
  finally { reader.releaseLock(); }
}
export function createWhatsAppOwnershipClient(input: { target: WhatsAppOwnershipTarget; fetch?: typeof fetch; now?: () => number; timeoutMs?: number }) {
  const target = Object.freeze({ wabaId: input.target.wabaId, phoneNumberId: input.target.phoneNumberId, normalizedNumber: input.target.normalizedNumber }), transport = input.fetch ?? fetch, timeoutMs = input.timeoutMs ?? 10_000;
  if (!META_ID.test(target.wabaId) || !META_ID.test(target.phoneNumberId) || !/^[1-9][0-9]{6,14}$/u.test(target.normalizedNumber)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error('WhatsApp ownership configuration is invalid');
  return { async verify(accessToken: string): Promise<WhatsAppOwnershipObservation> {
    if (!/^[\x21-\x7e]{20,2000}$/u.test(accessToken)) return fail('access_denied');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs); let after: string | null = null;
    try {
      for (let page = 0; page < 3; page++) {
        const url = new URL(`https://graph.facebook.com/v24.0/${target.wabaId}/phone_numbers`);
        url.searchParams.set('fields', 'id,display_phone_number'); url.searchParams.set('limit', '100'); if (after) url.searchParams.set('after', after);
        const response = await transport(url, { method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, redirect: 'error', signal: controller.signal });
        if ([400, 401, 403].includes(response.status)) return fail('access_denied');
        if (response.status !== 200) return fail('provider_unavailable');
        const body = await bounded(response);
        if (!object(body) || !Array.isArray(body.data) || body.data.length > 100) return fail('response_invalid');
        const rows = body.data;
        if (rows.some(row => !object(row) || typeof row.id !== 'string' || !META_ID.test(row.id))) return fail('response_invalid');
        const matches = rows.filter(row => object(row) && row.id === target.phoneNumberId);
        if (matches.length > 1) return fail('response_invalid');
        if (matches.length === 1) {
          const display = (matches[0] as Record<string, unknown>).display_phone_number;
          if (typeof display !== 'string' || !/^[+0-9 ()-]{7,40}$/u.test(display) || display.replace(/[^0-9]/gu, '') !== target.normalizedNumber) return fail('ownership_mismatch');
          return Object.freeze({ ...target, observedAt: new Date(input.now?.() ?? Date.now()).toISOString() });
        }
        const paging = body.paging;
        if (!object(paging) || !paging.next) return fail('ownership_mismatch');
        const cursors = paging.cursors, cursor = object(cursors) ? cursors.after : null;
        if (typeof cursor !== 'string' || !/^[\x21-\x7e]{1,2048}$/u.test(cursor) || cursor === after) return fail('response_invalid');
        after = cursor; // Never follow Meta's next URL or forward a token from it.
      }
      return fail('ownership_mismatch');
    } catch (error) {
      if (controller.signal.aborted) return fail('timeout');
      if (error instanceof WhatsAppOwnershipError) throw error;
      return fail('provider_unavailable');
    } finally { clearTimeout(timer); }
  } };
}
