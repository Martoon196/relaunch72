/**
 * 0156 migration identity: "Connect email" release 2, sending through the stored connection and sender protection.
 * Additive on 0001-0155: five new private tables (app_private.email_sending_controls, email_send_events,
 * email_protection_alerts, email_account_protection, email_account_events; workspace tables pinned to the Property
 * Predator workspace), new definer functions owned by the existing NOLOGIN r72_email_connection_definer (executable by
 * r72_identity_command only), one function owned by 0152's r72_pp_followup_definer (pp_followup_hold_wait: held
 * follow-up runs wait instead of expiring), three r72_owner helpers executable by that definer only, and UPDATE granted
 * on the groundwork columns of 0155's app_private.email_connections. Nothing is altered, rewritten or triggered.
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
export const EMAIL_PROTECTION_CHECKSUM = 'e5f6c14b235d92974f3bc9eb9c781f915a470fce8f6dcf5722b29151bb65745b';
