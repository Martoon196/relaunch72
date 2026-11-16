/**
 * 0158 migration identity: Affiliate Studio, slice 1, the data layer. On 0001-0157, purely additive: four new tables in
 * schema app (app.affiliate_products, app.affiliate_product_commands, app.affiliate_programme_settings,
 * app.affiliate_report_imports; forced RLS, append-only, no foreign key to any existing table), a NOLOGIN
 * r72_affiliate_definer that owns three definer functions (app_private.affiliate_product_command,
 * affiliate_programme_command, affiliate_report_command; executable by r72_content_command only, each checking the
 * owner's portal session and that they manage the business with 0137's seo_media_owner) and four inner helpers granted
 * to nobody. Existing objects touched: four app_private.workspace_table_registry rows, and grants to the new role
 * (USAGE on app and app_private, EXECUTE on five existing helpers, CREATE on app_private revoked again in the file).
 * No existing table is altered, locked, referenced or given a trigger or policy; no existing function is replaced.
 *
 * Compatibility, exactly: code built with this file runs unchanged on a database that still ends at 0157 (nothing
 * calls the new functions yet; the stores answer "not opened yet" when they are missing). Processes of the previous
 * build (744a19d and before) that are already running keep serving requests after 0158 is applied (nothing they call
 * changes), but that build's readiness check fails on a database containing 0158 and it will not boot there. So the
 * order is: this build on every service and worker first, then apply 0158; after that there is no rollback to a build
 * without this gate. If another branch lands first, rename the .sql file, update the filename here, re-pin the checksum
 * and re-run the migration contract and readiness tests.
 */
export const AFFILIATE_MIGRATION = '0158_affiliate_studio.sql';
export const AFFILIATE_CHECKSUM = 'ef867c72c335eb54dc2ad7d77d4ed154d63f5330e1c11932f0bd4676042ff486';
