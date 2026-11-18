/**
 * 0159 migration identity: retire the 17 Nov 2026 hand-applied book sign-up trigger. On a database at 0158 that also has
 * the two docs/ops/mhp-book-*-20261117.sql files applied (production), it drops the trigger
 * mhp_book_contact_after_signup on app_private.mhp_prospect_signups, the SECURITY DEFINER function
 * app_private.mhp_book_contact_after_signup(), the ten mhp_book_* policies for r72_mhp_prospect_definer on app.contacts,
 * app.contact_points, app.pipelines, app.pipeline_stages, app.opportunities, app.opportunity_stage_history and app.tasks
 * (and any other policy of that prefix there for that role), and revokes exactly the grants those files added. On a
 * database at 0158 without them (fresh) every one of those statements is a no-op. It touches no row: the CRM records the trigger made
 * stay, and the application (src/mhp/book-leads-service.ts) recognises them. It keeps 0134's SELECT on app.contact_points.
 *
 * It also keeps a book sign-up's mobile durably (both starting states end identical): a nullable
 * app_private.mhp_prospect_signups.phone (never mhp_prospects.phone, which the webinar text reminders read), the
 * capture login's app_private.mhp_book_signup_keep_phone(uuid,uuid,text) and the owner read app_private.mhp_book_signups(bytea).
 * Code built with this file treats both functions as absent (skipped softly) while 0159 is pending.
 *
 * Compatibility, exactly: code built with this file runs correctly on a database that still has the trigger (0159
 * pending; the app path and the trigger take the same per-email lock and the app never adds a second book enquiry) and
 * after it. Processes of the previous build that are already running keep serving after 0159 is applied (nothing they
 * call changes), but that build's readiness check fails on a database containing 0159 and it will not boot there. So
 * the order is: this build on every service and worker first, then apply 0159; after that there is no rollback to a
 * build without this gate. If another branch lands first, rename the .sql file, update the filename here, re-pin the
 * checksum and re-run the migration contract and readiness tests.
 */
export const MHP_BOOK_CRM_MIGRATION = '0159_mhp_book_crm.sql';
export const MHP_BOOK_CRM_CHECKSUM = '76fd4a6c894c6868ac65e14bdc466d8cbab20479177586b86bb9c994760a8607';
