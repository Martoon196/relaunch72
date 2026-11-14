/**
 * 0155 migration identity: "Connect email". Additive on 0001-0154: three new private tables (app_private.email_connections,
 * pinned to the Property Predator workspace, and the append-only app_private.email_connection_events and
 * app_private.email_protection_events), a NOLOGIN r72_email_connection_definer with its definer functions (executable
 * by r72_identity_command only), and two r72_owner helpers (the owner rule and the agreeing user's name) executable by
 * that definer only. Nothing is altered, rewritten or triggered.
 *
 * Compatibility, exactly: code built with this file runs unchanged on a database that still ends at 0154 (the
 * functions are missing, so "Connect email" says it isn't switched on and no stored bounce source is loaded; nothing
 * errors). Processes of the previous build (b9199bb and before) that are already running keep serving requests after
 * 0155 is applied (nothing they call changed), but that build's readiness check fails on a database containing 0155
 * and it will not boot there. So the order is: this build on every service and worker first, then apply 0155; after
 * that there is no rollback to a build without this gate. If another branch lands first, rename the .sql file, update
 * the filename here, re-pin the checksum and re-run the migration contract and readiness tests.
 */
export const EMAIL_CONNECTION_MIGRATION = '0155_email_connections.sql';
export const EMAIL_CONNECTION_CHECKSUM = 'dc1f9e115fb2b7c5e90cf89d79734f27a163dac16a526b3454dc9d7451dc3568';
