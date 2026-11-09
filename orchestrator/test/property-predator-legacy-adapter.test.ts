import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PropertyPredatorExportAdapterError,
  adaptPropertyPredatorLegacyExportV1,
  normalizeLegacyLeadBatch,
  type PropertyPredatorLegacyExportV1,
} from '../src/legacy-import/index.js';

const owner = {
  id: 'account-owner',
  email: 'owner@example.test',
  email_verified: true,
  brand_contact: '  Alex Owner  ',
  brand_company: 'Predator Partners',
  created_at: '2026-01-01T09:00:00Z',
};

const referred = {
  id: 'account-referred',
  email: 'lead@example.test',
  created_at: '2026-01-02T10:00:00Z',
};

const affiliate = {
  id: 'affiliate-1',
  account_id: owner.id,
  code: 'PREDATOR72',
  clicks: 17,
  created_at: '2026-01-01T11:00:00Z',
};

const referral = {
  id: 'referral-1',
  affiliate_id: affiliate.id,
  referred_account_id: referred.id,
  created_at: '2026-01-02T09:00:00Z',
};

const commission = {
  id: 'commission-1',
  affiliate_id: affiliate.id,
  referred_account_id: referred.id,
  gross_pence: 10_000,
  amount_pence: 3_000,
  source: 'subscription',
  stripe_ref: 'invoice_source_1',
  status: 'due',
  created_at: '2026-01-03T12:00:00Z',
};

function source(overrides: Partial<PropertyPredatorLegacyExportV1> = {}): PropertyPredatorLegacyExportV1 {
  return {
    schemaVersion: 1,
    batchKey: 'property-predator-export-2026-08-25',
    users: [referred, owner],
    affiliates: [affiliate],
    affiliate_referrals: [referral],
    affiliate_commissions: [commission],
    ...overrides,
  };
}

test('v1 adapter deterministically keeps lead attribution and explicit verification evidence', () => {
  const input = source();
  const result = adaptPropertyPredatorLegacyExportV1(input);

  assert.equal(result.sourceSystem, 'property-predator-v1');
  assert.deepEqual(result.rows.map((row) => row.sourceRecordId), [owner.id, referred.id]);
  assert.equal(result.rows[0]?.displayName, 'Alex Owner');
  assert.equal(result.rows[0]?.identities[0]?.verified, true);

  const referredLead = result.rows[1]!;
  assert.equal(referredLead.displayName, referred.email);
  assert.equal(referredLead.identities[0]?.verified, false);
  assert.deepEqual(referredLead.attribution, {
    affiliateSourceId: affiliate.id,
    affiliateName: 'Alex Owner',
    affiliateCode: affiliate.code,
    referralCode: affiliate.code,
    attributedAt: referral.created_at,
    raw: {
      affiliate: {
        id: affiliate.id,
        account_id: affiliate.account_id,
        code: affiliate.code,
        created_at: affiliate.created_at,
        clicks: 17,
      },
      referral,
    },
  });

  const quarantinedCommission = result.unresolvedAttributions?.[0];
  assert.equal(quarantinedCommission?.recordKind, 'commission');
  assert.equal(quarantinedCommission?.reason, 'source_integrity_conflict');
  assert.deepEqual(quarantinedCommission?.raw, commission);

  // The adapter result is immediately valid under canonical import schema v1.
  assert.doesNotThrow(() => normalizeLegacyLeadBatch(
    result,
    new Date('2026-08-25T12:00:00Z'),
  ));
  assert.deepEqual(input.users, [referred, owner], 'input arrays are not reordered or mutated');
});

test('missing and broken affiliate relationships are quarantined without inventing contacts', () => {
  const brokenAffiliate = {
    id: 'affiliate-orphan',
    account_id: 'missing-owner',
    code: 'ORPHAN',
    parent_id: 'missing-parent',
    created_at: '2026-01-01T00:00:00Z',
  };
  const missingContactReferral = {
    id: 'referral-missing-contact',
    affiliate_id: brokenAffiliate.id,
    referred_account_id: 'missing-contact',
    created_at: '2026-01-04T00:00:00Z',
  };
  const missingAffiliateReferral = {
    id: 'referral-missing-affiliate',
    affiliate_id: 'missing-affiliate',
    referred_account_id: referred.id,
    created_at: '2026-01-05T00:00:00Z',
  };
  const result = adaptPropertyPredatorLegacyExportV1(source({
    users: [referred],
    affiliates: [brokenAffiliate],
    affiliate_referrals: [missingContactReferral, missingAffiliateReferral],
    affiliate_commissions: [{
      ...commission,
      id: 'commission-missing-contact',
      affiliate_id: brokenAffiliate.id,
      referred_account_id: 'missing-contact',
    }, {
      ...commission,
      id: 'commission-missing-affiliate',
      affiliate_id: 'missing-affiliate',
      referred_account_id: referred.id,
    }],
  }));

  assert.deepEqual(result.rows.map((row) => row.sourceRecordId), [referred.id]);
  assert.equal(result.rows[0]?.attribution, null);
  assert.deepEqual(
    result.unresolvedAttributions?.map((item) => [item.recordKind, item.sourceRecordId, item.reason]),
    [
      ['affiliate', brokenAffiliate.id, 'missing_affiliate_owner'],
      ['commission', 'commission-missing-affiliate', 'broken_reference'],
      ['commission', 'commission-missing-contact', 'missing_contact'],
      ['referral', missingAffiliateReferral.id, 'broken_reference'],
      ['referral', missingContactReferral.id, 'missing_contact'],
    ],
  );
});

test('multiple source referrals for one account are all retained as conflicts', () => {
  const secondAffiliate = {
    ...affiliate,
    id: 'affiliate-2',
    account_id: referred.id,
    code: 'SECOND72',
  };
  const secondReferral = {
    ...referral,
    id: 'referral-2',
    affiliate_id: secondAffiliate.id,
  };
  const result = adaptPropertyPredatorLegacyExportV1(source({
    users: [owner, referred],
    affiliates: [affiliate, secondAffiliate],
    affiliate_referrals: [secondReferral, referral],
    affiliate_commissions: [],
  }));

  assert.equal(result.rows.find((row) => row.sourceRecordId === referred.id)?.attribution, null);
  assert.deepEqual(
    result.unresolvedAttributions?.filter((item) => item.recordKind === 'referral')
      .map((item) => [item.sourceRecordId, item.reason]),
    [
      ['referral-1', 'source_integrity_conflict'],
      ['referral-2', 'source_integrity_conflict'],
    ],
  );
});

test('a referral cannot trust an affiliate already quarantined as invalid', () => {
  const invalidAffiliate = {
    ...affiliate,
    id: 'affiliate-invalid-owner',
    account_id: 'missing-owner',
    code: 'TAINTED72',
  };
  const taintedReferral = {
    ...referral,
    id: 'referral-tainted-affiliate',
    affiliate_id: invalidAffiliate.id,
  };
  const result = adaptPropertyPredatorLegacyExportV1(source({
    users: [referred],
    affiliates: [invalidAffiliate],
    affiliate_referrals: [taintedReferral],
    affiliate_commissions: [],
  }));

  assert.equal(result.rows[0]?.attribution, null);
  assert.deepEqual(
    result.unresolvedAttributions?.map((item) => [item.recordKind, item.sourceRecordId, item.reason]),
    [
      ['affiliate', invalidAffiliate.id, 'missing_affiliate_owner'],
      ['referral', taintedReferral.id, 'source_integrity_conflict'],
    ],
  );
});

test('verification is false unless the source supplies the boolean true', () => {
  const truthyButUnproven = {
    ...referred,
    email_verified: 1,
  } as unknown as typeof referred & { email_verified: boolean };
  const result = adaptPropertyPredatorLegacyExportV1(source({
    users: [truthyButUnproven, { ...owner, email_verified: false }],
    affiliate_referrals: [],
    affiliate_commissions: [],
  }));

  assert.deepEqual(
    result.rows.map((row) => row.identities[0]?.verified),
    [false, false],
  );
});

test('the pure adapter emits no PII to console and rejects duplicate source ids generically', () => {
  const calls: unknown[][] = [];
  const previous = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...values: unknown[]) => { calls.push(values); };
  console.warn = (...values: unknown[]) => { calls.push(values); };
  console.error = (...values: unknown[]) => { calls.push(values); };
  try {
    adaptPropertyPredatorLegacyExportV1(source());
    assert.throws(
      () => adaptPropertyPredatorLegacyExportV1(source({ users: [owner, owner] })),
      (error) => error instanceof PropertyPredatorExportAdapterError
        && error.message === 'users contains a duplicate id'
        && !error.message.includes(owner.id)
        && !error.message.includes(owner.email),
    );
  } finally {
    console.log = previous.log;
    console.warn = previous.warn;
    console.error = previous.error;
  }
  assert.deepEqual(calls, []);
});
