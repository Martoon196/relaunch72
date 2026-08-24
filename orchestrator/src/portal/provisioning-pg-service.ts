import { createHash, randomBytes } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SETUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface NativeCustomerProvisioningInput {
  /** Trusted payment/order authority. A browser value must never be used here. */
  idempotencyKey: string;
  organizationName: string;
  workspaceName?: string;
  ownerEmail: string;
  ownerDisplayName?: string;
  timezone?: string;
  locale?: string;
  currency?: string;
}

export interface NativeCustomerProvisioningResult {
  organizationId: string;
  workspaceId: string;
  ownerUserId: string;
  setupActionTokenId: string;
  setupExpiresAt: string;
  createdNow: boolean;
  /** Present only for the transaction that stored this token's hash. */
  setupToken: string | null;
}

interface ProvisioningRow extends QueryResultRow {
  organization_id: string;
  workspace_id: string;
  owner_user_id: string;
  setup_action_token_id: string;
  setup_expires_at: string | Date;
  created_now: boolean;
}

export interface PgCustomerProvisioningDependencies {
  commandPool: Pick<Pool, 'query'>;
  /** Test seam. Production uses a cryptographically random 256-bit token. */
  createSetupToken?: () => string;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function normalizedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} characters`);
  }
  return normalized;
}

function stableSlug(name: string, authority: string, suffix: string): string {
  const readable = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || suffix;
  const digest = createHash('sha256').update(`${authority}\0${suffix}`).digest('hex').slice(0, 10);
  const prefix = readable.slice(0, 51).replace(/-+$/g, '') || suffix;
  return `${prefix}-${digest}`;
}

function validateInput(input: NativeCustomerProvisioningInput): {
  idempotencyKey: string;
  organizationName: string;
  organizationSlug: string;
  workspaceName: string;
  workspaceSlug: string;
  ownerEmail: string;
  ownerDisplayName: string;
  timezone: string;
  locale: string;
  currency: string;
} {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 128 || idempotencyKey !== input.idempotencyKey) {
    throw new Error('idempotencyKey must be a trimmed value of 1 to 128 characters');
  }
  const organizationName = normalizedText(input.organizationName, 'organizationName', 200);
  const workspaceName = normalizedText(input.workspaceName ?? organizationName, 'workspaceName', 200);
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  if (ownerEmail.length > 320 || !EMAIL_PATTERN.test(ownerEmail)) {
    throw new Error('ownerEmail must be a valid email address');
  }
  const ownerDisplayName = normalizedText(
    input.ownerDisplayName ?? ownerEmail.split('@')[0] ?? 'Owner',
    'ownerDisplayName',
    200,
  );
  const timezone = normalizedText(input.timezone ?? 'Europe/London', 'timezone', 100);
  const locale = normalizedText(input.locale ?? 'en-GB', 'locale', 20);
  const currency = (input.currency ?? 'GBP').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be a three-letter ISO code');
  return {
    idempotencyKey,
    organizationName,
    organizationSlug: stableSlug(organizationName, idempotencyKey, 'org'),
    workspaceName,
    workspaceSlug: stableSlug(workspaceName, idempotencyKey, 'workspace'),
    ownerEmail,
    ownerDisplayName,
    timezone,
    locale,
    currency,
  };
}

/**
 * Calls one SECURITY DEFINER transaction that creates the complete native
 * customer boundary. The raw setup credential exists only in this process and
 * is returned only when its hash was inserted by this exact call.
 */
export class PgCustomerProvisioningService {
  constructor(private readonly dependencies: PgCustomerProvisioningDependencies) {}

  async provision(input: NativeCustomerProvisioningInput): Promise<NativeCustomerProvisioningResult> {
    const canonical = validateInput(input);
    const setupToken = (this.dependencies.createSetupToken ?? (() => randomBytes(32).toString('base64url')))();
    if (!SETUP_TOKEN_PATTERN.test(setupToken)) {
      throw new Error('setup token generator must return exactly 256 bits encoded as base64url');
    }

    const result = await this.dependencies.commandPool.query<ProvisioningRow>(
      `/* portal.provision.native-customer */
       SELECT organization_id, workspace_id, owner_user_id,
              setup_action_token_id, setup_expires_at, created_now
       FROM app_private.provision_customer_workspace(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       )`,
      [
        canonical.idempotencyKey,
        canonical.organizationName,
        canonical.organizationSlug,
        canonical.workspaceName,
        canonical.workspaceSlug,
        canonical.ownerEmail,
        canonical.ownerDisplayName,
        sha256(setupToken),
        canonical.timezone,
        canonical.locale,
        canonical.currency,
      ],
    );
    if (result.rows.length !== 1) throw new Error('Customer provisioning did not return exactly one result');
    const row = result.rows[0]!;
    const organizationId = canonicalUuid(row.organization_id);
    const workspaceId = canonicalUuid(row.workspace_id);
    const ownerUserId = canonicalUuid(row.owner_user_id);
    const setupActionTokenId = canonicalUuid(row.setup_action_token_id);
    const rawExpiry = row.setup_expires_at instanceof Date
      ? row.setup_expires_at.toISOString()
      : row.setup_expires_at;
    const expiry = typeof rawExpiry === 'string' ? Date.parse(rawExpiry) : Number.NaN;
    if (!organizationId || !workspaceId || !ownerUserId || !setupActionTokenId
        || !Number.isFinite(expiry) || typeof row.created_now !== 'boolean') {
      throw new Error('Customer provisioning returned invalid canonical data');
    }
    return Object.freeze({
      organizationId,
      workspaceId,
      ownerUserId,
      setupActionTokenId,
      setupExpiresAt: new Date(expiry).toISOString(),
      createdNow: row.created_now,
      setupToken: row.created_now ? setupToken : null,
    });
  }
}
