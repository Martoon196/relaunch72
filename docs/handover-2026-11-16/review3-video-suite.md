# Third audit: video/media suite at 77099667 (PR #108)

## Verdict
**Yes, after named repairs.** The dark merge (code in, nothing mounted, no drafts applied) is safe once one thing is fixed: the new on-screen-label test fails instead of skipping where Tesseract is not installed, which turns the full suite red on this machine. Everything else gates later releases, not the dark merge. Two repairs matter most:
- **Trigger grant (before the calling trigger is installed):** with one grant missing, every state change on the live social-jobs table fails, video or not. I reproduced this.
- **Queue stall (before the worker is switched on):** one large file the worker cannot reach stalls that workspace's media queue forever. I reproduced this.

The fetched head was exactly 77099667. The foundation has moved again to fd1d9f5 (two `docs/ops` SQL files beyond 7b5ccf2); the branch merges cleanly into both. The worktree is untouched and still at 77099667.

**Timing of results:** everything below was measured before the container restart, except the one timing test I re-ran alone afterwards. Lost at the restart and not re-run, as instructed: the 384 MiB limit run and the 12-clip maximum-length capacity stress.

## The nine claims
1. **Visible "#ad": confirmed by running, with caption defects.**
   - I rendered 8 hostile films (light, dark and moving footage; portrait, square, landscape) and 10 edge-case films. The label matched a reference on every one of about 330 frames per film, with text-to-box contrast of at least 223/255.
   - Those films covered fades, cuts, 2× and 0.5× speed, a 0.5 s clip, a 240-W caption, emoji, Arabic, a long unbroken word, an empty caption and stacked diacritics. I also looked at the frames.
   - The label occupies 13–29% across and 21–26% down in portrait, clear of the top bar, right-hand buttons and bottom caption area. It is drawn after the caption, so no caption can cover it.
   - Unknown plan fields (opacity, zoom, crop, overlays) are ignored; a plan without "#ad" is rejected. No flag switches the label off.
   - Their OCR test is real (renderer, extracted frame, Tesseract), but I could not run it: Tesseract is not installed and downloading it was blocked. It checks one frame at 1.0 s of one clip on a plain navy background.
2. **Duplicate affiliate layer removed: confirmed by running.**
   - Against the merge base, the only modified pre-existing file is `.env.example`; 90 files are added.
   - All 158 migration files have identical git blob ids to 7b5ccf2. No change to `package.json`, lockfile, `render.yaml`, prompts or server code.
   - The 19 other two-dot differences against 7b5ccf2 are exactly foundation commit #131, which the branch predates.
3. **Paid-provider dependency removed: confirmed by running.**
   - Fresh PostgreSQL 16, the repo's own migrate path (158 applied), then the 16 drafts via their script; and again by hand, in order, as the non-superuser migrator on a second fresh cluster. All applied.
   - Re-apply fails cleanly at the second draft ("already exists", rolled back). It is not idempotent.
   - All 33 new functions are SECURITY DEFINER with `search_path=pg_catalog`; none is granted to PUBLIC.
   - With real `r72_worker` and `r72_content_command` logins and two workspaces, cross-workspace reads, writes and worker scoping were all refused.
4. **Calling-trigger isolation: partly.**
   - The trigger is as described (`BEFORE UPDATE OF state`, WHEN limited to native-video jobs entering calling).
   - With all media-role grants revoked, eight media tables dropped, the readiness function dropped, or role membership revoked, all 14 non-video transitions worked. Video jobs failed closed only on entering calling.
   - With `EXECUTE` on `creative_media_job_has_native_video` revoked from `r72_owned_social_definer`, every update that names `state` failed for every job, including cancel, fail and requeue.
   - Overhead on a 20,000-row bulk update was not measurable (1.45–1.57 s with the trigger, 1.46–1.49 s without).
5. **Retention and heartbeat: confirmed by running.**
   - No settings row means nothing expires. Days of 0, −1, 3651, 1.5, NaN, a string and 2³¹ are refused in both TypeScript and SQL; a non-owner member and another workspace's owner are refused.
   - With no disk configured, the sweep does not throw and the erasure stays pending.
   - A second worker's claim is refused; a wrong or late token is refused; a duplicate settlement returns the same output; changed bytes are refused; an expired lease is requeued with a new token.
   - Erasing a source during a claimed render makes settlement fail, and source and output blobs are overwritten to 1 byte.
6. **Owner screens: partly; one part is false.**
   - The two digests and the JSON textarea are gone, and file names and captions are escaped correctly (rendered all ten screens with hostile data).
   - The render screen still tells the owner "No external Vizard or Shotstack call is needed", plus other internal wording (finding R4).
7. **Fail-fast capacity: partly.**
   - SQL refuses at enqueue: a 253 s timeline was accepted, 254 s and 300 s refused.
   - The owner is told "Media render queue or storage capacity reached", not the plain 20 MB message.
   - Outputs I measured ran 2–3% above the nominal rate, inside the 8% allowance; the maximum-length 12-clip case was not measured.
8. **Drafts, flags, docs: confirmed, with stale statements.**
   - No numbered draft names remain; `.env.example` has the nine flags false, plus the master switch, the files root and the parked flag.
   - No foundation file imports the new modules; the worker command exits before opening a database connection when flags are absent.
   - Stale or false doc statements are listed below.
9. **Parked parts: confirmed by running.**
   - `affiliate-link-distribution.sql` cannot apply (missing `app.creative_media_products`); nothing references the public pages or beacon.
   - `publish` throws 503 before touching the database, even with the parked flag on.

## Repair defects (theirs)
**R1. Trigger grant is a single point of failure for all posting (high; before the trigger is installed).**
- `migration-drafts/native-video-call-trigger.sql` lines 4–12.
- PostgreSQL checks the WHEN clause's function permission whenever `state` is updated, not only on entering calling.
- Failing case: `REVOKE EXECUTE … FROM r72_owned_social_definer`; every transition then fails with "permission denied for function creative_media_job_has_native_video".
- Today only that role and `r72_owner` update the table, and the grant sits in the same draft, so a correct install works. A later role or re-created function would break posting.
- Fix: keep only column comparisons in WHEN and classify inside the definer trigger function.

**R2. One unreachable large file stalls a workspace's queue forever (high; before the worker is on).**
- `workers/creative-media/cli.ts` (serve uses `limit:1`) with `media-worker-dispatch.sql` (oldest first, failed probe never recorded).
- Failing case: an older large-file source whose file the worker cannot open (worker flag off, or no shared disk). Four ticks returned the same item as "held"; a newer small upload was never probed.
- On Render, web and worker cannot share a disk, so this is the default outcome for large uploads.

**R3. The OCR test fails instead of skipping without Tesseract (medium; before the dark merge).**
- `test/media-visible-disclosure.test.ts:23`.
- On this machine the suite goes from 0 failures to 1.

**R4. Supplier names and internal wording on owner screens (medium).**
- `portal/creative-media-local-render-view.ts`: line 64 "No external Vizard or Shotstack call is needed"; line 48 "no paid video service"; line 66 "This screen is not connected to the live portal"; raw job states and id fragments; "Canonical approval required".
- `portal/creative-media-video-sources-view.ts:16`: "cannot trigger a provider charge".
- `portal/creative-media-local-output-review-view.ts`: line 53 shows raw `reviewed_private`; line 68 links to the removed `/workbench`.
- `portal/creative-media-erasure-view.ts` and `creative-media-release-view.ts`: "provider copies", "canonical provider takedown".
- Their own test only forbids `shotstack.io|vizard.ai`, so it misses the names.

**R5. Length limit and its message are inconsistent (medium).**
- The editor and plan check allow five minutes (`portal/media-cut-editor.ts:148,156`, `creative-studio/media-edit-plan.ts:56`); the real cap is about 4 min 13 s.
- `creative-studio/media-local-render-pg-store.ts:61` turns the SQL's plain message into "queue or storage capacity reached".
- A failed job's reason is never shown: the list omits the error code.
- The cap also refuses simple footage that would fit: my 11 s plain-colour films were 0.30 MB (about 215 kbit/s), so a five-minute version would be about 8 MB.

**R6. Captions (medium).**
- Emoji, Arabic and any glyph the font lacks render as empty boxes (seen in frames). `creative-studio/media-local-render.ts:96` names no caption font, so the result depends on the machine.
- Wrapping splits words mid-word: `wrappedVideoCaption`, lines 58–63. Their own evidence image shows "mu/st" and "disc/losure".
- Portrait shows at most 72 characters. The 240 limit counts UTF-16 units, so 121 emoji are refused.
- The editor's "Required on-screen #ad disclosure" box has no effect on the video.

**R7. No cap on in-database source uploads (medium; read).**
- `source-videos.sql`, `creative_media_video_source_command`: each upload is up to 20 MB into production's `seo_blog_blobs`, with no count or byte limit per workspace. Outputs and large files are capped; these are not.

**R8. Queue admission gaps (low to medium; ran).**
- Trims are not checked against the source length: a 253 s timeline on a 6 s source was queued, and would fail later as "source_changed".
- A new render on an erased source was queued.
- A single 0.5 s clip passes validation but can never complete (422 after rendering), and is retried three times.

**R9. A transient probe failure during render becomes a permanent failure (low; read).**
- `media-local-render.ts:173–177` returns 409, which `media-local-render-pg-store.ts:222` maps to "source_changed", never retried.

**R10. Leftovers (low).**
- `videoPlanToShotstack` and its test (`media-edit-plan.ts:67`); `PgMediaServiceDiscovery.clickRetention` calls a parked function; the `cli.ts` header cites an npm script that does not exist.
- Handoff accepts facebook, youtube and tiktok, which can never become ready.
- "Awaiting probe" is hard-coded for every source. The upload screens say "MP4 or WebM", but every WebM is rejected by the probe.

**R11. Bootstrap fragility and thin role coverage (low; ran).**
- If `r72_media_job_definer` already exists under a different creator, the first draft fails with "permission denied to grant role".
- Their CI applies drafts as superuser only, and their render tests run the worker side as superuser. I ran the worker functions as `r72_worker`; they work.

**R12. After erasure (low; ran).**
- The file name and saved plans with captions remain. An in-flight render keeps running; its settlement is refused.

## Integration work (ours)
- **Merge target.** Merge onto the current foundation; `git merge-tree` is clean against 7b5ccf2 and fd1d9f5, and typecheck is clean on the merged tree.
- **Routes.** None exist. Session, CSRF enforcement, multipart, range streaming with `nosniff` and a download disposition are all ours; a file with trailing HTML is stored as uploaded.
- **Migrations.** Number and split the drafts. `media-retention.sql` depends on the table created in `private-object-sources.sql`, so retention cannot ship before it without a split.
- **Side effects on shared objects to review:**
  - read policies and grants on nine canonical tables;
  - INSERT on `company_content_source_attestations` for the existing `r72_creative_studio_definer`;
  - SELECT/INSERT/UPDATE on `seo_blog_blobs` for the media role (workspace-scoped);
  - three functions owned by `r72_public_social_definer`, including a 364-line planner fork, and two owned by `r72_owner`;
  - one trigger on the social-jobs table.
- **Worker image.** It needs ffmpeg, ffprobe, `prlimit`, the DejaVu font at its fixed path and a caption font. A killed render leaves its temp directory behind.
- **Storage.** A shared disk is not available on Render (see R2); object storage is new code.

## Parked
Public product pages, the click beacon, `affiliate-link-distribution.sql` and the product-pages view. They are unreachable and should stay out of every migration batch.

## Notes
- Landscape footage on a portrait canvas puts the label in the black bar above the picture. It is visible, but a 1:1 thumbnail crop would cut it.
- Rotated phone footage, variable frame rate, moov-at-end, audio-less and 10-bit files are accepted and render correctly. HEVC, 4K, 120 fps, MP3 audio and two video streams are rejected.
- The probe trusts container metadata: a truncated file passes and then fails at render.
- Path separators and control characters in file names are refused; file names are never used as paths.
- ffmpeg and ffprobe run without a shell, with protocol, format and codec whitelists; caption text goes through a file with expansion off.
- No credentials, private URLs or personal data in the diff, docs or evidence images. The only network call in the branch's tooling is a CI download of a Blender film.
- Whether 480 kbit/s looks acceptable on real footage needs a human eye.

## Stale or false doc statements
- "Shared source matches the merged foundation": true for a73b29f, but the foundation is two steps ahead.
- "Removed provider … terminology" and "nothing names a supplier": false (R4).
- "Upload screens state H.264 up to 1080p": the 20 MB upload screen does not.
- The roughly 212 MiB memory figure comes from a bundled script with a 128 MB heap, not the documented worker command.
- The trigger fixture "proves" isolation for one transition with two grants revoked; it does not cover the classifier grant.

## Memory and time (before restart)
Source: 180 s, 1920×1080, 30 fps, 8.2 Mbit/s, test pattern plus noise (synthetic, not camera footage). Run as the documented command runs (`node --import tsx`). Whole process tree sampled every 40 ms. The machine has 4 cores and was at load 21–26, so wall times are inflated; CPU seconds are the better guide.

| Plan | Tree peak RSS | ffmpeg | Node | CPU s | Wall s | Output |
|---|---|---|---|---|---|---|
| 1 clip, 60 s, portrait | 336 MiB | 146 | 191 | 32 | 37 | 4.43 MB |
| 3 clips, 180 s, landscape | 331 MiB | 144 | 188 | 107 | 125 | 13.27 MB |
| 6 clips, 195 s out, portrait | 335 MiB | 147 | 198 | 93 | 129 | 14.50 MB |
| Continuous 3 min (two 90 s clips) | 332 MiB | 144 | 193 | 103 | 131 | 13.23 MB |
| Same, hard 512 MiB limit | 281 MiB | 144 | 146 | 98 | 127 | 13.23 MB, limit never hit |

- **Against their claim** (about 212 MiB, 61 s, 12.5 MB): I get about 332 MiB, 103 CPU-seconds and 13.2 MB. Memory is flat across clip counts.
- **512 MB instance:** fits, but with little headroom. The 512 MiB-limited run completed without hitting the limit. The in-database path also holds the 20 MB source and output in Node, which these runs do not include.
- **2 GB instance:** about six times headroom.
- **Time:** about 0.55 CPU-seconds per output second. On half a CPU, a 120 s clip at half speed would likely pass the 240 s per-clip deadline; that is an estimate.

## Test totals as I measured them
| Run | Result |
|---|---|
| Typecheck, head and merged tree | Clean |
| Branch's 21 new test files | 57 tests: 52 pass, 4 skipped, 1 fail (OCR) |
| Their PostgreSQL integration tests, my PG 16 | 21 pass, 0 fail |
| Native calendar three-day proof | 4 pass, 0 fail (my clock preload, not libfaketime on PG 18) |
| Full suite at 77099667 | 5,331 tests: 5,210 pass, 120 skipped, 1 fail (OCR) |
| Full suite, head merged into 7b5ccf2 | 5,340 tests: 5,218 pass, 120 skipped, 2 fail |

- The second merged-tree failure is the foundation's own timing test (`seo-blog-brand-dna-pricing.test.ts`, 2,563 ms against 2 s under load). Re-run alone after the restart: 31 of 31 pass.
- **Count difference explained:** the foundation's 5,283 is the branch's base (5,274) plus the 9 tests of `affiliate-screens.test.ts` from #131. Head is 5,274 + 57 = 5,331. Merged is 5,283 + 57 = 5,340, which equals their 5,216 + 124, so their CI ran on the merged tree.
- No foundation test was deleted, skipped or weakened; no pre-existing test file is touched.
- Their split has 4 more skipped and 4 fewer passing than mine would with Tesseract. I did not identify which four.

## Proposed order of releases
1. **Builder round:** R1, R2, R3, then R4–R8.
2. **B0, dark merge:** no migration, nothing mounted. Needs only R3.
3. **B1, clips:** role, erasure table, sources, preview, probe, edit projects, retention (split from the large-file table); routes for upload, list, preview, delete and editor; worker probing only. Needs R2, R4, R7.
4. **B2, make video:** render jobs and dispatch; preview and download. Needs R5, R6, R8.
5. **B3, large files:** only after the storage decision.
6. **C1:** output review and approval-queue handoff.
7. **C2:** release tables and the trigger, after R1, installed dark and watched for a few days.
8. **C3:** proofs near the slot and the planner.

**Owner decisions:**
- **Worker:** a worker instance with ffmpeg and fonts; I would take 2 GB and one CPU.
- **Storage:** in-database only (about 10–15 s of phone footage per 20 MB) or object storage.
- **Retention:** indefinite by default, or a set period.
- **Label:** whether "#ad" stays mandatory on every video, and its position.
- **Formats:** H.264 up to 1080p only (iPhone HEVC is refused), and a real maximum length of about 4 minutes.
- **Captions:** whether emoji must work.
- **Quality:** whether 480 kbit/s is good enough.

## Not verified
- Their OCR test (Tesseract unavailable).
- The 384 MiB run and the maximum-length capacity stress (lost at restart).
- Real camera footage; timing on a Render instance; their 61 s figure.
- PostgreSQL 18 with libfaketime.
- Platform overlays in live apps.
- Deadlock behaviour under concurrent posting (reasoned from the code, not run).
- I used `/proc` sampling, `rusage` and a v1 memory cgroup because `/usr/bin/time` is not installed.

## Housekeeping
- PostgreSQL had to live in `/tmp/rv3pg`, because the postgres user cannot enter the scratch folder. Both clusters died at the restart and I removed the directory.
- `node_modules` in the worktree is a hard-linked copy, git-ignored and not added.
- To free disk I deleted the 184 MB noisy source; its recipe is saved beside the outputs.

Everything is in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-video-suite-3/`:
- `trigger/run.sh`, `trigger/results.txt` and `trigger/perf.sql`: trigger scenarios and the bulk-update timing
- `roles/audit-roles.mts`, `roles/result.txt`, `roles/audit-hol.mts` and `roles/result-hol.txt`: role, lease, retention and queue-stall checks
- `render/render.mts`, `render/labelcheck.py`, `render/measure.py`, `render/measure-*.json`, `render/frames/` and `render/out/`: renders, label check, memory runs and frames
- `inputs/result.txt`: edge-case inputs
- `screens/`: rendered owner screens
- `full-suite.tap` and `merged-suite.tap`: suite outputs