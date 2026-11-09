/**
 * Native webinars migration identity. Kept in one place so the release owner can
 * renumber it if another branch lands first (Creative Studio owns 0144 and
 * the separately applied owner limits own 0145): rename the .sql file, update
 * WEBINARS_MIGRATION, re-pin WEBINARS_CHECKSUM and re-run the migration contract tests.
 */
export const WEBINARS_MIGRATION = '0146_native_webinars.sql';
export const WEBINARS_CHECKSUM = 'dea9e16c2743b58b5901f95be06abcfc39d2237dc087b1c949478eb17357f3af';
