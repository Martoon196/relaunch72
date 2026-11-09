# Creative Studio gaps — integration-ready release handoff

This release closes four gaps:

- typed-brief image generation;
- durable render jobs;
- real campaign attribution capture;
- integration and migration.

Feature detail lives in [creative-studio.md](creative-studio.md), in its last three sections. This page is the release package. It has not been merged or deployed.

## 1. Work branch, head and tree

- Branch: `claude/exciting-dirac-q38u2u` (Martoon196/relaunch72).
- Source-bound receipts (section 6) were produced on head `20e425d562894066e6c7653b734eaefc77b74002`, tree `d92f07d2a238e3430dfc3fe611e97f1e4b93568f`, with a clean worktree.
- The commit that adds this page changes only `docs/`, this page and `docs/evidence/creative-studio-release/`. No source or migration changes. Verify with:

  ```bash
  git diff --stat 20e425d HEAD
  ```
- The final head and tree are stated in the draft PR description.

## 2. Canonical base and conflicts

- Canonical: `codex/relaunch72-platform-foundation` at `b388f07` (latest at the time of the release merge). It was merged in twice, never rebased or force-pushed:
  - `b6296aa` merged `5895a02`. Conflicts were in `test/db/runtime-readiness.test.ts` and `test/db/sql-contract.test.ts`:
    - canonical's MHP `0143_mhp_whatsapp_direct_inbox.sql` and its pins were kept;
    - the unapplied studio migration was renumbered 0143 → **0144** (it was never applied as 0143 anywhere);
    - canonical's 143-file readiness test now runs against the exact 143-file bundle;
    - a 0144 readiness case was added.
  - `20e425d` merged `b388f07`. This merge had no conflicts (article-writing changes only, no migrations).
- Not touched:
  - MHP payments, WhatsApp and inbox;
  - canonical's reviewed readiness behaviour;
  - the stopped Apollo work: PR58 was not integrated or resumed, its automation was not restarted, and its numbers were not used.

## 3. What was added, and what was reused

| Gap | Added | Reused (nothing parallel built) |
|---|---|---|
| New images from a typed brief | Brief versions, cost and allowance review, explicit one-image intent, worker coordinator, results, and "create artwork from this image". Size option and reference images (edits endpoint, multipart `image[]`) in the existing transport. Studio sub-allowance. | Existing image transport and credential (`SEO_BLOG_IMAGE_API_KEY`, gpt-image-2, medium), with the article request byte-identical. 0137 operator policy, global lock, reservation, attempts, receipts, holds and private media. Existing job table and worker. Existing compositor. |
| Durable renders | `creative_render` jobs, a task page, and a worker runner. The worker can act in SQL only for the claimed job's sponsor and command. | Existing `seo_blog_jobs` claims and leases, the SEO worker tick, the same service methods, and idempotent studio commands. |
| Real attribution capture | Brand enquiry form (hosted or embedded). Append-only `creative_studio_lead_touches`. Qualified-stage mapping by stage id. | `crm.createLead` (as the GHQ inbox does with its configured owner), the investor-site form safety pattern, existing pipelines, and the existing outcome reader. The affiliate attribution tables are untouched. |
| Integration | Readiness bridge for exactly one pending 0144. | Canonical's readiness design (the same pattern as the 0142 and 0143 bridges). |

## 4. Migrations and checksums

Only one migration is added. All applied migrations 0001–0143 are byte-identical to canonical; `git diff --name-status origin/codex/relaunch72-platform-foundation HEAD -- orchestrator/src/db/migrations` shows only `A 0144_creative_studio_library.sql`.

| File | SHA-256 | State |
|---|---|---|
| `0143_mhp_whatsapp_direct_inbox.sql` (canonical, unchanged) | `69eae7f9f1672973b6dcf72fd093922df7cf94580da9f535e063a1fa886bc42e` | applied in canonical |
| `0144_creative_studio_library.sql` | `79f92a7d7091cc98d6b63235c57e8cdfac2951afeb131ec4226f5e07adb5a535` | **unapplied**; pinned as `CREATIVE_STUDIO_CHECKSUM` in `orchestrator/src/db/creative-studio-schema.ts` |

0144 is additive: new tables, functions, grants and policies. It replaces three functions in place:

- `seo_image_reserve`: a studio branch runs before the unchanged article branch;
- `seo_image_apply_hold`: a studio branch;
- `seo_creator_command` (Milestone 2): kind lists only.

It also adds grants to the NOLOGIN definer roles. Runtime roles get EXECUTE on named functions only, and no table access.

## 5. Schema and readiness compatibility, and all-consumer rollout

`runtime-readiness.ts` accepts one pending migration only when all of these hold:

- the bundle has exactly 144 files;
- file 144 is `0144_creative_studio_library.sql`, with the pinned checksum;
- 0142 payments and 0143 direct WhatsApp inbox are already applied with their exact checksums.

Rollout order:

1. **Deploy this release to every service that runs readiness**, with `CREATIVE_STUDIO_ENABLED` unset. That means the Growth HQ web portal, the SEO blog worker (`relaunch72-seo-blog-worker`), and every other consumer of the same database. Before 0144 is applied the studio stays unmounted and nothing reads its tables. Do not do this during an unfinished 0142 or 0143 cutover.
2. Apply 0144 with the normal migration runner (it takes roughly seconds; `lock_timeout` is 5 s and `statement_timeout` 60 s).
3. Readiness then reports no pending migrations everywhere.

## 6. Source-bound test receipts (head `20e425d`, tree `d92f07d`)

Environment: Node v22.23.4 and PostgreSQL 16.15.

- **Typecheck:** clean.
- **Supply-chain gate:** passed for 117 external packages; the SBOM is current.
- **Full suite (`npm test`):** 4352 tests, 4284 pass, **0 fail**, 68 skipped (database tests, which run separately below).

PostgreSQL proofs: each ran on a freshly recreated dedicated disposable cluster (`r72proof`, port 5433, never `main`), as the actual least-privilege roles.

| Proof | Result |
|---|---|
| creative-studio-pg (library) | 8 pass, 0 fail |
| creative-studio-video-pg | 4 pass, 0 fail |
| creative-studio-distribution-pg (Milestone 4, now proving the stage-id rule) | 5 pass, 0 fail |
| creative-studio-learning-pg | 4 pass, 0 fail |
| creative-studio-generation-pg (typed-brief images) | 9 pass, 0 fail |
| creative-studio-render-jobs-pg (real headless Chromium) | 7 pass, 0 fail |
| creative-studio-enquiry-pg (capture → CRM → reader) | 6 pass, 0 fail |
| acquisition-campaign-pg (Milestone 2 creator) | 5 pass, 0 fail |
| seo-blog-media-storage (article images unchanged) | 2 pass, 0 fail |
| seo-blog-media-engine (article images unchanged) | 1 pass, 0 fail |
| group-hq-inbox-crm (GHQ inbox CRM) | 1 pass, 0 fail |
| mhp-wa-direct-inbox (MHP 0143 inbox) | 1 pass, 0 fail |
| mhp-event-whatsapp (MHP WhatsApp) | 2 pass, **1 fail — pre-existing on canonical** |

`mhp-event-whatsapp` subtest "MHP009C WhatsApp follow-up …" fails with `Expected PostgreSQL error 23503`. **The same subtest fails identically on canonical `b388f07` alone** (a clean worktree, 143 migrations, no 0144, the same fresh cluster), while its other two subtests pass in both. It is not caused by this release. It was left untouched because it belongs to the MHP owner, and is reported for them to triage.

A fresh full bootstrap at this head applies 144 migrations, the last being `0144_creative_studio_library.sql`.

## 7. Visual and provider evidence (labelled)

`docs/evidence/creative-studio-release/` contains the evidence files.

**What ran.** `orchestrator/test/manual-creative-generation-pg-demo.ts` ran the production portal composition and production worker composition on a disposable database, driven in Chromium. Every screenshot carries a red banner: **"PROOF RUN · SYNTHETIC PROVIDER RESPONSE · no paid request was made"**. The "generated" picture is a synthetic gradient JPEG returned by a stubbed provider endpoint in that process; **it is not provider output**.

**What the summary shows** (`walkthrough-summary.json`):

- exactly one (synthetic) provider call, made only after the worker picked up the job;
- one usage debit;
- the render request returned in about 0.4 s;
- the worker recorded and playback-checked a 1080×1920, 10.5 s MP4 in about 15 s, and it played in the browser;
- an enquiry created one contact and one opportunity, and no touch (its tags matched no issued link);
- no console errors.

**Screens:**

| File | What it shows |
|---|---|
| `01` | Defaults off |
| `02` | Cost and allowance review |
| `04` | The private generated candidate |
| `05b`, `07a` | Durable task pages |
| `06` | Artwork from the generated image |
| `07b` | Video rendered and checked |
| `09b` | Owner enquiry settings with the embed code |
| `09c`, `09d` | A visitor's form on a phone |

**Live provider proof: not performed.** No authorised image allowance or credential exists in this environment. The smallest real test:

1. Use one test brand.
2. Open the operator policy (section 9) with `maxConcurrency` 1.
3. Set the brand's studio allowance to 1 and its brand image allowance to at least 1.
4. Request **one** 1024×1024 image at medium quality, with no references, from a short brief.

Expected cost is a few US cents of output-image tokens (published per-token rates conflict, so read the usage recorded on the attempt rather than estimating). Acceptance:

- one attempt row with `candidate_received`;
- usage tokens present;
- one generation row;
- the image visible on the brief page;
- artwork created from it.

**Renderer.**

- Local proofs used `/opt/pw-browsers/chromium_headless_shell-1243` (Chrome for Testing 153.0.8010.12).
- The production build step installs the version pinned by `playwright-core` 1.61.1: headless shell revision **1228** (Chromium 149.0.7827.55) under `.playwright-browsers/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell`. `findCreativeChromium` covers that path.
- That download was blocked by this environment's network, so **revision 1228 was not run here**.
- Video uses the browser's own MediaRecorder (H.264 MP4 preferred, WebM fallback) and a playback check, with no external encoder.
- Production acceptance:
  - the build log shows the headless-shell install line;
  - the worker log shows `creative-studio-v1 … renderer found`;
  - one render task and one video task finish, and the video plays.

## 8. Flags and credential names (never values)

| Name | Where | Meaning |
|---|---|---|
| `CREATIVE_STUDIO_ENABLED=true` | Growth HQ web **and** SEO worker | Mounts the studio, routes, render and image jobs, and the enquiry route. Default off. |
| `SEO_BLOG_ENABLED=true` | both (existing) | The SEO area and worker loop. |
| `SEO_BLOG_IMAGE_API_KEY` | SEO worker (existing secret) | Image provider credential. Only the worker uses it. |
| `DATABASE_CONTENT_COMMAND_URL` | both (existing) | Role `r72_content_command`. |
| `DATABASE_CRM_COMMAND_URL` | web (existing) | Role `r72_crm_command`. Required for the enquiry route. |
| `SESSION_SECRET` | web (existing) | Signs enquiry form tokens. No new secret. |
| `CREATIVE_STUDIO_CHROMIUM` | optional | Explicit browser path. |
| `SEO_BLOG_WORKER_INTERVAL_MS` | worker, optional | Render latency (default 60000, minimum 15000). |

## 9. Setting image allowances

Both allowances below must permit a request, and a third (studio) allowance is added on top:

1. **Operator.** As the database owner role `r72_owner`, open the shared paid-image policy. It is closed by default. A config change must increment `version`; `model` and `quality` are fixed. Replace each `<…>` with an integer before running:

   ```sql
   SET ROLE r72_owner;
   UPDATE app_private.seo_image_operator_policy SET version=version+1,
     config=config||'{"enabled":true,"maxConcurrency":1,"perAttemptMicrousd":<hold per image>,"monthlyMicrousd":<monthly cap>}'::jsonb;
   ```

   - `perAttemptMicrousd` is held per attempt against the monthly cap, and shown to owners as an upper-bound hold, not a price.
   - To close it again, set `"enabled":false` with `version=version+1`.
   - This policy also governs article images, but only for brands that separately opted in to them.
2. **Brand image allowance** (owner): SEO Blog → brand → Publishing → images per month. It is shared with blog images and defaults to 0.
3. **Studio allowance** (owner): Creative studio → Generate a new image → Allowances. Tick the box and set images per UTC month. It defaults to off and 0. A writing (model-token) allowance never counts as an image allowance.

## 10. Cutover, acceptance and compatible recovery

**Cutover**

1. Deploy to all consumers with flags off (section 5).
2. Add the Chromium headless-shell build suffix to the SEO worker service's build command, the same as Growth HQ's.
3. Apply 0144 and confirm readiness.
4. Set `CREATIVE_STUDIO_ENABLED=true` on the worker, then on web.

**Acceptance, on one test brand**

1. Create artwork. The task page opens the result, and no request runs over its socket.
2. Draft a storyboard, render a video and play it.
3. Run the image test from section 7, only if authorised.
4. Switch the enquiry form on. Send one enquiry through a tracked link of an approved acquisition artwork, and check that the campaign results show 1 lead.
5. Move the lead to the mapped qualified stage, and check that it counts as qualified.

**Recovery (compatible, no data loss)**

- Unset `CREATIVE_STUDIO_ENABLED`. The studio, jobs and enquiry route stop. Queued studio jobs are blocked with "Nothing was requested or charged". No table is dropped.
- Close the operator policy (`enabled:false`) to stop paid images everywhere.
- Switch individual enquiry forms off in the studio.
- 0144 has no down-migration and needs none: older code ignores its tables. The readiness bridge only allows that exact pending file, so do not roll back to code older than the 0144-aware release after 0144 is applied unless that code is 0144-aware.
- Unknown provider outcomes stay held and counted. Resolve them through the existing 0137 `operator_resolution` path (`r72_owner`). Never re-send or claim a refund.

## 11. Remaining limitations and owner decisions

- **Live image test.** The live provider test and the production renderer revision (1228) are unproven here; see section 7.
- **Operator decisions:**
  - whether to open the operator policy, with which hold and monthly cap;
  - which brands get a studio allowance;
  - whether the SEO worker gets Chromium, and its tick interval.
- **Enquiry forms.** These need a privacy-notice link and the owner pasting the embed code on the tracked links' landing page.
  - Contact consent is stored as `unknown`; the form asks only for permission to reply, not for marketing consent.
  - The message is stored as the lead's follow-up task.
- **Attribution scope.**
  - Only leads through the brand enquiry form, or existing imported tags, are attributed.
  - Leads entered any other way are not counted.
  - There is no revenue, CAC, ROAS, subscription figure or "winner".
- **Studio gaps.**
  - The per-version edit form in Compare cannot yet swap in a generated image; use "Create artwork from this image".
  - References are limited to the brand's own generated images and article candidates, and at most 3.
- **Not activated:** publishing, paid ads, email outreach, automatic budget changes and scheduled automation. Apollo remains stopped and untouched.
