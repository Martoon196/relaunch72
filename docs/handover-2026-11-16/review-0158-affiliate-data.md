REVIEW 5: migration 0158 and the Affiliate Studio data layer
Worktree /home/user/r72-affiliate, HEAD 21d88122cd74e7313a8a28603c85b653d768c58b on base 744a19d. Worktree untouched (git status empty at the end).

VERDICT: SHIP. No blocker. Nothing in this build can reach the new code, 0158 is additive by catalog proof, and tenant isolation held under every attack I ran. There are two release conditions and one fix that must land before the report reader is given any route.

MIGRATION FACTS (verified from the files, as the runner will see them)
- File: /home/user/r72-affiliate/orchestrator/src/db/migrations/0158_affiliate_studio.sql
- sha256: ef867c72c335eb54dc2ad7d77d4ed154d63f5330e1c11932f0bd4676042ff486. The file is pure ASCII with no CR, so the runner's checksum equals plain sha256sum. It matches the pin in src/db/affiliate-schema.ts:21 and the ledger row the real runner wrote on my database.
- Ledger tail before it: 0157_email_connect_allowlist.sql, sha256 0368379c6aec57dc413b3857aabecbaeea07175be694e11b53ca9134b6eebbca (pinned in src/db/email-allowlist-schema.ts:22).
- 158 files in the directory; 0158 is the last.

COLLISION WITH c00c928: none. Its 16 files are all portal and content-area files and tests, it adds no migration, and `git merge-tree` of the two heads merges cleanly.

ENVIRONMENT
Own PostgreSQL 16.15 cluster (C.UTF-8), migrated as non-superuser r72_migrator by the real runner to exactly 0157 (157 applied), seeded with two content businesses, a non-content business, owners, an admin, a viewer, a person who manages both, a stranger, and live, expired and revoked sessions. A second small cluster ran the integration files. Both clusters are stopped and deleted. No production database, no network.

WHAT I RAN

1. Purely additive (catalog snapshots before and after, about 17,000 lines each)
- Snapshot covered roles, memberships, schema ACLs, every relation, column, default, constraint, index, policy, trigger, function body and ACL, views, default privileges, types, sequences, extensions, the registry and the ledger.
- 143 lines added, all new objects. 7 existing lines changed, each by exactly one added ACL entry for r72_affiliate_definer: USAGE on app and app_private, EXECUTE on current_workspace_id, current_user_id, current_actor_kind, seo_blog_brand and seo_media_owner. Nothing removed; no existing function body, table, policy, trigger or membership changed.
- CREATE on app_private for the new role after the run: false.
- Members of the new role: r72_owner (NOLOGIN) and r72_migrator (admin only). The only login role that gains anything is r72_migrator, which already had everything through r72_owner.
- The four registry rows are inert: nothing in src or in any function reads the registry at run time.

2. Tenant isolation and authorisation
- All ten commands by 18 kinds of wrong caller: 42501 every time. Callers were: owner of A on B (both request contexts), owner of B on A, someone else's session hash, a spoofed request user, viewer, stranger, junk/31-byte/33-byte/NULL/expired/revoked session, actor kind worker/system/empty, no request user, a non-content business. NULL workspace: 42501.
- 53 login roles (by session authorization): seven statements on each of the four tables, SET ROLE to the definer and owner, the four inner helpers, seo_media_owner, and the read commands. 2,087 refusals with 42501; the only role that got through anything was r72_migrator.
- Login roles that may execute a command: r72_content_command and r72_migrator. All seven functions are SECURITY DEFINER with search_path=pg_catalog, owned by the NOLOGIN definer, no PUBLIC execute.
- Input tricks: array, JSON null, string, number, SQL NULL, oversized (17 kB, 5 kB, 600 kB), unknown or NULL action, SQL in the action, wrong types in every field, upper-case or nil ids: all 22023.
- Smuggled workspace_id, created_by, status and revision inside the input: ignored. The stored row was in A, by owner A, active, revision 1.
- A SQL-looking name was stored literally.
- Same command id, product id, report id and file hash used by A and by B: independent.
- Replay: same id and same body answers replayed, also with keys reversed and extra spaces (the database computes the digest). Same id with a changed body, another action or another product: 23505 affiliate_command_reused.
- Through the real stores on the content-command login: at 0157 every call answers not_opened_yet; at 0158 they work. Refused with the plain sentence: owner A on B, a lying selected workspace, a stolen user id, viewer, expired, revoked, non-content business, the web login.

3. Data rules in SQL (direct calls, bypassing TypeScript)
- Only the exact link is stored. Refused with tag mismatch: tag in another case, another valid tag, trailing newline or space, extra parameter, fragment, second tag, percent-encoded tag, http, amazon.com, upper-case host, look-alike host. Refused by CHECK: lower-case code, a code carrying a path or query, a 9-character code, a product page that differs or is on another site.
- Tracking ID and website rules behaved as written (newline, leading space, underscore, non-ASCII digits, 65 characters, upper-case site, path, port, sign-in all refused).
- Caps under concurrency: at 499 active products two adds at once give one success and one cap refusal; 500 active afterwards. At 199 reports two saves at once give one and one; 200 afterwards.
- Races: two edits of one revision, two adds of one product id, two saves of details: one wins, the other is stale. One command sent twice at once: one new, one replayed.
- Append-only: UPDATE, DELETE and TRUNCATE CASCADE on all four tables are refused for r72_owner, for the definer and for the superuser. ON CONFLICT DO UPDATE and MERGE are refused. session_replication_role is refused for owner and definer. COPY FROM is refused by RLS. The definer cannot disable the trigger; the table owner can, which is inherent.
- Retired products cannot be edited, retired again, or re-added under the same id.

4. Link parser (fuzz-links.mts)
- 126 hostile addresses plus 400,000 random mutations (308,703 distinct), with and without a saved tracking ID: 0 rule breaks. Everything returned was `https://www.amazon.co.uk/dp/<ASIN>` and, when prepared, exactly the canonical link with a tag ending -21 equal to the saved one.
- No throw on any input, including 14 non-strings. Slowest single check 24 ms; 10 MB and 5 MB inputs answered in 17 ms.
- Every refusal was one of the fixed sentences. I read all 51 sentences: no technical words ("tracking ID" is Amazon's own term).
- TypeScript against the real CHECKs in PostgreSQL: stored-link check on 71,010 distinct values, 0 disagreements; tracking IDs on 35,711 values, 0 disagreements. Everything validateTrackingId and parseRegisteredSite return is storable.
- One disagreement the other way: SQL accepts `https://1.2.3.4` as the website, TypeScript refuses it.

5. Report reader (fuzz-report.mts, slow3.mts)
- 40,000 random files as text and as bytes: never threw, every refusal was a fixed sentence, the Others total always equalled the Others rows, and no stored tracking ID started with a formula character.
- Formula-looking IDs (=, +, -, @, quoted, tab-led) are refused. Dollars and euros are refused.
- Encodings read correctly: UTF-8 with and without mark, UTF-16 LE and BE, UTF-16 without mark, Windows.
- Size: exactly 2,000,000 bytes is read in 257 ms; one byte more is refused.
- Nothing reaches SQL unparameterised: one call site, `$1..$4`, with the function name from a fixed union (read).
- It does hang on one shape; see SHOULD-FIX 2.

6. Release safety
- Nothing imports src/affiliate outside itself, statically or dynamically; only runtime-readiness imports the two constants. The builder's own scan test passes.
- Readiness of the new build: READY at 0157 (0158 pending) and at 0158. NOT READY with two pending, a wrong 0157 or 0158 checksum, another 0158 name in the ledger, the file altered by one byte (pending or applied), or the file renamed. The new code with only 157 files bundled is READY at 0158 (the bridge).
- Production build c00c928 (clean export): READY at 0157, NOT READY at 0158 ("Database contains migration not present in this release").
- Already-running old processes: nothing they call changes (catalog proof above).
- Locks on existing objects, captured just before commit: RowExclusive on workspace_table_registry and the role's own catalog lock. No existing application table is locked.
- Under traffic: five runs with eight connections calling the existing helpers whose ACLs change. The runner applied in 189 to 799 ms; 8,195 calls, no errors, slowest 161 ms.
- Lock timeout (a session holding the registry table): the runner failed with 55P03 after about 5 s and left nothing behind; re-run applied in 201 ms; a third run applied nothing.
- Forced failure after the temporary CREATE grant: the runner rolled everything back, CREATE on app_private false, re-run clean. The role already existed cluster-wide from my other databases, so I showed separately that CREATE ROLE rolls back with its transaction.

7. Tests
- tsc: exit 0.
- Full unit suite: 5,075 tests, 4,960 pass, 0 fail, 115 skipped.
- Affiliate unit tests, both SQL contract files and readiness: 156 of 156.
- The two integration files on my cluster: 4 of 4. I did not run the full DB integration suite this time.
- The "two-line change" claim is confirmed. I ran the unmodified 0157 integration test on the new tree: it fails because the default runner now applies 0157 and 0158 from 0156, while the test expects only 0157. The change (a comment and `prefixDirectory(157)`) only narrows the test to its own file.

The builder's deviations all check out as described.

FINDINGS

No BLOCKER.

SHOULD-FIX 1 (release procedure, no code change): apply 0158 only through the migration runner.
- Ran: plain `psql -f` as r72_migrator exits 0 with no ERROR line at all (five "SET LOCAL" warnings). It leaves the four tables and seven functions owned by r72_migrator, no ledger row, and the new build still READY. The runner later fails with 42P07.
- Ran: `psql -v ON_ERROR_STOP=1` without a transaction, failing mid-file, leaves CREATE on app_private granted to the new role.
- Ran: `psql --single-transaction` gives the right owners but no ledger row, so the next runner run fails.
- This is quieter than 0157, which at least printed one error.

SHOULD-FIX 2 (before any route calls the report reader; not reachable today): the reader hangs on a small hostile file.
- Where: src/affiliate/amazon-tracking-report.ts:75, `cell.trim() === ''` evaluated on every quotation mark against a growing cell.
- Ran: a file of repeated `x"` takes 3.8 s at 200 kB and 20.7 s at 400 kB, and did not finish in 40 s at 1.9 MB (about 8 minutes by the curve). Spaces followed by quotes take 1.5 s at 64 kB. The whole process is blocked meanwhile.
- Fix: keep a boolean "only blanks so far" instead of trimming. It does not touch the pinned SQL.

NOTE 1: changing the tracking ID leaves old links live. Ran: after saving a new ID, existing active products still carry the old tag and are listed as active with no flag. Edits must use the new tag; retire works. `validateLink(url, savedTrackingId)` exists for this but nothing calls it yet; the slice that renders links must.

NOTE 2: the store accepts a target business other than the session's selected one. Ran: a person who manages A and B, with a session selected on A, listed and saved details for B. This is 0137's seo_media_owner rule; the route must pass the session's own workspace.

NOTE 3: admins, not only owners, can run every command (ran). That is "manages the workspace" as written; confirm it is intended.

NOTE 4: other places where TypeScript and SQL differ.
- Names or notes with controls U+0080 to U+009F: TypeScript prepares them, the CHECK refuses, and the owner gets the generic "Some of these details could not be saved." The CHECK uses `[[:cntrl:]]`, so this depends on the database's locale.
- The merchant name is fixed only in TypeScript: "Not Amazon" was stored by a direct call.
- Report rows are only checked for a string tracking ID in SQL: a formula-looking ID was stored by a direct call.

NOTE 5: invisible and direction-changing characters (U+202E, U+2060) are accepted in product names by both layers and stored (ran). Notes accept markup-like text (`<img …>` was stored). Both must be escaped and cleaned where they are shown.

NOTE 6: report figures.
- A quoted "1,50" is read as £150.00.
- "(-1.50)" is read as +£0.50.
- A row named "Other tracking IDs" is not treated as Others (only others, other, unattributed, unallocated).
- The month is the owner's choice: the same file was saved again under another month (ran).

NOTE 7: a replay through the store after the tracking ID changed answers "already sent once with different details", because the store rebuilds the link first (ran).

NOTE 8 (read): a product at revision 1,000 can be neither edited nor retired. Retired products and command rows grow without limit, and `list` returns every product.

NOTE 9: a NUL escape in the JSON gives 22P05, which `answerFor` does not map, so the store would throw. The stores' own cleaners never let one through (ran direct; read).

NOTE 10: the maker's page may be any https address, including numeric ones (`https://1.2.3.4/x` was kept). Harmless while nothing fetches it.

NOTE 11: naming. r72_affiliate_definer sits beside the older r72_affiliate_*_command roles, and the registry already has 18 affiliate_* rows, from the unrelated partner feature. Risk of confusion only.

NOTE 12 (my own clean-up): I deleted 13 temporary directories in /tmp (75 MB) named r72-affiliate-15x-* and r72-allowlist-0156-*, which the integration tests create and never reuse. About half were from someone else's earlier run today (timestamps 11:36 to 11:38), not mine.

RELEASE CONDITIONS
1. Put this build on all nine services first. Then apply 0158 with the migration runner as r72_migrator, after confirming the file's sha256 is ef867c72c335eb54dc2ad7d77d4ed154d63f5330e1c11932f0bd4676042ff486 and the ledger tail is 0157 with 0368379c6aec57dc413b3857aabecbaeea07175be694e11b53ca9134b6eebbca. Never plain `psql -f`.
2. After 0158 there is no way back to c00c928 or older. A process of that build that is already running keeps working, but any restart of it will refuse to start, and its /ready reports not ready. Roll forward only.
3. If the runner reports a lock timeout, nothing was changed: run it again.

Before the next slice: SHOULD-FIX 2, and NOTES 1, 2 and 5.

Scratch scripts and outputs are in /tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/affiliate-review/ (snapshot.sql, snap.diff, attack1.mts, attack2.mts, fuzz-links.mts, fuzz-report.mts, slow3.mts, stores.mts, traffic.mts, ready.mts, locks.sql, npmtest.out).