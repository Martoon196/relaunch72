/**
 * 0160 migration identity: who a follow-up sequence is for, enforced by the database, and the Before You Buy "book
 * readers" audience (explicit-recipient start, run-id resume, the automatic book sign-up switch and the purchase stop).
 *
 * Compatibility, exactly: code built with this file runs correctly on a database still at 0159. The 0160 functions are
 * absent there; the repository treats "function does not exist" as "not yet" and the owner sees "This will be ready after
 * one database step" for book readers, while webinar sequences keep the safety release's path. After 0160 is applied the
 * same code uses the explicit list for every start. Processes of the previous build keep serving after 0160 is applied
 * (every 0128 function keeps its name and signature; the old one-press 'enrol' is refused by the database, as intended),
 * but that build's readiness check fails on a database containing 0160 and it will not boot there. So the order is: this
 * build on every service and worker first, then apply 0160. If another branch lands first, rename the .sql file, update
 * the filename here, re-pin the checksum and re-run the migration contract and readiness tests.
 */
export const MHP_BOOK_READERS_MIGRATION = '0160_mhp_book_readers_audience.sql';
export const MHP_BOOK_READERS_CHECKSUM = '5ca18d80d089c27307f9d44aea2ccad91f99f549d6bf42a6249142a34697b405';
