/**
 * 0156 migration identity: "Connect email" release 2, sending through the stored connection and sender protection.
 * Additive on 0001-0155: six new private tables (app_private.email_sending_controls, email_send_events,
 * email_protection_alerts, email_account_protection, email_account_events; workspace tables pinned to the Property
 * Predator workspace), new definer functions owned by the existing NOLOGIN r72_email_connection_definer (executable by
 * r72_identity_command only), three r72_owner helpers executable by that definer only, and UPDATE granted on the
 * groundwork columns of 0155's app_private.email_connections. Nothing is altered, rewritten or triggered.
 *
 * Compatibility, exactly: code built with this file runs unchanged on a database that still ends at 0155 (the functions
 * are missing, so sending is exactly as before, nothing is counted and the sending controls are not offered; nothing
 * errors). Processes of the previous build (1a9e516 and before) that are already running keep serving requests after
 * 0156 is applied (nothing they call changed), but that build's readiness check fails on a database containing 0156
 * and it will not boot there. So the order is: this build on every service and worker first, then apply 0156; after
 * that there is no rollback to a build without this gate. If another branch lands first, rename the .sql file, update
 * the filename here, re-pin the checksum and re-run the migration contract and readiness tests.
 */
export const EMAIL_PROTECTION_MIGRATION = '0156_email_sending_protection.sql';
export const EMAIL_PROTECTION_CHECKSUM = '2c9075abc9d2853495f92d0fdf49fab9c61e86a5f70930cf8cc3a39e89ce2a2d';
