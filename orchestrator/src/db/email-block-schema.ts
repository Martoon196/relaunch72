/**
 * 0153 migration identity: a STOP applies only to its own channel (the owner one-to-one WhatsApp origin check reads
 * WhatsApp suppressions only), and the durable email block ledger (app_private.email_address_blocks) with Property
 * Predator's true-reason CRM stop and the owner's undo for a wrong hard bounce. Additive on 0001-0152: one function
 * replaced with the same signature, one worker read policy narrowed, two new private tables (the block ledger and its append-only owner-lift audit), a NOLOGIN
 * r72_email_block_definer and its definer functions, and two new PP definer functions.
 *
 * Compatibility, exactly: code built with this file falls back to the in-process block list while the database still
 * ends at 0152. Processes of an OLDER build (702dd61 and before) that are already running keep working against the
 * 0153 schema (nothing they call was removed or changed in signature), but an older build REFUSES TO BOOT on a
 * database that contains 0153: its readiness gate and migration runner reject a migration they do not know. So deploy
 * this build everywhere before applying 0153, and after 0153 roll back only to a build that contains this gate.
 * If another branch lands first, rename the .sql file, update the filename here, re-pin the checksum and re-run the
 * migration contract and readiness tests.
 */
export const EMAIL_BLOCK_MIGRATION = '0153_stop_per_channel_and_email_block_ledger.sql';
export const EMAIL_BLOCK_CHECKSUM = '9c304186cc5a601518c8411118b94a5084245501388d9d4769332306a89fc130';
