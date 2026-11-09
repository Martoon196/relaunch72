/**
 * Native webinars migration identity. Kept in one place so the release owner can
 * renumber it mechanically if another branch lands the same slot first (Creative
 * Studio also reserved 0144 on an unmerged branch): rename the .sql file, update
 * WEBINARS_MIGRATION, re-pin WEBINARS_CHECKSUM and re-run the migration contract tests.
 */
export const WEBINARS_MIGRATION = '0144_native_webinars.sql';
export const WEBINARS_CHECKSUM = 'dea9e16c2743b58b5901f95be06abcfc39d2237dc087b1c949478eb17357f3af';
