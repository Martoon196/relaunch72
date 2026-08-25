import type {
  LegacyLeadAttributionInput,
  LegacyLeadBatchInput,
  LegacyLeadRowInput,
  LegacyUnresolvedAttributionInput,
} from './types.js';

/**
 * The source identifier is versioned independently from the canonical import
 * schema so a future Property Predator export can coexist with this contract.
 */
export const PROPERTY_PREDATOR_LEGACY_SOURCE_V1 = 'property-predator-v1';

export interface PropertyPredatorUserExportRowV1 {
  readonly id: string;
  readonly email: string;
  readonly created_at: string;
  /** Must be supplied from source evidence. Missing, null and non-boolean values are not verified. */
  readonly email_verified?: boolean | null;
  readonly brand_contact?: string | null;
  readonly brand_company?: string | null;
}

export interface PropertyPredatorAffiliateExportRowV1 {
  readonly id: string;
  readonly account_id: string;
  readonly code: string;
  readonly created_at: string;
  readonly parent_id?: string | null;
  readonly clicks?: number | null;
  readonly code_status?: string | null;
  readonly prev_code?: string | null;
}

export interface PropertyPredatorAffiliateReferralExportRowV1 {
  readonly id: string;
  readonly affiliate_id: string;
  readonly referred_account_id: string;
  readonly created_at: string;
}

export interface PropertyPredatorAffiliateCommissionExportRowV1 {
  readonly id: string;
  readonly affiliate_id: string;
  readonly referred_account_id: string;
  readonly gross_pence: number;
  readonly amount_pence: number;
  readonly source: string;
  readonly stripe_ref: string;
  readonly status: string;
  readonly created_at: string;
}

/** Source-native table names make an export mapping explicit and reviewable. */
export interface PropertyPredatorLegacyExportV1 {
  readonly schemaVersion: 1;
  readonly batchKey: string;
  readonly users: readonly PropertyPredatorUserExportRowV1[];
  readonly affiliates: readonly PropertyPredatorAffiliateExportRowV1[];
  readonly affiliate_referrals: readonly PropertyPredatorAffiliateReferralExportRowV1[];
  readonly affiliate_commissions: readonly PropertyPredatorAffiliateCommissionExportRowV1[];
}

export class PropertyPredatorExportAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyPredatorExportAdapterError';
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function trimmed(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  return candidate || null;
}

function uniqueById<T extends { readonly id: string }>(rows: readonly T[], table: string): readonly T[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) {
      // Deliberately omit the value: source identifiers can themselves be sensitive.
      throw new PropertyPredatorExportAdapterError(`${table} contains a duplicate id`);
    }
    ids.add(row.id);
  }
  return [...rows].sort((left, right) => compareText(left.id, right.id));
}

function affiliateRaw(row: PropertyPredatorAffiliateExportRowV1): Readonly<Record<string, unknown>> {
  // Payout addresses and payout JSON are intentionally not accepted by this CRM
  // adapter. They belong in a separately controlled affiliate-ledger migration.
  const raw: Record<string, unknown> = {
    id: row.id,
    account_id: row.account_id,
    code: row.code,
    created_at: row.created_at,
  };
  if (row.parent_id !== undefined) raw.parent_id = row.parent_id;
  if (row.clicks !== undefined) raw.clicks = row.clicks;
  if (row.code_status !== undefined) raw.code_status = row.code_status;
  if (row.prev_code !== undefined) raw.prev_code = row.prev_code;
  return raw;
}

function referralRaw(
  row: PropertyPredatorAffiliateReferralExportRowV1,
): Readonly<Record<string, unknown>> {
  return {
    id: row.id,
    affiliate_id: row.affiliate_id,
    referred_account_id: row.referred_account_id,
    created_at: row.created_at,
  };
}

function commissionRaw(
  row: PropertyPredatorAffiliateCommissionExportRowV1,
): Readonly<Record<string, unknown>> {
  return {
    id: row.id,
    affiliate_id: row.affiliate_id,
    referred_account_id: row.referred_account_id,
    gross_pence: row.gross_pence,
    amount_pence: row.amount_pence,
    source: row.source,
    stripe_ref: row.stripe_ref,
    status: row.status,
    created_at: row.created_at,
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    const group = groups.get(value) ?? [];
    group.push(row);
    groups.set(value, group);
  }
  return groups;
}

function affiliateDisplayName(
  affiliate: PropertyPredatorAffiliateExportRowV1,
  usersById: ReadonlyMap<string, PropertyPredatorUserExportRowV1>,
): string | null {
  const owner = usersById.get(affiliate.account_id);
  return trimmed(owner?.brand_contact) ?? trimmed(owner?.brand_company);
}

function leadAttribution(
  referral: PropertyPredatorAffiliateReferralExportRowV1,
  affiliate: PropertyPredatorAffiliateExportRowV1,
  usersById: ReadonlyMap<string, PropertyPredatorUserExportRowV1>,
): LegacyLeadAttributionInput {
  return {
    affiliateSourceId: affiliate.id,
    affiliateName: affiliateDisplayName(affiliate, usersById),
    affiliateCode: affiliate.code,
    // Property Predator uses the affiliate code as its ?ref= referral code.
    referralCode: affiliate.code,
    attributedAt: referral.created_at,
    raw: {
      affiliate: affiliateRaw(affiliate),
      referral: referralRaw(referral),
    },
  };
}

function unresolvedAffiliate(
  affiliate: PropertyPredatorAffiliateExportRowV1,
  usersById: ReadonlyMap<string, PropertyPredatorUserExportRowV1>,
  affiliatesById: ReadonlyMap<string, PropertyPredatorAffiliateExportRowV1>,
  affiliatesByOwner: ReadonlyMap<string, readonly PropertyPredatorAffiliateExportRowV1[]>,
  affiliatesByCode: ReadonlyMap<string, readonly PropertyPredatorAffiliateExportRowV1[]>,
): LegacyUnresolvedAttributionInput | null {
  const ownerMissing = !usersById.has(affiliate.account_id);
  const parentMissing = Boolean(affiliate.parent_id && !affiliatesById.has(affiliate.parent_id));
  const duplicatedOwner = (affiliatesByOwner.get(affiliate.account_id)?.length ?? 0) > 1;
  const duplicatedCode = (affiliatesByCode.get(affiliate.code.toLowerCase())?.length ?? 0) > 1;
  if (!ownerMissing && !parentMissing && !duplicatedOwner && !duplicatedCode) return null;

  return {
    recordKind: 'affiliate',
    sourceRecordId: affiliate.id,
    referredSourceRecordId: affiliate.account_id,
    originalCreatedAt: affiliate.created_at,
    reason: ownerMissing
      ? 'missing_affiliate_owner'
      : parentMissing
        ? 'broken_reference'
        : 'source_integrity_conflict',
    affiliateSourceId: affiliate.id,
    affiliateCode: affiliate.code,
    referralCode: affiliate.code,
    raw: affiliateRaw(affiliate),
  };
}

function unresolvedReferral(
  referral: PropertyPredatorAffiliateReferralExportRowV1,
  reason: LegacyUnresolvedAttributionInput['reason'],
  affiliate?: PropertyPredatorAffiliateExportRowV1,
): LegacyUnresolvedAttributionInput {
  return {
    recordKind: 'referral',
    sourceRecordId: referral.id,
    referredSourceRecordId: referral.referred_account_id,
    originalCreatedAt: referral.created_at,
    reason,
    affiliateSourceId: affiliate?.id ?? referral.affiliate_id,
    affiliateCode: affiliate?.code ?? null,
    referralCode: affiliate?.code ?? null,
    raw: referralRaw(referral),
  };
}

function unresolvedCommission(
  commission: PropertyPredatorAffiliateCommissionExportRowV1,
  usersById: ReadonlyMap<string, PropertyPredatorUserExportRowV1>,
  affiliatesById: ReadonlyMap<string, PropertyPredatorAffiliateExportRowV1>,
): LegacyUnresolvedAttributionInput {
  const affiliate = affiliatesById.get(commission.affiliate_id);
  return {
    recordKind: 'commission',
    sourceRecordId: commission.id,
    referredSourceRecordId: commission.referred_account_id,
    originalCreatedAt: commission.created_at,
    reason: !usersById.has(commission.referred_account_id)
      ? 'missing_contact'
      : !affiliate
        ? 'broken_reference'
        // Financial rows must be reconciled into a future affiliate ledger, never
        // projected into a CRM contact or treated as ordinary attribution.
        : 'source_integrity_conflict',
    affiliateSourceId: affiliate?.id ?? commission.affiliate_id,
    affiliateCode: affiliate?.code ?? null,
    referralCode: affiliate?.code ?? null,
    raw: commissionRaw(commission),
  };
}

/**
 * Converts a source export to the canonical immutable import contract.
 *
 * This function is deliberately pure: it performs no database/network I/O and
 * does not write to the console. Relationships that cannot be represented
 * safely are retained as quarantined evidence instead of manufacturing leads.
 */
export function adaptPropertyPredatorLegacyExportV1(
  input: PropertyPredatorLegacyExportV1,
): LegacyLeadBatchInput {
  if (input.schemaVersion !== 1) {
    throw new PropertyPredatorExportAdapterError('unsupported Property Predator export schema');
  }

  const users = uniqueById(input.users, 'users');
  const affiliates = uniqueById(input.affiliates, 'affiliates');
  const referrals = uniqueById(input.affiliate_referrals, 'affiliate_referrals');
  const commissions = uniqueById(input.affiliate_commissions, 'affiliate_commissions');

  const usersById = new Map(users.map((row) => [row.id, row]));
  const affiliatesById = new Map(affiliates.map((row) => [row.id, row]));
  const referralsByAccount = groupBy(referrals, (row) => row.referred_account_id);
  const affiliatesByOwner = groupBy(affiliates, (row) => row.account_id);
  const affiliatesByCode = groupBy(affiliates, (row) => row.code.toLowerCase());
  const unresolved: LegacyUnresolvedAttributionInput[] = [];
  const invalidAffiliateIds = new Set<string>();

  for (const affiliate of affiliates) {
    const item = unresolvedAffiliate(
      affiliate,
      usersById,
      affiliatesById,
      affiliatesByOwner,
      affiliatesByCode,
    );
    if (item) {
      invalidAffiliateIds.add(affiliate.id);
      unresolved.push(item);
    }
  }

  for (const referral of referrals) {
    const affiliate = affiliatesById.get(referral.affiliate_id);
    const accountReferrals = referralsByAccount.get(referral.referred_account_id) ?? [];
    if (!usersById.has(referral.referred_account_id)) {
      unresolved.push(unresolvedReferral(referral, 'missing_contact', affiliate));
    } else if (!affiliate) {
      unresolved.push(unresolvedReferral(referral, 'broken_reference'));
    } else if (invalidAffiliateIds.has(affiliate.id)) {
      unresolved.push(unresolvedReferral(referral, 'source_integrity_conflict', affiliate));
    } else if (accountReferrals.length > 1) {
      unresolved.push(unresolvedReferral(referral, 'source_integrity_conflict', affiliate));
    }
  }

  for (const commission of commissions) {
    unresolved.push(unresolvedCommission(commission, usersById, affiliatesById));
  }

  const rows: LegacyLeadRowInput[] = users.map((user) => {
    const brandContact = trimmed(user.brand_contact);
    const companyName = trimmed(user.brand_company);
    const accountReferrals = referralsByAccount.get(user.id) ?? [];
    const referral = accountReferrals.length === 1 ? accountReferrals[0] : undefined;
    const affiliate = referral && !invalidAffiliateIds.has(referral.affiliate_id)
      ? affiliatesById.get(referral.affiliate_id)
      : undefined;
    return {
      sourceRecordId: user.id,
      displayName: brandContact ?? companyName ?? user.email,
      companyName,
      originalCreatedAt: user.created_at,
      identities: [{
        kind: 'email',
        value: user.email,
        // Strict equality prevents a SQLite 1, a truthy string or account
        // existence from being promoted to verification evidence.
        verified: user.email_verified === true,
        label: 'Legacy Property Predator account',
        primary: true,
      }],
      attribution: referral && affiliate
        ? leadAttribution(referral, affiliate, usersById)
        : null,
    };
  });

  unresolved.sort((left, right) => (
    compareText(left.recordKind, right.recordKind)
    || compareText(left.sourceRecordId, right.sourceRecordId)
  ));

  return {
    schemaVersion: 1,
    sourceSystem: PROPERTY_PREDATOR_LEGACY_SOURCE_V1,
    batchKey: input.batchKey,
    rows,
    unresolvedAttributions: unresolved,
  };
}
