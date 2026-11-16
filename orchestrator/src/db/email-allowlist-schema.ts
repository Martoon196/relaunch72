/**
 * 0157 migration identity: "Connect email" stage 2, the founder's database allow-list. On 0001-0156: two new private
 * tables (app_private.email_connect_allowlist, seeded with Property Predator under the name the code already uses, and
 * the append-only app_private.email_connect_allowlist_events), a NOLOGIN r72_email_allowlist_definer with its definer
 * functions (executable by r72_identity_command only), five r72_owner helpers, and on 0155/0156's own tables: the six
 * Property Predator workspace CHECKs dropped and replaced by one insert guard trigger each (a business on the active
 * allow-list, or one with a connection row for its own records), the six pinned definer policies reduced to their
 * session-user rule, and four functions replaced (the owner rule and the owner check read the allow-list,
 * email_send_reserve and the founder's approve answer 'not_allowed' for a switched-off business). Property Predator's
 * answers are unchanged.
 *
 * Compatibility, exactly: code built with this file runs unchanged on a database that still ends at 0156 (the
 * allow-list read is missing, so Connect email is exactly the static Property Predator list with its old messages,
 * and one informational line says so; nothing errors). Processes of the previous build (3f2fffa and before) that are
 * already running keep serving requests after 0157 is applied (every function they call answers Property Predator
 * exactly as before), but that build's readiness check fails on a database containing 0157 and it will not boot there.
 * So the order is: this build on every service and worker first, then apply 0157; after that there is no rollback to
 * a build without this gate. If another branch lands first, rename the .sql file, update the filename here, re-pin the
 * checksum and re-run the migration contract and readiness tests.
 */
export const EMAIL_ALLOWLIST_MIGRATION = '0157_email_connect_allowlist.sql';
export const EMAIL_ALLOWLIST_CHECKSUM = '0368379c6aec57dc413b3857aabecbaeea07175be694e11b53ca9134b6eebbca';
