# Fourth audit: native video/media suite at a586e48 (PR #108)

## Verdict
**(a) Are R1–R12 genuinely repaired? No. Six are fixed and six are only partly fixed.**
- Fixed: R1, R2 (for the queue starvation it targeted), R3, R6, R7, R8.
- Partly fixed: R4, R5, R9, R10, R11, R12.
- The R2 repair introduced a new defect. **The owner's video-source list now fails for every workspace.** The list function reads the new retries table, which its owning role has no right to read. No test calls the list, so nothing caught it.

**(b) Is this head safe to begin staged integration behind off switches? Yes.**
- The only pre-existing file this branch changes, compared with the foundation, is `.env.example`.
- No pre-existing file imports any of the new modules, and all 158 production migration files have identical blob ids.
- `package.json` and the lockfile are unchanged.
- It merges cleanly onto the current production foundation, cda1d9dc, and typecheck passes on both head and the merged tree.
- None of the findings below makes a dark, unmounted merge unsafe.

**(c) What still blocks real customer use:**
1. Fix the source-list permission defect before the sources screen is mounted.
2. A video of exactly five minutes (allowed by the editor and the SQL) cannot be saved after rendering. The output table rejects anything over 300,000 ms, and real outputs run about 23 ms long per clip. The job then sits as "reconciliation required" and re-renders until it fails.
3. A transient problem during the first check of an upload (ffprobe missing, or the check killed) is stored as a permanent "Could not read this video".
4. If the worker is killed with `kill -9`, ffmpeg keeps running as an orphan. The temporary folder is left behind holding a full copy of the source and the caption text, and nothing ever sweeps it.
5. Erasure does not reach the copies made at hand-off (title and post caption) or that temporary folder. It also only takes effect when the worker service is running.
6. Owner wording still has dead ends and internal terms (listed under R4).
7. The three open owner decisions from audit 3 still stand: worker size, storage, and retention.

## MUST-FIX
These do not block the dark merge. Each one blocks switching on the part named.

**M1. The owner's source list always fails (blocks the sources screen, B1).**
- Where: `migration-drafts/source-videos.sql:64`. The new `'retry_pending'` branch reads `app.creative_media_probe_retries`. `media-worker-dispatch.sql:7-10` grants that table only to `r72_owner` and `r72_native_video_definer`. The list function runs as `r72_creative_studio_definer`.
- What I ran: `PgCreativeVideoSources.list` as the real `r72_content_command` login on three databases built three ways (applying drafts by hand in the documented order, the repo's own migration runner, and the CI-equivalent path). Every call returned 403 "Video owner or selected workspace was not verified". The Postgres log shows "permission denied for table creative_media_probe_retries".
- Before and after: at 77099667 the same call returns the list.
- Smallest fix (verified): `GRANT SELECT ON app.creative_media_probe_retries TO r72_creative_studio_definer;` plus a FOR SELECT policy on that role scoped to the current workspace. With both in place the list works. Also add an integration test that calls `.list()`.

**M2. A five-minute video fails at the very end (blocks rendering, B2).**
- Where: `local-render-jobs.sql:49` requires `duration_ms BETWEEN 1000 AND 300000`. Real outputs measured 1023, 1523, 2023 and 60023 ms against plans of 1000, 1500, 2000 and 60000 ms.
- What I ran: a real three-clip 300.000 s plan on a real 301 s source, real enqueue and claim as `r72_worker`, settled through a fake renderer that reported 300,069 ms. The fake renderer was mine; the SQL was theirs. The check constraint fired.
- Effect: `media-local-render-pg-store.ts:235-236` turns any settle error except 54000 into `reconciliation_required`. The job stays claimed; after the 10-minute lease it is re-rendered, up to three times, then fails.
- Smallest fix: allow output up to 302,000 ms, or cap plans at 299 s. Map 23514 at settle to a clean `output_invalid` failure.

## SHOULD-FIX (before first real use)

**S1. A transient failure in the first upload check becomes a permanent rejection (R9 not covered here).**
- Where: `media-source-probe.ts:82` and the code that records the result.
- What I ran: with ffprobe missing, the stored result was `rejected/probe_failed`. Re-probing with a working ffprobe was refused with 409 "already probed". A thrown or killed check gave the same result.
- Fix: do not record `tool_unavailable` or `probe_failed` when the check itself failed; throw instead, so the existing retry-with-backoff applies.

**S2. A killed worker leaves an orphaned ffmpeg and private files behind.**
- Where: `media-local-render.ts:191` and `:272` (temporary folders) and the `spawn('prlimit', …)` call.
- What I ran: `kill -9` on the worker eight seconds into a 60 s render.
- What happened:
  - ffmpeg was re-parented to PID 1 and finished its work.
  - `rl72-local-render-*` remained, holding `source.mp4` (18.9 MB), `caption-0.txt` and `segment-0.mp4`. The segment file was mode 0644 inside a 0700 folder.
  - Nothing cleans these folders, and erasure cannot reach them.
- Fix: a start-up sweep of `rl72-*-render-*` folders, a dedicated temp folder on the worker, and kill the process group on shutdown.

**S3. Erasure leaves copies behind.**
- What I ran: upload with marker text, probe, edit, render, review, canonical hand-off, a second render in flight, erase, then two retention sweeps as `r72_worker`. I then searched every table in the `app`, `app_private` and `public` schemas, and the Postgres log, for the markers.
- Gone: the file name became "Deleted video"; plans became `{"erased":true}`; both stored videos became 1 byte; the in-flight job became `failed/source_changed`; a new render on the erased source was refused.
- Left: two rows in `company_content_versions` still hold the hand-off title and post caption, plus a storage key pointing at the deleted output.
- The redaction only happens inside `creative_media_retention`, which runs only when the worker service and retention switches are on. With the worker off, the file name is never redacted.
- The `outputs` list (`local-render-jobs.sql:112`) still returns erased outputs, so the screen would show a dead preview.

**S4. "Library full" reaches the owner as a raw database error.**
- Where: `media-video-source-pg-store.ts:49` maps 22023, 23514 and 22P02 but not 54000.
- What I ran: the cap-race script; the error came through as `DatabaseError 54000`, not `SeoBlogError`.
- Fix: map 54000 to 429 with the existing plain message.

**S5. Owner wording (R4 leftovers).** I read and rendered these screens.
- When retries run out, the screen still says "Video processing is temporarily unavailable. We will retry." I confirmed by running that the job ends `failed`, attempts=3, and is never retried.
- Large-upload screen: "Stored privately. Awaiting technical probe." and "Choose MP4/WebM up to 1 GB". The same screen also says WebM is not supported.
- Suite screen: "Videos stay private until approved in the canonical queue." and "Awaiting integration". Release form: "RL72 content queue".
- Error strings a route would surface: "Owner must confirm exact source rights and saved timeline digests", "Invalid source, rights or saved timeline revision", "Local render command or timeline changed", "Invalid media source SHA or edit revision", "The video is not technically verified…".
- An HEVC upload is shown as "Could not read this video", with no reason given.

**S6. Tests miss three guards.** In my mutation run three of fourteen changes survived:
- T3: storing a 503 failure as `render_failed` instead of `renderer_unavailable`. The R9 test only checks that the renderer throws 503.
- T6: the six-line limit with ellipsis.
- T8: the edit-plan check that refuses a word too long to fit.

## NOTES
- **R1 edges (ran or read):**
  - The trigger now fires the owner-defined guard for every job entering `calling`, text jobs included. The guard costs one join.
  - The old classifier function and its grants remain as dead code.
  - A job inserted directly in state `calling` would bypass the guard, because it is a BEFORE UPDATE trigger only. I read this; I did not check whether any canonical path inserts in that state.
- **R11 fragility moved, not removed (ran on a second fresh cluster).** If `r72_native_video_definer` already exists under another creator, draft 1 fails with "permission denied to grant role" (`native-video-role.sql:12`). The drafts are not idempotent:
  - Re-applying them on a database where they are already applied: draft 1 passes, and all 16 others fail with "already exists".
  - Re-running all 17 on a database where the first 8 are already applied: 7 fail.
  - Running the current set on a database with the first 8 drafts from 77099667 hand-applied: 7 fail.
  - Any staging database with hand-applied drafts must be rebuilt.
- **WebM (ran):** a Matroska file containing H.264 named `.webm` is refused by the 20 MB upload. The large-upload screen script and its `begin` step still accept `video/webm`, and that file probes and renders successfully.
- **Library caps (read):** a deleted source frees its slot only after the worker sweep (ran). Large private-object sources have a 10 GB byte cap and a cap of three pending uploads, but no count cap on completed sources (read).
- **Paths (read):** `filterPath` silently strips characters outside `[A-Za-z0-9_/.-]` from the font path. A repository or temp path containing other characters would make ffmpeg fail, even though the font existence check passes.
- **Six-line ellipsis (ran):** the sixth line can reach 582 px against the 562 px safe width. It stays inside the frame.

## R1–R12
| | Status | Evidence (ran unless marked read) |
|---|---|---|
| R1 | Fixed | 15 transitions across 9 scenarios on a PG16 copy of the post-proof database, run as `r72_owned_social_definer`: baseline; classifier EXECUTE revoked; classifier dropped; guard ACL emptied; readiness function dropped; readiness EXECUTE revoked from r72_owner; native-definer membership revoked; call-checks table dropped; all media tables dropped. All 11 text transitions passed in every scenario, including cancel, fail, requeue and same-state bulk updates. The four video transitions failed closed only on entering calling. Mutations C1 (classifier back in WHEN) and C2 (guard not owner-defined) were caught by their test. |
| R2 | Fixed, but introduced M1 | Their R2 test passes. Mutation P6 (backoff removed) was caught. Retries stop at three. Retry timing uses the database clock throughout. |
| R3 | Fixed | The OCR test skips cleanly; this machine has no Tesseract. I could not run the OCR test itself. |
| R4 | Partly | Screens are much plainer, and the supplier names are gone from visible text. See S5. |
| R5 | Partly | Five minutes, 1–120 s per clip and 20 MB agree across the editor, plan check, enqueue SQL, worker, docs and screens. Exceptions: M2; SQL has no 120 s per-clip check (the plan check has it); the large-upload text still says "MP4/WebM". |
| R6 | Fixed | Bundled DejaVu fonts. Refused with a clear message: emoji, Arabic, Hebrew, Cyrillic, Greek, combining accents, ZWJ, U+2028, words wider than 20 W's, and long URLs. Accepted: precomposed accents, curly quotes, €, ½, NBSP. I rendered portrait, square and landscape frames and looked at them: no empty boxes, wrapping only at spaces, at most six lines with an ellipsis, and the #ad label unobstructed. |
| R7 | Fixed | 49 uploads, then 6 racing: exactly one succeeded. 9 × 19.9 MB, then 3 racing: exactly one succeeded. Exactly 200 MB was accepted. An exact replay was free; a changed replay got 409. Caps are per workspace. See S4. |
| R8 | Fixed | Renders on an erased source, sub-second clips and trims beyond the source are all refused at enqueue. Mutations P2 and P5 were caught. |
| R9 | Partly | Render path fixed: `renderer_unavailable` is re-queued after about two minutes, then completes, and stops after three attempts. Upload-check path not fixed: S1. |
| R10 | Partly | Removed or fixed: the Shotstack function, the bad CLI header, the facebook/youtube/tiktok hand-off (now Instagram and LinkedIn only), and the hard-coded "Awaiting probe". Left: a no-op `clickRetention` port, supplier names in a code comment, and the WebM inconsistency. |
| R11 | Partly | All 17 drafts apply as the non-superuser `ci_migrator`, both by hand and through the repo runner. Worker functions run as a real `r72_worker` login. See the R11 note above. |
| R12 | Partly | See S3. |

## Isolation and merge
- **Changed files (ran):** `git diff fd1d9f5 a586e48` shows only `.env.example` modified and 99 files added, 6,196 lines in total. No change to `orchestrator/src/db/migrations` (blob ids identical), `package.json`, the lockfile, `render.yaml` or server code.
- **Reachability (ran):** a search for importers of every new module finds none outside the new files. The editor page refers to a `/portal/seo-blog/media-cut-editor.js` script that nothing serves.
- **Additions:**
  - No new dependency and no postinstall script.
  - About 1.58 MB of binaries: two DejaVu fonts (1.09 MB) with a DejaVu/Bitstream licence file (permissive), and three PNGs.
  - A new CI workflow that runs only on PRs touching media paths.
- **Merge with production (ran):** cda1d9dc was already present locally; no fetch was needed. `git merge-tree --write-tree a586e48 cda1d9dc` gives a clean tree, d15f422f, with no conflicts. Typecheck passes on both head and the merged tree.
- **Numbering (ran):** no draft refers to a ledger number. With a placeholder 0160 for the MHP sequences migration in progress, the 17 drafts become 0161–0177. The repo's runner applied all 19 (0159, the 0160 placeholder and 0161–0177) as `ci_migrator` on top of the 158 foundation migrations with no errors. Without 0160 they would be 0160–0176.

## Resource numbers (measured by me)
Setup: a 60 s 1080×1920 30 fps H.264 source with noise; worker-side check plus render; one 60 s portrait clip with a caption and fade; a cgroup v1 memory limit on the whole process tree.

| Run | Limit | Result | cgroup peak | Sampled tree RSS | Wall time | Peak temp disk |
|---|---|---|---|---|---|---|
| In-database path, 18.9 MB source | 2 GB | OK | 187 MiB | 263 MiB | 31 s | 25 MB |
| Same | 512 MB | OK | 183 MiB | 256 MiB | 29 s | 25 MB |
| Same | 256 MB | OK | 182 MiB | 256 MiB | 29 s | 27 MB |
| Same | 160 MB | ffmpeg killed for memory → 502 `render_failed` | 160 MiB | — | — | cleaned |
| Large-file path, 62 MB 8 Mbit/s source | 512 MB | OK | 266 MiB* | 298 MiB | 38 s | 9 MB |

\* Includes page cache from my own staging copy of the source.

- **Speed:** about 31 CPU-seconds for 60 s of output, single-threaded, roughly 0.5 CPU-s per output second. On half a CPU I estimate 60–75 s per minute of output and about 10 minutes for a five-minute video. That fits the 10-minute lease with its heartbeat.
- **512 MB worker:** survives, with headroom of about 250 MB or more. **2 GB worker:** comfortable.
- **Temp cleanup:** clean after success and after the memory kill. Not clean after `kill -9` (S2).
- **Their figure:** their ~473 MiB covers a whole prepare command including download and normalising, which I did not reproduce. My numbers are for the worker steps only.

## Inputs and safety (ran)
- **Hostile files:** I tried HEVC, 4K 60 fps, 200 audio tracks, truncated files with the index at the end and at the start, an SVG renamed `.mp4`, an HLS playlist inside an `ftyp` box, a plain `.m3u8`, an ffconcat list pointing at `http://127.0.0.1` and `/etc/passwd`, and an MP4 with HTML appended.
- All are refused at upload or rejected by the check, except two:
  - The MP4 with HTML appended is accepted and stored as uploaded. Safe serving (`nosniff`, a download disposition) is integration work.
  - A file truncated after a front index passes the check. Clips inside the surviving part render. A clip reaching into the cut-off part would fail at render or at the output check (read, not run).
- **Network:** a local HTTP listener received zero requests.
- **Command safety:**
  - ffprobe on uploaded bytes allows only `pipe`; renders allow only `file,pipe`; formats are limited to `mov,matroska,webm`.
  - The concat list is generated internally from sanitised names.
  - Caption text goes in through `textfile` with `expansion=none`; no user text reaches the filter graph or a shell.
  - File names with path separators are refused.

## Tests
- **Targeted set** (their CI list, 23 files): 83 tests, 80 pass, 3 skipped. The skips are the 2 browser tests (switch not set) and OCR (no Tesseract). I then ran the 2 browser tests with the switch on: 2/2 pass.
- **Their two "legacy skips"** are most likely the two foundation Chromium tests, which skip where Chromium is absent. Both ran and passed here. I did not see their CI log.
- **Real-role Postgres:** the render integration file, 16/16 pass. The calendar three-day file, 4/4 pass on PG16 with my clock shim (not libfaketime on PG18). Its output includes "R1 reproduction PASS". That is 20 subtests; I did not match their count of 24.
- **Mutations:** 14 run, 11 caught. Survivors: T3, T6, T8 (S6).
- **Diff against 77099667:** test changes swap superuser connections for `r72_worker` and adjust clip lengths now that sub-second clips are refused. One assertion is slightly looser (cross-tenant enqueue may now also fail with a "timeline" message). Nothing is newly skipped.
- **Full suite:** not run, as instructed. Their full-suite and CI numbers are taken as their claim.

## Could not verify
- The OCR test itself (no Tesseract).
- PG18 with libfaketime.
- Real camera footage and timing on a Render instance.
- Bitrate overshoot on a real five-minute high-motion render (rendering it would break the short-clips rule).
- Erasure on the large-file upload path (read only).
- Whether any canonical path inserts social jobs directly in `calling`.

## Housekeeping
- Everything is in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review4-video/`:
  - `roles/`: R7, R9, R12, R5-edge and list scripts with their outputs.
  - `trigger/`: R1 scenarios and results.
  - `r6/`: caption checks, renders and frames.
  - `mem/`: memory runs and the kill test.
  - `hostile/` plus `hostile.out`: hostile inputs.
  - `mut/`: mutation harness and its outputs.
  - `db/`: apply and idempotency runs.
  - `tsc-*.log`: typecheck results.
- PostgreSQL at `/tmp/rv4pg` is stopped; its data directory remains. The second cluster was removed. No ffmpeg, HTTP listener or cgroup of mine is left running.
- The worktree is clean at a586e48.
