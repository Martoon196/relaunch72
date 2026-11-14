/**
 * 0154 migration identity: Martin Howard Property's content tools (SEO blog, Brand DNA, approvals) attach to its
 * EXISTING brand workspace instead of a new one. Additive on 0001-0153: two new definer functions owned by r72_owner and
 * executable only by r72_content_command (app_private.seo_blog_attach_workspace_offer and
 * app_private.seo_blog_attach_workspace), pinned to the MHP workspace and organisation. Nothing is altered or rewritten.
 *
 * Compatibility, exactly: code built with this file runs unchanged on a database that still ends at 0153 (the offer
 * function is missing, so the "Use Martin Howard Property here" card is simply not shown). Processes of an OLDER build
 * (34143f8 and before) that are already running keep working against the 0154 schema (nothing they call changed), but
 * an older build REFUSES TO BOOT on a database that contains 0154: its readiness gate and migration runner reject a
 * migration they do not know. So deploy this build everywhere before applying 0154, and after 0154 roll back only to a
 * build that contains this gate. If another branch lands first, rename the .sql file, update the filename here, re-pin
 * the checksum and re-run the migration contract and readiness tests.
 */
export const SEO_BLOG_ATTACH_MIGRATION = '0154_seo_blog_attach_mhp_workspace.sql';
export const SEO_BLOG_ATTACH_CHECKSUM = '8177c00ffe3e345ae74fd15a3da584c8ae9f1fe165cf1ea00909e74d37eec38d';
