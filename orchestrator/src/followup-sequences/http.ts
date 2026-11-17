import type { IncomingMessage, ServerResponse } from 'node:http';
import { FlowWorkspaceError } from './workspace.js';
export const FLOW_FORM_DRAFT = ['csrf', 'commandId', 'contentItemId', 'previousVersionId', 'definition'] as const;
export const FLOW_FORM_SAVED = ['csrf', 'commandId', 'itemId', 'versionId'] as const;
export const FLOW_NATIVE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
export function sendNativeFlow(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store',
    'referrer-policy': 'same-origin', 'content-security-policy': FLOW_NATIVE_CSP, 'x-content-type-options': 'nosniff' }); res.end(body);
}
/** `optional` names fields a form may omit (an unticked checkbox, a field older pages do not carry); every other field is exact. */
export async function readNativeFlowForm(req: IncomingMessage, required: readonly string[], editing: boolean, optional: readonly string[] = []): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/iu.test(String(req.headers['content-type'] ?? ''))) throw new FlowWorkspaceError(415, 'This form could not be read. Open the page again and try once more.');
  const maximum = editing ? 240_000 : 4096, declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maximum) throw new FlowWorkspaceError(413, 'This form is too large to save. Shorten it and try again.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of req) { const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); size += chunk.length;
    if (size > maximum) throw new FlowWorkspaceError(413, 'This form is too large to save. Shorten it and try again.'); chunks.push(chunk); }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  if (editing && !fields.has('inlineMessages') && Math.max(size, declared) > 140_000) throw new FlowWorkspaceError(413, 'This form is too large to save. Shorten it and try again.');
  const expected = [...required, ...[...(editing ? ['inlineMessages', 'simulationCase'] : []), ...optional].filter(key => fields.has(key) && !required.includes(key))];
  if (fields.size !== expected.length || [...fields.keys()].some(key => !expected.includes(key) || fields.getAll(key).length !== 1)) throw new FlowWorkspaceError(400, 'This page was out of date. Open it again and try once more.');
  return fields;
}
