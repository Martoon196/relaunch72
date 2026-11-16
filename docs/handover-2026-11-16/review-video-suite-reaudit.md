# Re-audit: repaired video suite — /home/user/r72-media @ 17b2933 (merge-base c00c928; production 475ab11)

## Five-line verdict
1. **Six of the nine repairs are real, three are partial.** Real: renderer, worker, planner-to-calling, range reads, click beacon, signup/billing removal. Partial: deletion/retention, owner screens with the "#ad" label, docs/draft naming.
2. **The memory problem is fixed.** I measured about 280–310 MiB for the whole process tree whether the plan has one clip or six; it no longer grows with clips. The practical ceilings are now render time and the 20 MB output cap, not memory.
3. **The "#ad" label is enforced in the data but not on screen.** A 61-character caption pushed "#ad" off the frame in my render. This must be fixed before anything is published.
4. **The branch is a sound base for B after one more builder round.** The video side still depends on the paid-provider drafts for its role, grants, dispatch and retention, and there are still no routes.
5. **For C, one hazard must be closed first:** if a single grant that lives in a draft you will drop is missing, the trigger on the live social-jobs table blocks all posting, video or not. I reproduced this.

All work is under `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/media-audit/r2/`. The worktree is untouched. Paths below are relative to `orchestrator/src/` unless stated.

## What I ran
| Check | Result |
|---|---|
| `tsc --noEmit` | Clean. |
| Media unit tests (30 files) | 92 tests: 90 pass, 2 skipped (both need a real browser). |
| Media PostgreSQL integration (3 files, PG 16, real FFmpeg) | 29 pass, 0 fail. |
| Native calendar proof (planner → 3 days → calling) | 4 pass, 0 fail, on PG 16. |
| Full suite, once | 5,136 tests: 5,017 pass, 0 fail, 119 skipped. |
| Merge with production 475ab11 | `git merge-tree` reports no conflicts; no file overlaps. |

- The calendar proof needs a movable database clock. libfaketime is not installed here and I had no network to fetch it, so I wrote a small clock-offset preload for the disposable PostgreSQL only. CI uses libfaketime on PG 18.
- The container restarted mid-run. The six-clip measurement was interrupted and re-run from scratch; the one-clip and two-clip runs had finished before the restart and I re-ran both anyway with matching results.

## Memory table (my measurements)
Source footage is **synthetic**: ffmpeg `testsrc2` plus noise, a hue shift and tremolo audio, 1920×1080, 24 fps, H.264 at about 12 Mbps, 390 seconds, 593 MB. Synthetic noise compresses differently from camera footage, so output sizes are indicative only. Memory is the peak summed RSS of the whole process tree (the Node worker under `tsx` plus every ffmpeg/ffprobe child), sampled every 40 ms.

| Plan | Tree peak | ffmpeg peak | Node peak | Wall time | Result |
|---|---|---|---|---|---|
| One 90 s clip, landscape, caption | 309 MiB | 141 MiB | 168 MiB | 76 s | 12.4 MB output |
| Two 90 s clips, one with fade | 306 MiB | 143 MiB | 171 MiB | 151 s | **Failed, 413**: output over the 20 MB cap |
| Six 60 s clips reordered, portrait, captions, two at 2× speed, one at half volume | 281 MiB | 144 MiB | 171 MiB | 269 s | 17.3 MB, 300 s output |
| Two 20 s clips, portrait | 311 MiB | 143 MiB | 169 MiB | 30 s | 2.2 MB |
| Two 6 s clips from an 18.7 MB source (the in-Postgres path) | 303 MiB | 143 MiB | 159 MiB | 10 s | 0.5 MB |
| Two 90 s clips from a clean (no-noise) synthetic source | 305 MiB | 141 MiB | 166 MiB | 84 s | 14.9 MB |

- **Does memory stay flat?** Yes. The old design needed 5.6 GB for two 60 s clips.
- **OS-enforced or watched?** Both, for different limits.
  - Enforced by the kernel via `prlimit` (`creative-studio/media-local-render.ts:104`): address space 1 GiB, CPU 180 s, 64 open files. I read these from `/proc/<pid>/limits` on the live ffmpeg process.
  - Watched only: the 256 MiB RSS limit is a 100 ms poll that kills the child (line 107), and the 240 s wall deadline is a timer (lines 108–111).
  - ffmpeg virtual size peaked at 662 MiB, inside the 1 GiB limit.
- **512 MB instance:** fits by measurement, with thin margin. The watchdog tolerates ffmpeg up to 256 MiB on top of roughly 170 MiB of Node.
- **2 GB instance:** about six times headroom, at one render at a time.
- **The real ceilings:**
  - *Time.* Encoding cost about 0.8 CPU-seconds per second of footage on this machine, single-threaded. On a half-CPU instance a 90–120 s clip is likely to hit the 240 s per-segment deadline. That is an estimate; I could not measure on Render.
  - *Output size.* Two 90 s clips of my footage failed after 2.5 minutes of work. The builder's real film reached 14.2 MB for 180 s. Expect roughly one to three minutes of finished video, with failure reported only at the end.
  - *Input format.* The probe accepts only H.264, up to 1920 px and 60 fps (`creative-studio/media-source-probe.ts:34-38`). HEVC and 4K phone footage will be rejected.

## The nine repairs

**1. Renderer — REAL (ran).**
- Sequential per-clip encode with input seeking, then concat demuxer with stream copy (`media-local-render.ts:185-207`).
- Codec whitelist on render and probe; resolution and frame-rate are maximums rather than lists.
- The builder's "about 207 MiB" used a pre-bundled script with a 128 MB Node heap. Run the way production runs (`tsx`), I get about 300 MiB.

**2. Worker — REAL (read; fencing and caps exercised by integration tests that ran).**
- `media:worker serve` is a real long-running loop (`workers/creative-media/service.ts:5-17`, `cli.ts:49-57`): up to ten workspaces per pass, one item each, 5 s poll, stops on SIGTERM.
- Claims take a 10-minute lease with a 15 s heartbeat (`media-local-render-pg-store.ts:199`); at most three attempts; expired leases are requeued and late settlements are rejected by token.
- Outputs are unique per job, so a crash mid-render cannot produce a duplicate. Local renders cost nothing, so there is nothing to double-charge.
- Caps: 20 queued jobs, 50 outputs, 200 MB per workspace. Two workers are safe: claim uses an advisory lock plus row lock.
- Weak points:
  - One failed heartbeat permanently fails the job as "source changed", which is never retried.
  - Workspace discovery and dispatch still read paid-provider tables (`migration-drafts/media-retention.sql:76`, `media-worker-dispatch.sql:26-28`).
  - Discovery is a function owned by `r72_owner`, not a narrow definer role.

**3. Planner to "calling" — REAL (ran), with one hazard.**
- The test uses the canonical `claimOne` and `markCalling`, with no replication-role bypass anywhere in the tests. The post is scheduled three days ahead; planning attestations expire; a fresh 15-minute proof is written inside the window; the trigger fires and records a check row; withdrawal and expiry both block.
- The planner is a fork of the canonical intent function (357 lines against 504) with the source-admission clause swapped. That follows the precedent in migration 0132, but it is a copy to maintain.
- **Cost on every update:** the trigger is `BEFORE UPDATE … FOR EACH ROW` with no column list or `WHEN` clause (`native-video-release.sql:108`). I measured about 0.17 ms per row on updates that do nothing. Negligible.
- **Can it block all posting? Yes, in one way.**
  - On every job's move to "calling", video or not, it runs a lookup as `r72_media_job_definer` (lines 94–103).
  - That lookup needs `EXECUTE` on `current_workspace_id()`, which is granted only in the paid-provider draft `0159_creative_media_video_jobs.sql:85`; the role is created there too.
  - With that grant revoked, the transition failed with "permission denied for function current_workspace_id" (ran, in a rolled-back transaction).
  - With no workspace setting, it finds no rows and lets the job through (ran).
- Fix: move the role and grants into the release migration, and add `OF state` plus a `WHEN` clause so other updates never call the function.

**4. Signup and separate billing removed — REAL (read, grep).**
- The signup, billing and Postgres-parts upload modules and their three drafts are gone.
- Nothing in the diff provisions a workspace, calls Stripe or creates a customer.
- Dead leftovers: the access-grant tier model with a `billing_verified` source (`creative-studio/media-access-pg-store.ts`, draft 0164), a "Media plan and usage" page (`portal/creative-media-commerce-view.ts:9-10`), and "standalone" wording in the suite and workbench views.

**5. Deletion and retention — PARTLY (integration test ran; rest read).**
- Real:
  - Owner erasure writes a tombstone that blocks previews, claims and release checks at once.
  - Source erasure also tombstones every derived local output.
  - The worker then overwrites the Postgres blob with one byte. The test confirms the source blob is 1 byte afterwards.
  - Staged uploads, including crash leftovers, are swept automatically.
- Gaps:
  - Automatic retention is hard-coded at 30 days for every source and output (`migration-drafts/media-retention.sql:50-52`). The owner's library silently disappears after a month. This needs an owner decision.
  - File names, digests, saved edit plans (with captions) and canonical content rows remain.
  - Copies on Zernio's media host and in database backups are not touched.
  - Erasing a large-file source with no disk configured throws and stalls that workspace's whole tick (`creative-studio/media-retention.ts:21`).
  - The takedown view is an unmounted form.

**6. Owner screens and "#ad" — PARTLY (ran a render and looked at the frame).**
- Typed hashes are gone; evidence is now a document upload; money shows as currency.
- Still visible: two digests on the render screen (`portal/creative-media-local-render-view.ts:37-38`) and a "JSON fallback" textarea in the editor (`portal/creative-media-editor-view.ts:18`).
- "#ad" is required in TypeScript (`creative-studio/media-edit-plan.ts:33`) and SQL (`migration-drafts/0166_creative_media_edit_projects.sql:89`, `native-video-jit.sql:27`), and is burned into every clip.
- **But it can be invisible.** Caption and label are drawn as one centred line with no wrapping (`media-local-render.ts:74-80`). With a 61-character caption in portrait, the frame showed "…er is the best budget pick I have tested this" and no "#ad". Captions may be 240 characters. The label also sits at the bottom, where Instagram's own interface covers it.
- "#ad" is required on every video, affiliate or not, because videos are not linked to products.

**7. Range reads — REAL (read).** `readRange` now checks size and read-only mode only (`creative-studio/media-private-files.ts:75-82`); status reads 64-byte part receipts. Completing an upload still copies and hashes the file inline.

**8. Docs and drafts — PARTLY (read).**
- The three docs now describe unmounted components honestly.
- Inaccuracies:
  - Docs say hashes were removed from owner screens (see 6).
  - Docs say the disclosure cannot be switched off (see 6).
  - `.env.example` still lists provider keys and omits nine flags the code reads (service, retention, dispatch, native calendar, private files, pages, release, handoff, link evidence).
- All SQL is still under `creative-studio/migration-drafts/`, but 11 files keep numbers 0157–0167; two now collide by number with the real 0157 and 0158.
- Drafts present (23): 0157 products, 0158 reports, 0159 video jobs, 0160 source videos, 0161 source preview, 0162 probe, 0163 output capture, 0164 access grants, 0165 output preview, 0166 edit projects, 0167 global budget, output-private-review, local-render-jobs, local-output-private-review, media-worker-dispatch, local-video-canonical-handoff, affiliate-link-evidence, private-object-sources, native-video-release, affiliate-link-distribution, media-retention, native-video-jit, native-video-planner.
- All 23 apply in order on PG 16 (ran).

**9. Click beacon — REAL (integration subtest ran; rest read).**
- The table stores only the key's SHA-256. The HMAC is checked in the application with a constant-time compare. Two indexes back the cap and retention. Rows are deleted after 30 days.
- The nonce is now derived from page, UTC day and a keyed hash of the visitor's source address, so one source counts once per page per day (`creative-studio/media-affiliate-pages.ts:44-58`).
- **Can a script still inflate?** Yes, by one click per distinct source address per page per day, up to 10,000 per page per day.
  - If the unwritten router trusts a forwarded-address header, or treats each IPv6 address as distinct, one person can reach the cap.
  - Everyone behind one shared address counts as one.
- Other points:
  - The owner's count is a live row count, so totals shrink as rows age out.
  - Recording needs a new `r72_media_click_command` role, created NOLOGIN, so integration means a new database login and pool.

## A. Redundant with production's affiliate layer
- **Drop:**
  - Drafts 0157 (products), 0158 (reports), affiliate-link-evidence.
  - `creative-studio/media-product-pg-store.ts`, `media-link-evidence.ts`, `amazon-tracking-report.ts`, `amazon-report-pg-store.ts`, `affiliate-product.ts`, and the `service.ts` hook.
  - The products, reports and commerce views and their tests.
- **The video side needs no re-pointing.** Sources, probe, edits, render, review, handoff, planner and release contain zero references to any product table (grep).
- If you want a video tied to a product, that is small new work: a nullable product reference on the edit project or handoff, pointing at `app.affiliate_products(workspace_id, product_id, revision)`.
- **Only public pages and clicks reference the duplicate tables.** Re-pointing them means rewriting `affiliate-link-distribution.sql` and `media-affiliate-pages.ts`:
  - Two foreign keys and the page function move to `app.affiliate_products` (`affiliate_url`, `programme='amazon_uk'`, `status='active'`).
  - Registered site and confirmations come from `app.affiliate_programme_settings`.
  - The 30-day evidence expiry has no production equivalent.
  - `affiliate-direct-link.ts` duplicates the URL rule production already enforces in 0158.
- That is about one builder round, and I would not do it yet (see D).

## B. Smallest useful first video release

**Builder round first:**
- Strip provider tables from dispatch, retention, workspace discovery and `cli.ts`.
- Move the `r72_media_job_definer` role and grants out of 0159, and create the erasures table before the functions that read it.
- Put "#ad" on its own always-visible line and wrap or limit captions.
- Remove the digests and JSON label from owner screens.
- Make the retention period a setting.
- Stop one heartbeat failure from killing a job.

**Releases** (each: code on all services, then one hand-applied migration, plus its readiness-gate entry):

| # | Migration | Owner sees |
|---|---|---|
| B0 | none | Nothing; dark merge. |
| B1 | Role and grants, erasures, sources, preview, probe, edit projects, erase and retention functions, probe-only dispatch | "Video clips": upload, automatic check, preview, delete, trim and caption with the ad label. |
| B2 | Local render jobs, full dispatch | "Make video", then preview and download the MP4. |
| B3 | Private large-file sources | Uploads of real phone clips. |

**Routes to write** (none exist), under the existing owner session and CSRF:
- Clips list.
- Upload (multipart, 20 MB).
- Source stream with ranges.
- Editor GET and POST.
- Renders GET and POST.
- Output stream and download.
- Erase.
- The editor script.
- For B3: begin, status, part, complete, cancel, and the uploader script.

That is about 10 routes, plus 6 for B3.

**Worker service:**
- One new Render background worker running `media:worker -- serve`, with FFmpeg and `prlimit` present.
- Size: 512 MB fits by my memory numbers, but half a CPU will time out on clips past about a minute. Use the 2 GB / 1 CPU plan, one worker.

**Storage:**
- *Postgres, 20 MB:* works today with no new infrastructure. But 12 s of my 12 Mbps footage was 18.7 MB, so it holds roughly 10–15 seconds of phone video. Good enough to prove B1–B2, not to be useful.
- *Disk on the worker:* the tested filesystem code needs the same directory on the upload server and the worker, which Render cannot give two services. It would need a new internal file API and a single-instance service.
- *Object storage (S3-compatible):* also new code (browser multipart upload, worker download to temp, delete), but works with stateless services and is what selling to other affiliates needs.
- **Recommendation:** Postgres for B1–B2, then object storage for B3, skipping the disk.

**Owner decides or pays for:**
- The worker instance and a storage bucket.
- The retention period.
- Whether "#ad" stays mandatory on every video.
- Accepted formats (H.264 up to 1080p only, unless transcoding is added).
- A realistic length limit: about one to three minutes finished.

## C. Second release: approval queue and Zernio
- **C1** (migration: local output review plus canonical handoff). "Send for approval" creates the video and its caption as two items in the existing queue. The queue must be able to play the exact video, and the two items plus the three-tick private review should be presented as one step.
- **C2** (migration: release tables, readiness functions, the trigger with the `WHEN` clause, its own grants; no planner yet). Installed dark, then watch normal posting for a few days.
- **C3** (migration: JIT and planner functions). Pick account and time, wrap the existing Zernio media resolver, let the media worker write the 15-minute proofs, and expose withdrawal.
- Limits to state:
  - Instagram and LinkedIn only.
  - 20 MB videos.
  - A post scheduled beyond the retention window loses its video.
  - The 20 MB file is loaded three times in the social worker.
  - The Zernio-hosted copy survives withdrawal.

## D. Do not integrate
- Paid providers and their budget: drafts 0159, 0163, 0164, 0165, 0167, output-private-review; `media-providers`, `media-admission`, `media-work-executor`, `media-reconciler`, `media-video-output-*`, `media-output-review`, `media-access`; the workbench, output-review and billing views.
- The duplicate product, evidence and report layer (A), including the `service.ts` hook. Dropping it leaves no shared source file changed.
- Public product pages as built: near-empty doorway pages on a second product table, and they need a new database login. Lift the click-observation idea onto production's affiliate articles later.
- `portal/media-scene-timeline.ts` (targets a form attribute nothing has) and the "standalone" suite presentation.

## E. Honest count
- **B:** one builder repair round, then B0, B1, B2, B3: **5 cycles**, or 4 if you accept the 20 MB pilot as the first release.
- **C:** one builder round (trigger, grants, approval-queue preview, single-step presentation), then C1, C2, C3: **4 cycles**.
- **Total for B and C:** about 9 release-and-review cycles, each including route handlers the builder has still not written.
