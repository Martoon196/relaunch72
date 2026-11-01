import type { Pool, QueryResultRow } from 'pg';
import {
  DEFAULT_MIGRATIONS_DIR,
  discoverMigrations,
  validateAppliedState,
} from './migrate.js';

interface RuntimeMigrationRow extends QueryResultRow {
  filename: string;
  checksum: string;
}

const FINANCE_COMPATIBILITY_MIGRATION = '0106_finance_planning_drafts.sql';
const FINANCE_COMPATIBILITY_CHECKSUM = '422d1766390910417b397bb34607f74a56c8d7744c3f88a84c4ae46e39ae40ba';
const MHP_GROWTH_COMPATIBILITY_MIGRATION = '0121_mhp_prospects_learning.sql';
const MHP_GROWTH_COMPATIBILITY_CHECKSUM = 'a39051a348303ffc752ed449322ffee2df5d8dbd2b1a0c49673c7c918500362f';
const SMS_PHONE_COMPATIBILITY_MIGRATION = '0122_property_predator_sms_phone_verification.sql';
const SMS_PHONE_COMPATIBILITY_CHECKSUM = '52904bc9e50db657c537f6033814455db185e30877091196b47ea586aed60e8d';
const SMS_TRIGGER_ACL_REPAIR_MIGRATION = '0123_sms_phone_receipt_trigger_acl.sql';
const SMS_TRIGGER_ACL_REPAIR_CHECKSUM = '094d3118a85131c099749ecd000c4c4b9141ea6ba00e8c643190fa5cf5a1554d';
const MHP_MARKETING_COMPATIBILITY_MIGRATION = '0124_mhp_brand_marketing_workspace.sql';
const MHP_MARKETING_COMPATIBILITY_CHECKSUM = '6d17547dc37070b736f23e2a7906dc40739b66c50de262eacdbe9ace7e011209';
const MHP_WEBINAR_READER_MIGRATION = '0125_mhp_webinar_lead_candidates.sql';
const MHP_WEBINAR_READER_CHECKSUM = '91bd726210fe34fa4edf46565f6c5f48d9005a6a177d735d808101d44f41c259';
const MHP_OWNER_EMAIL_MIGRATION = '0126_mhp_owner_email_editor.sql';
const MHP_OWNER_EMAIL_CHECKSUM = '317555ffd745918305f4d9209112ed4abf7eca8ed283e7db3ceb0bffcd2aef76';
const MHP_FOLLOWUP_SEQUENCE_MIGRATION = '0127_mhp_followup_sequences.sql';
const MHP_FOLLOWUP_SEQUENCE_CHECKSUM = 'bfd4319fe4a0f07b93d54d528b54f3468ae0857ad53e53a8b7a038ebb1a76f23';
const MHP_CAPTURE_ENTRY_MIGRATION = '0128_mhp_sequence_capture_entry.sql';
const MHP_CAPTURE_ENTRY_CHECKSUM = '09b35b4eaf6e934c8f560e8d9d645bd3b9f37a34268f77f4afd974ecd1b54e97';
const MHP_LOCAL_CHANNEL_DRAFTS_MIGRATION = '0129_mhp_local_channel_drafts.sql';
const MHP_LOCAL_CHANNEL_DRAFTS_CHECKSUM = '649ba68b60954b6e76d4e702511321e59eff0785128051ed7b81f968abe1b57a';
const MHP_OWNED_SMS_MIGRATION = '0130_mhp_owned_sms_pilot.sql';
const MHP_OWNED_SMS_CHECKSUM = 'e6bb5be3a87e0fde3e29d3f47edde1c5daf8492f4c368f80e2e4335f5b239797';
const SEO_BLOG_MIGRATION = '0131_seo_blog_engine.sql';
const SEO_BLOG_CHECKSUM = '904c4651c51da6507370ca7eb2f271ca0347a27d76c60b0f24a19aba01695784';
const SEO_BLOG_SOCIAL_MIGRATION = '0132_seo_blog_social_promotion.sql';
const SEO_BLOG_SOCIAL_CHECKSUM = '6a413abf1e1f04c7ce7cfa181c2ee6c7ced7b0155fcc2c4106ff860c98fa03cb';
const SEO_BLOG_SOCIAL_DISPATCH_MIGRATION = '0133_seo_blog_social_dispatch_reservations.sql';
const SEO_BLOG_SOCIAL_DISPATCH_CHECKSUM = '457402d6dc48129fe457044564a99720061bdc2e701e84ddbbb9cd957bba591f';

/**
 * Prove that a least-privilege runtime is connected to the exact schema bundled
 * with this release. The safe SQL function exists only from migration 0004, so
 * an older database fails closed before any portal service is composed.
 */
export async function assertRuntimeSchemaCurrent(
  pool: Pick<Pool, 'query'>,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<void> {
  const migrations = await discoverMigrations(migrationsDir);
  const result = await pool.query<RuntimeMigrationRow>(
    `/* database.runtime-schema-readiness */
     SELECT filename, checksum
     FROM app_private.runtime_schema_migrations()`,
  );
  const applied = new Map<string, string>();
  for (const row of result.rows) {
    if (typeof row.filename !== 'string' || typeof row.checksum !== 'string' || applied.has(row.filename)) {
      throw new Error('Database returned an invalid runtime migration ledger');
    }
    applied.set(row.filename, row.checksum);
  }

  // This pre-finance recovery build supports only the reviewed additive 0106.
  // A release which bundles 0106 takes the normal strict path and requires it.
  // The database ledger is read-only; all earlier and unknown rows still pass
  // through the existing exact-checksum and contiguous-prefix validation.
  if (migrations.length === 105
      && migrations[104]?.filename === '0105_public_social_planner_session_lock.sql'
      && applied.get(FINANCE_COMPATIBILITY_MIGRATION) === FINANCE_COMPATIBILITY_CHECKSUM) {
    applied.delete(FINANCE_COMPATIBILITY_MIGRATION);
  }
  // Allow the exact reviewed additive 0121 while this 0120 release stays live
  // during the MHP cutover. A release bundling 0121 takes the strict path.
  if (migrations.length === 120
      && migrations[119]?.filename === '0120_mhp_deal_desk_credit.sql'
      && applied.get(MHP_GROWTH_COMPATIBILITY_MIGRATION) === MHP_GROWTH_COMPATIBILITY_CHECKSUM) {
    applied.delete(MHP_GROWTH_COMPATIBILITY_MIGRATION);
  }
  // Keep the 0121 release ready during the additive 0122 SMS verification
  // cutover. This admits only the exact reviewed file checksum. A release
  // bundling 0122 returns to strict migration matching automatically.
  if (migrations.length === 121
      && migrations[120]?.filename === '0121_mhp_prospects_learning.sql'
      && applied.get(SMS_PHONE_COMPATIBILITY_MIGRATION) === SMS_PHONE_COMPATIBILITY_CHECKSUM) {
    applied.delete(SMS_PHONE_COMPATIBILITY_MIGRATION);
  }
  // The base123 bridge can remain live/recover after only this reviewed124.
  // The final application bundles124 and therefore takes the strict path.
  // Require the exact123 tail in both source and database; the older122
  // transition allowance below must not hide a gap during this cutover.
  if (migrations.length === 123
      && migrations[122]?.filename === SMS_TRIGGER_ACL_REPAIR_MIGRATION
      && migrations[122]?.checksum === SMS_TRIGGER_ACL_REPAIR_CHECKSUM
      && applied.get(SMS_TRIGGER_ACL_REPAIR_MIGRATION) === SMS_TRIGGER_ACL_REPAIR_CHECKSUM
      && applied.get(MHP_MARKETING_COMPATIBILITY_MIGRATION) === MHP_MARKETING_COMPATIBILITY_CHECKSUM) {
    applied.delete(MHP_MARKETING_COMPATIBILITY_MIGRATION);
  }
  // The124 application remains ready during this exact read-only125 cutover.
  // Source and ledger must both include exact124. Bundled125 is strict.
  if (migrations.length === 124
      && migrations[123]?.filename === MHP_MARKETING_COMPATIBILITY_MIGRATION
      && migrations[123]?.checksum === MHP_MARKETING_COMPATIBILITY_CHECKSUM
      && applied.get(MHP_MARKETING_COMPATIBILITY_MIGRATION) === MHP_MARKETING_COMPATIBILITY_CHECKSUM
      && applied.get(MHP_WEBINAR_READER_MIGRATION) === MHP_WEBINAR_READER_CHECKSUM) {
    applied.delete(MHP_WEBINAR_READER_MIGRATION);
  }
  // The125 bridge supports only this reviewed additive126. Its SQL installs
  // complete v1 owner-row exclusions before capable code can enqueue owner
  // mail. Bundled126 uses strict matching and never takes this allowance.
  if (migrations.length === 125
      && migrations[124]?.filename === MHP_WEBINAR_READER_MIGRATION
      && migrations[124]?.checksum === MHP_WEBINAR_READER_CHECKSUM
      && applied.get(MHP_WEBINAR_READER_MIGRATION) === MHP_WEBINAR_READER_CHECKSUM
      && applied.get(MHP_OWNER_EMAIL_MIGRATION) === MHP_OWNER_EMAIL_CHECKSUM) {
    applied.delete(MHP_OWNER_EMAIL_MIGRATION);
  }
  // The126 recovery bridge supports only this reviewed additive127. Its SQL
  // excludes sequence rows from every old owner claim/maintenance/standalone
  // boundary before any capable code can enrol them. Bundled127 stays strict.
  if (migrations.length === 126
      && migrations[125]?.filename === MHP_OWNER_EMAIL_MIGRATION
      && migrations[125]?.checksum === MHP_OWNER_EMAIL_CHECKSUM
      && applied.get(MHP_OWNER_EMAIL_MIGRATION) === MHP_OWNER_EMAIL_CHECKSUM
      && applied.get(MHP_FOLLOWUP_SEQUENCE_MIGRATION) === MHP_FOLLOWUP_SEQUENCE_CHECKSUM) {
    applied.delete(MHP_FOLLOWUP_SEQUENCE_MIGRATION);
  }
  // Exact127 recovery artifact also carries the reviewed v2 reader/service
  // guards. SQL excludes automatic runs from its old claim/prepare paths.
  // Bundled128 remains strict and never takes this bridge allowance.
  if (migrations.length === 127
      && migrations[126]?.filename === MHP_FOLLOWUP_SEQUENCE_MIGRATION
      && migrations[126]?.checksum === MHP_FOLLOWUP_SEQUENCE_CHECKSUM
      && applied.get(MHP_FOLLOWUP_SEQUENCE_MIGRATION) === MHP_FOLLOWUP_SEQUENCE_CHECKSUM
      && applied.get(MHP_CAPTURE_ENTRY_MIGRATION) === MHP_CAPTURE_ENTRY_CHECKSUM) {
    applied.delete(MHP_CAPTURE_ENTRY_MIGRATION);
  }
  // The exact128 recovery reader keeps existing canonical v1/v2 history.
  // Reviewed129 only extends structural draft references; executable gates
  // still reject all non-email. Bundled129 uses the strict path.
  if (migrations.length === 128
      && migrations[127]?.filename === MHP_CAPTURE_ENTRY_MIGRATION
      && migrations[127]?.checksum === MHP_CAPTURE_ENTRY_CHECKSUM
      && applied.get(MHP_CAPTURE_ENTRY_MIGRATION) === MHP_CAPTURE_ENTRY_CHECKSUM
      && applied.get(MHP_LOCAL_CHANNEL_DRAFTS_MIGRATION) === MHP_LOCAL_CHANNEL_DRAFTS_CHECKSUM) {
    applied.delete(MHP_LOCAL_CHANNEL_DRAFTS_MIGRATION);
  }
  // Keep the exact129 application ready while only reviewed0130 is added.
  // Bundled130 uses strict validation; all prior and unknown rows remain checked.
  if (migrations.length === 129
      && migrations[128]?.filename === MHP_LOCAL_CHANNEL_DRAFTS_MIGRATION
      && migrations[128]?.checksum === MHP_LOCAL_CHANNEL_DRAFTS_CHECKSUM
      && applied.get(MHP_LOCAL_CHANNEL_DRAFTS_MIGRATION) === MHP_LOCAL_CHANNEL_DRAFTS_CHECKSUM
      && applied.get(MHP_OWNED_SMS_MIGRATION) === MHP_OWNED_SMS_CHECKSUM) {
    applied.delete(MHP_OWNED_SMS_MIGRATION);
  }
  // The exact130 recovery runtime stays ready through this reviewed additive131.
  // A release bundling131 takes the strict path. Source and database must both
  // retain the exact130 tail; unknown, missing and changed earlier rows fail.
  if (migrations.length === 130
      && migrations[129]?.filename === MHP_OWNED_SMS_MIGRATION
      && migrations[129]?.checksum === MHP_OWNED_SMS_CHECKSUM
      && applied.get(MHP_OWNED_SMS_MIGRATION) === MHP_OWNED_SMS_CHECKSUM
      && applied.get(SEO_BLOG_MIGRATION) === SEO_BLOG_CHECKSUM) {
    applied.delete(SEO_BLOG_MIGRATION);
  }
  // The131 recovery artifact may also admit only this exact consecutive132+133
  // pair. It never bundles either migration; final133 runtimes stay strict.
  if (migrations.length === 131
      && migrations[130]?.filename === SEO_BLOG_MIGRATION
      && migrations[130]?.checksum === SEO_BLOG_CHECKSUM
      && applied.get(SEO_BLOG_MIGRATION) === SEO_BLOG_CHECKSUM
      && applied.get(SEO_BLOG_SOCIAL_MIGRATION) === SEO_BLOG_SOCIAL_CHECKSUM
      && applied.get(SEO_BLOG_SOCIAL_DISPATCH_MIGRATION) === SEO_BLOG_SOCIAL_DISPATCH_CHECKSUM) {
    applied.delete(SEO_BLOG_SOCIAL_DISPATCH_MIGRATION);
  }
  // The exact131 recovery runtime stays ready through this reviewed additive132
  // (SEO blog social promotion). A release bundling132 takes the strict path.
  // Source and database must both retain the exact131 tail; unknown, missing
  // and changed earlier rows fail.
  if (migrations.length === 131
      && migrations[130]?.filename === SEO_BLOG_MIGRATION
      && migrations[130]?.checksum === SEO_BLOG_CHECKSUM
      && applied.get(SEO_BLOG_MIGRATION) === SEO_BLOG_CHECKSUM
      && applied.get(SEO_BLOG_SOCIAL_MIGRATION) === SEO_BLOG_SOCIAL_CHECKSUM) {
    applied.delete(SEO_BLOG_SOCIAL_MIGRATION);
  }
  validateAppliedState(migrations, applied);
  const pending = migrations.filter((migration) => !applied.has(migration.filename));
  // 0123 only revokes an unintended PUBLIC execute grant on an internal SMS
  // receipt trigger. The production ACL was repaired before this source was
  // published; allow that exact 0122 ledger during the additive cutover.
  // Existing portal and provider-specific readiness gates still enforce the
  // closed role boundary before any customer journey is mounted.
  if (pending.length === 1
      && migrations.length === 123
      && pending[0]?.filename === SMS_TRIGGER_ACL_REPAIR_MIGRATION
      && pending[0]?.checksum === SMS_TRIGGER_ACL_REPAIR_CHECKSUM
      && applied.get(SMS_PHONE_COMPATIBILITY_MIGRATION) === SMS_PHONE_COMPATIBILITY_CHECKSUM) {
    return;
  }
  if (pending.length > 0) {
    throw new Error(`Database schema is behind by ${pending.length} migration(s); first pending: ${pending[0]!.filename}`);
  }
}
