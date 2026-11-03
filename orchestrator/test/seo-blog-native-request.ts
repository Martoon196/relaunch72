/** Native route fixture only: no listening socket, provider, persistence bootstrap or test registration. */
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';
import type { SeoBlogEngine } from '../src/seo-blog/engine.js';
export const NATIVE_TEST_SECRET = 'synthetic-native-test-only-'.repeat(3);
export function nativeIdentity(userId: string): PortalSessionIdentity { return { userId, sessionToken: `synthetic-${userId}`, workspaceId: '33333333-3333-4333-8333-333333333333', userEmail: 'owner@example.test' }; }
export function nativeCsrf(identity: PortalSessionIdentity): string { return portalCsrfToken(NATIVE_TEST_SECRET, identity.sessionToken); }
export async function nativeSeoCall(engine: SeoBlogEngine, input: { who: PortalSessionIdentity | null; method: 'GET' | 'POST'; path: string; fields?: Record<string, string | string[]>; file?: {filename:string;bytes:Buffer}; applicationName?: string; headers?: Record<string, string> }) {
  const fields: [string,string][] = Object.entries(input.fields ?? {}).flatMap(([k, value]) => (Array.isArray(value) ? value : [value]).map(v => [k, v] as [string,string]));
  let body = Buffer.from(new URLSearchParams(fields).toString()), contentType = 'application/x-www-form-urlencoded';
  if (input.file) {
    const boundary = `synthetic-${randomUUID()}`; contentType = `multipart/form-data; boundary=${boundary}`;
    body = Buffer.concat([...fields.map(([key, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.file.filename}"\r\nContent-Type: image/jpeg\r\n\r\n`), input.file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  }
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method: input.method, url: input.path, headers: { host: 'app.relaunch72.com', ...(input.method === 'POST' ? { origin: 'https://app.relaunch72.com', 'sec-fetch-site': 'same-origin', 'content-type': contentType, 'content-length': String(body.byteLength) } : {}), ...input.headers } });
  req.end(body); let status = 0, headers: Record<string, string> = {}; const chunks: Buffer[] = [];
  const response = { writeHead(code: number, next: Record<string, string>) { status = code; headers = next; return response; }, end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); } } as unknown as ServerResponse;
  await handleSeoBlog(req, response, new URL(input.path, 'https://app.relaunch72.com'), {
    service: { generation: 'unavailable', research: 'unconfigured', social: 'unavailable', engineFor: () => engine, socialCallback: async () => null },
    identity: input.who, requestId: randomUUID(), sessionSecret: NATIVE_TEST_SECRET, vaultReady: true, applicationName: input.applicationName });
  return { status, headers, body: Buffer.concat(chunks).toString('utf8'), bytes: Buffer.concat(chunks) };
}
