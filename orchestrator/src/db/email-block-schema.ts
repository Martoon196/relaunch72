/**
 * 0153 migration identity: a STOP applies only to its own channel (the owner one-to-one WhatsApp origin check reads
 * WhatsApp suppressions only), and the durable email block ledger (app_private.email_address_blocks) with Property
 * Predator's true-reason CRM stop. Additive on 0001-0152: one function replaced with the same signature, one worker
 * read policy narrowed, one new private table, a NOLOGIN r72_email_block_definer and its definer functions, and one
 * new PP definer function. Code built before 0153 keeps working once it is applied; code built with it falls back to
 * the in-process block list while the database still ends at 0152. If another branch lands first, rename the .sql
 * file, update the filename here, re-pin the checksum and re-run the migration contract and readiness tests.
 */
export const EMAIL_BLOCK_MIGRATION = '0153_stop_per_channel_and_email_block_ledger.sql';
export const EMAIL_BLOCK_CHECKSUM = 'fe1bdb06fff898da1f5fb9cbab755613d64238502d40c813334c4ad645ddc19a';
