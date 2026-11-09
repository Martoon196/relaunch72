/**
 * Native webinars migration identity. Kept in one place so the release owner can
 * renumber it mechanically if another branch lands the same slot first (Creative
 * Studio also reserved 0144 on an unmerged branch): rename the .sql file, update
 * WEBINARS_MIGRATION, re-pin WEBINARS_CHECKSUM and re-run the migration contract tests.
 */
export const WEBINARS_MIGRATION = '0144_native_webinars.sql';
export const WEBINARS_CHECKSUM = '291934db5265d9e6d74cd336598f8731130a2b4869819067aac87ae96de01159';
