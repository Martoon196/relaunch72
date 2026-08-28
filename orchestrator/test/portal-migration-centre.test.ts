import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  MigrationCentreBoundary,
  createHmacMigrationReceiptSigner,
  type MigrationCommandFence,
  type MigrationRateLimitGate,
} from '../src/legacy-import/migration-centre.js';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import {
  MIGRATION_CENTRE_CLIENT_ROUTE,
  MIGRATION_CENTRE_PREVIEW_ROUTE,
  MIGRATION_CENTRE_ROUTE,
  createPortalMigrationCentreService,
  type PortalMigrationCentreService,
} from '../src/portal/migration-centre-service.js';
import { MIGRATION_CENTRE_CLIENT_SOURCE } from '../src/portal/migration-centre-client.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';

const SECRET = 'migration-centre-router-secret';
const SESSION = Buffer.alloc(32, 61).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE_ID = 'd1000000-0000-4000-8000-000000000001';
const ACTOR_ID = 'd2000000-0000-4000-8000-000000000001';
const NOW = '2026-08-28T12:00:00.000Z';

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: ACTOR_ID,
    userEmail: 'founder@example.test',
    workspaceId: WORKSPACE_ID,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => null,
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function memoryControls() {
  const claims = new Map<string, Readonly<{ commandSha256: string; opaqueId: string; issuedAt: string }>>();
  const fence: MigrationCommandFence = {
    claim(input) {
      const key = [input.namespace, input.workspaceId, input.actorFingerprintSha256,
        input.idempotencyKeySha256].join(':');
      const prior = claims.get(key);
      if (prior) return prior.commandSha256 === input.commandSha256
        ? { disposition: 'replayed', opaqueId: prior.opaqueId, issuedAt: prior.issuedAt }
        : { disposition: 'conflict' };
      claims.set(key, Object.freeze({
        commandSha256: input.commandSha256,
        opaqueId: input.proposedOpaqueId,
        issuedAt: input.proposedAt,
      }));
      return { disposition: 'new', opaqueId: input.proposedOpaqueId, issuedAt: input.proposedAt };
    },
  };
  const rateLimit: MigrationRateLimitGate = {
    reserve(input) {
      return {
        allowed: true,
        reservationSha256: sha(input),
        remaining: 19,
        resetAt: '2026-08-28T13:00:00.000Z',
      };
    },
  };
  return { fence, rateLimit };
}

function migrationService(): PortalMigrationCentreService {
  const controls = memoryControls();
  const boundary = new MigrationCentreBoundary({
    signer: createHmacMigrationReceiptSigner('a'.repeat(64)),
    fence: controls.fence,
    rateLimit: controls.rateLimit,
    now: () => new Date(NOW),
    opaqueId: randomUUID,
  });
  return createPortalMigrationCentreService({
    boundary,
    authorizer: {
      authorize: async (identity) => identity.sessionToken === SESSION ? {
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Property Predator Growth HQ',
        actorId: ACTOR_ID,
        role: 'founder',
        authenticationProofSha256: 'b'.repeat(64),
      } : null,
    },
  });
}

function deps(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres',
    sessionSecret: SECRET,
    secure: false,
    requestId: () => 'migration-centre-request',
    now: () => Date.parse(NOW),
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth,
    crm,
    ...overrides,
  };
}

function request(
  url: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body: readonly (string | Uint8Array)[] = [],
) {
  const req = Readable.from(body.map((chunk) => typeof chunk === 'string'
    ? Buffer.from(chunk, 'utf8')
    : chunk)) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = headers;
  return req;
}

function response() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: Buffer.alloc(0),
    writeHead(code: number, headers?: Record<string, string | string[]>) {
      this.statusCode = code;
      for (const [key, value] of Object.entries(headers ?? {})) {
        this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join('\n') : value;
      }
      return this;
    },
    end(body?: string | Uint8Array) {
      if (typeof body === 'string') this.body = Buffer.from(body);
      else if (body) this.body = Buffer.from(body);
    },
  };
}

async function call(
  url: string,
  portal: PostgresPortalDeps,
  options: Readonly<{
    method?: string;
    cookie?: string;
    headers?: Record<string, string>;
    body?: readonly (string | Uint8Array)[];
  }> = {},
) {
  const res = response();
  await handlePortal(request(url, options.method, {
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...(options.headers ?? {}),
  }, options.body) as never, res as never, portal);
  return res;
}

function mappingHeader(mapping: unknown): string {
  return Buffer.from(JSON.stringify(mapping), 'utf8').toString('base64url');
}

function previewHeaders(csv: string, mapping: unknown, overrides: Record<string, string> = {}) {
  return {
    'content-type': 'text/csv; charset=utf-8',
    'content-length': String(Buffer.byteLength(csv)),
    'sec-fetch-site': 'same-origin',
    'x-pp-migration-csrf': portalCsrfToken(SECRET, SESSION),
    'idempotency-key': 'migration-preview-key-00000001',
    'x-pp-migration-source-system': 'old-ghl',
    'x-pp-migration-source-reference': 'd3000000-0000-4000-8000-000000000001',
    'x-pp-migration-source-exported-at': '2026-08-28T11:30:00.000Z',
    'x-pp-migration-mapping': mappingHeader(mapping),
    ...overrides,
  };
}

const MAPPING = Object.freeze({
  columns: Object.freeze([
    Object.freeze({ sourceHeader: 'Name', targetField: 'contact.full_name' }),
    Object.freeze({ sourceHeader: 'Email', targetField: 'contact.email' }),
    Object.freeze({ sourceHeader: 'Notes', targetField: 'lead.notes' }),
  ]),
  affiliateSourceHeaders: Object.freeze(['Affiliate Code']),
  requiredTargetFields: Object.freeze(['contact.full_name']),
});

test('Migration Centre is authenticated and fails closed when its optional service is absent', async () => {
  const unauthenticated = await call(MIGRATION_CENTRE_ROUTE, deps({ migrations: migrationService() }));
  assert.equal(unauthenticated.statusCode, 302);
  assert.equal(unauthenticated.headers.location, '/portal/login');

  const missing = await call(MIGRATION_CENTRE_ROUTE, deps(), { cookie: COOKIE });
  assert.equal(missing.statusCode, 404);
  assert.match(missing.body.toString(), /Migration Centre not connected/);

  const missingPreview = await call(MIGRATION_CENTRE_PREVIEW_ROUTE, deps(), {
    method: 'POST', cookie: COOKIE,
  });
  assert.equal(missingPreview.statusCode, 404);
  assert.equal(JSON.parse(missingPreview.body.toString()).error.code, 'not_composed');
});

test('Migration Centre page is branded, responsive, effects-free and exposes only its preview command', async () => {
  const result = await call(MIGRATION_CENTRE_ROUTE, deps({ migrations: migrationService() }), {
    cookie: COOKIE,
  });
  const body = result.body.toString();
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.match(result.headers['content-security-policy'] ?? '', /script-src 'self'/u);
  assert.match(result.headers['content-security-policy'] ?? '', /connect-src 'self'/u);
  assert.match(body, /Bring your data[\s\S]*Keep its truth/);
  assert.match(body, /data-migration-file/);
  assert.match(body, /Affiliate source/);
  assert.match(body, /Customer import locked/);
  assert.match(body, /@media\(max-width:720px\)/);
  assert.match(body, new RegExp(`src="${MIGRATION_CENTRE_CLIENT_ROUTE.replaceAll('/', '\\/')}"`));
  assert.doesNotMatch(body, /action="[^"]*commit|Enable import|Import customers now/i);
});

test('same-origin client asset is no-store, syntactically valid and never sends the local file name', async () => {
  const result = await call(MIGRATION_CENTRE_CLIENT_ROUTE, deps());
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'private, no-store, max-age=0');
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.doesNotThrow(() => new Function(MIGRATION_CENTRE_CLIENT_SOURCE));
  assert.match(MIGRATION_CENTRE_CLIENT_SOURCE, /credentials: 'same-origin'/);
  assert.match(MIGRATION_CENTRE_CLIENT_SOURCE, /body: file/);
  assert.doesNotMatch(MIGRATION_CENTRE_CLIENT_SOURCE, /innerHTML|eval\(|localStorage|sessionStorage/);
  assert.doesNotMatch(MIGRATION_CENTRE_CLIENT_SOURCE, /filename|x-pp-migration-file/i);
});

test('raw selected CSV genuinely reaches the reviewed boundary and returns a bounded real preview', async () => {
  const csv = [
    'Name,Email,Affiliate Code,Notes',
    'Ada Lovelace,ada@example.test,partner-7,Asked for the evidence pack',
    'Mallory,mallory@example.test,partner-9,"=IMPORTXML(""https://evil.test"")"',
  ].join('\n');
  const result = await call(MIGRATION_CENTRE_PREVIEW_ROUTE, deps({ migrations: migrationService() }), {
    method: 'POST', cookie: COOKIE, headers: previewHeaders(csv, MAPPING), body: [csv],
  });
  const payload = JSON.parse(result.body.toString());
  assert.equal(result.statusCode, 200, result.body.toString());
  assert.equal(result.headers['cache-control'], 'private, no-store, max-age=0');
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.equal(result.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.acceptedRowCount, 1);
  assert.equal(payload.summary.quarantinedRowCount, 1);
  assert.equal(payload.acceptedRows[0].contact.full_name.value, 'Ada Lovelace');
  assert.deepEqual(payload.acceptedRows[0].affiliateSources[0], {
    column: 'affiliate_code', value: 'partner-7', truncated: false,
  });
  assert.deepEqual(payload.quarantinedRows[0].reasons, ['formula_injection_cell']);
  assert.equal(payload.execution.liveCustomerImport, false);
  assert.equal(payload.execution.commitAvailable, false);
  assert.match(payload.receipt.receiptSha256, /^[0-9a-f]{64}$/u);
  assert.match(payload.receipt.affiliateAttributionSha256, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(result.body.toString(), /IMPORTXML|evil\.test|\.csv/iu);
});

test('CSRF, fetch-site and bounded mapping metadata fail before preview/body processing', async () => {
  let previewCalls = 0;
  const service: PortalMigrationCentreService = {
    access: async () => ({ ok: true, workspaceName: 'Property Predator Growth HQ', role: 'founder' }),
    preview: async () => {
      previewCalls += 1;
      throw new Error('must not be called');
    },
  };
  const csv = 'Name\nAda';
  const invalidCsrf = await call(MIGRATION_CENTRE_PREVIEW_ROUTE, deps({ migrations: service }), {
    method: 'POST', cookie: COOKIE,
    headers: previewHeaders(csv, MAPPING, { 'x-pp-migration-csrf': 'wrong' }), body: [csv],
  });
  assert.equal(invalidCsrf.statusCode, 403);

  const crossSite = await call(MIGRATION_CENTRE_PREVIEW_ROUTE, deps({ migrations: service }), {
    method: 'POST', cookie: COOKIE,
    headers: previewHeaders(csv, MAPPING, { 'sec-fetch-site': 'cross-site' }), body: [csv],
  });
  assert.equal(crossSite.statusCode, 403);

  const unknownMappingKey = await call(MIGRATION_CENTRE_PREVIEW_ROUTE, deps({ migrations: service }), {
    method: 'POST', cookie: COOKIE,
    headers: previewHeaders(csv, { ...MAPPING, rawRows: true }), body: [csv],
  });
  assert.equal(unknownMappingKey.statusCode, 400);
  assert.equal(JSON.parse(unknownMappingKey.body.toString()).error.code, 'mapping_invalid');
  assert.equal(previewCalls, 0);
});

test('the preview fence replays exact retries and conflicts on changed CSV bytes', async () => {
  const service = migrationService();
  const firstCsv = 'Name,Email,Affiliate Code,Notes\nAda,ada@example.test,aff-1,Hello';
  const first = await call(MIGRATION_CENTRE_PREVIEW_ROUTE, deps({ migrations: service }), {
    method: 'POST', cookie: COOKIE, headers: previewHeaders(firstCsv, MAPPING), body: [firstCsv],
  });
  const replay = await call(MIGRATION_CENTRE_PREVIEW_ROUTE, deps({ migrations: service }), {
    method: 'POST', cookie: COOKIE, headers: previewHeaders(firstCsv, MAPPING), body: [firstCsv],
  });
  assert.equal(first.statusCode, 200);
  assert.equal(replay.statusCode, 200);
  assert.equal(JSON.parse(replay.body.toString()).disposition, 'replayed');
  assert.equal(
    JSON.parse(first.body.toString()).receipt.receiptSha256,
    JSON.parse(replay.body.toString()).receipt.receiptSha256,
  );

  const changedCsv = firstCsv.replace('Hello', 'Changed');
  const conflict = await call(MIGRATION_CENTRE_PREVIEW_ROUTE, deps({ migrations: service }), {
    method: 'POST', cookie: COOKIE,
    headers: previewHeaders(changedCsv, MAPPING, {
      'content-length': String(Buffer.byteLength(changedCsv)),
    }),
    body: [changedCsv],
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(JSON.parse(conflict.body.toString()).error.code, 'idempotency_conflict');
});

test('browser response samples are capped and long values are visibly truncated', async () => {
  const longNote = 'x'.repeat(700);
  const rows = ['Name,Email,Affiliate Code,Notes'];
  for (let index = 0; index < 30; index += 1) {
    rows.push(`Person ${index},person${index}@example.test,aff-${index},${longNote}`);
  }
  const csv = rows.join('\n');
  const result = await call(MIGRATION_CENTRE_PREVIEW_ROUTE, deps({ migrations: migrationService() }), {
    method: 'POST', cookie: COOKIE, headers: previewHeaders(csv, MAPPING), body: [csv],
  });
  const payload = JSON.parse(result.body.toString());
  assert.equal(result.statusCode, 200, result.body.toString());
  assert.equal(payload.acceptedRows.length, 25);
  assert.equal(payload.summary.omittedAcceptedRowCount, 5);
  assert.equal(payload.acceptedRows[0].lead.notes.value.length, 512);
  assert.equal(payload.acceptedRows[0].lead.notes.truncated, true);
});

test('no live commit/import endpoint is mounted', async () => {
  const result = await call('/portal/migrations/commit', deps({ migrations: migrationService() }), {
    method: 'POST', cookie: COOKIE,
  });
  assert.equal(result.statusCode, 404);
});
