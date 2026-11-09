# Update for Codex: Creative Studio gaps closed, audited, ready for integration review

```
UPDATE: Creative Studio — the four gaps are closed, audited and packaged. Please review and integrate; do not merge or deploy without Martin.

Owner: Martin Howard
Repository: Martoon196/relaunch72
Work branch: claude/exciting-dirac-q38u2u
Final head: 4bd4bc92cfa531a8d7f3913365b2088a4cec2ceb (tree 4b17b053736e1c29819fa1781b8f2e5e0076b1f4)
Audited source: ce19e27794421bb9b24d6078329a2fe552620e7c (tree f9a78af33a5244bbce7dc97cfaea14261dc8e1f3)
  Every commit after ce19e27 touches only docs/, docs/evidence/ and the manual walkthrough script under orchestrator/test/.
  Check: `git diff --stat ce19e27 4bd4bc9 -- orchestrator/src` is empty.
Draft PR: https://github.com/Martoon196/relaunch72/pull/71 (against codex/relaunch72-platform-foundation; draft; not merged; nothing deployed)
Canonical merged in: 5895a02 (merge commit b6296aa) and b388f07 (merge commit 20e425d). No rebase, no force-push, shared history preserved.

READ FIRST
- docs/creative-studio-release.md — the release package (items 1–11 from your prompt).
- docs/creative-studio.md — feature detail; the last four sections cover the new work and its audit.
- docs/evidence/creative-studio-release/ — screenshots and walkthrough-summary.json (all labelled SYNTHETIC PROVIDER RESPONSE).

WHAT WAS BUILT (continuing the existing studio; nothing rebuilt, no new platform)

1. New images from a typed brief (the main requirement) — DONE, proven against a stubbed provider
   Path: pick brand → type the image brief → choose size (1024x1024 / 1536x1024 / 1024x1536) and up to 3 of the brand's own
   private images as references → review cost and allowances → tick and confirm ONE paid image → durable job with live
   progress (polling, survives refresh/restart) → stored private candidate → "Create artwork from this image" → branded
   variants via the existing compositor → exact-version approval → download / existing hand-offs.
   - Reuses the existing transport (seo-blog/image-generation.ts), credential SEO_BLOG_IMAGE_API_KEY, model gpt-image-2 at
     medium, and the whole 0137 paid-image admission: operator policy, global lock, per-attempt reservation, immutable
     attempts, receipts, private storage, holds. The article request body is byte-identical (pinned as a literal in tests).
   - Added to the transport: a size option; reference images via the documented edits endpoint (multipart image[]); a
     bounded read of a 400 body to recognise moderation_blocked (text never stored). No second provider, no fallback.
   - New 0144 section 5: creative_studio_briefs, creative_studio_generations (append-only, RLS), a studio branch in
     seo_image_reserve ahead of the unchanged article branch, a per-brand studio sub-allowance (settings.studioImages),
     and worker/owner definer functions. Studio generation defaults OFF with a ZERO allowance. A writing token ceiling is
     not an image allowance.
   - Brief and ad copy are separate. The prompt sends the brief text, the confirmed positioning (300 chars) and, if the
     owner ticks it, the active visual guidance — never offers, prices, claims, pages, contacts or credentials — and it
     forbids words, numbers, prices, logos, people, testimonials or claims in the picture.
   - Safety: exactly one provider call per admission; a refresh/double click/retry returns the same job; a second image for
     the same brief version needs an explicit new intent naming the previous one; unknown outcomes are held and counted
     until reconciled, never re-sent; missing usage is recorded as unknown, never zero; a changed operator policy holds the
     job until the owner requests again; two jobs racing for the last image → one admitted, one held (proved).

2. Durable background renders — DONE
   Create images, edit concept, refresh, focal move, draft storyboard, save storyboard, render video all record one
   `creative_render` job in the existing app.seo_blog_jobs table (keyed by the form's command id) and return at once with
   a task page that polls and opens the result. The existing SEO worker runs the same service methods. The 120 s socket
   timeout stop-gap is removed. Uploaded backgrounds are stored by the request and re-verified by the worker.
   - SQL (creative_studio_command worker branch): a worker acts only with the live claim (running, unexpired lease, same
     lease owner and attempt) of a creative_render job in the same workspace whose sponsor still manages the brand, for
     reads and version appends under that job's own command, and only to the set it was queued for (a draft may only
     create its set). Approval, hand-off and kit changes still need the owner's session.
   - Owner-correctable problems are refused at submit time; the same command id with different content is a 409;
     server faults retry once; a lapsed lease is left for the next claim (commands are idempotent, so a re-run replays).

3. Real campaign attribution — DONE, proven through the real capture path
   Each brand has an enquiry form: hosted at /enquire/<brand>/<key>, or embedded on the page its tracked links open.
   A submission creates the lead through the EXISTING crm.createLead (as the owner who switched the form on, like the
   Growth HQ inbox), in the brand's own pipeline. A campaign touch (new append-only table creative_studio_lead_touches)
   is stored ONLY when the untrusted UTM values exactly match a tracked link this brand issued for its own acquisition
   campaign (any channel it was handed off on). Malformed, unknown and cross-brand tags create the lead but no touch.
   - "Qualified" is read by the owner-mapped STAGE ID (or a later open stage of that pipeline, or won), never a slug.
     Without a mapping only won counts and the read says so. A brand with no CRM pipeline gets a standard "Enquiries"
     pipeline on first save (collision-safe slug); an existing default pipeline is used as-is.
   - Outcomes count only when they happen at/after the touch; an enquiry touch is judged by the opportunity it created.
   - Only the visitor's EMAIL is a CRM contact point (phone kept in the task text); the task text also records the
     contact-permission evidence (what was shown). consentStatus stays 'unknown' — this is permission to reply, not
     marketing consent.
   - Form safety: HMAC token (1 h) bound to brand, key AND the exact tags; honeypot; consent tick (server-checked);
     50/hour per brand enforced in the DATABASE under the capture row lock; 16 KiB body; strict CSP; hosted form cannot
     be framed; embed form may be framed only by the brand's own site and its confirmed conversion-page hosts; owner can
     rotate the form address; no personal data in any URL. Affiliate attribution tables untouched.

4. Canonical integration and migrations — DONE
   - The studio migration is 0144_creative_studio_library.sql (renumbered from the colliding 0143; never applied as 0143).
     sha256 175ab07846ded391e5fc36bf39d1bd1fd64f905e210508daf39f837ed15e2fe3, pinned as CREATIVE_STUDIO_CHECKSUM in
     orchestrator/src/db/creative-studio-schema.ts. It is UNAPPLIED. Migrations 0001–0143 are byte-identical to canonical
     (`git diff --name-status origin/codex/relaunch72-platform-foundation 4bd4bc9 -- orchestrator/src/db/migrations`
     shows only A 0144). Canonical's 0143_mhp_whatsapp_direct_inbox.sql is kept (69eae7f9…bc42e).
   - 0144 is additive (tables, functions, grants, policies) and replaces four functions in place: seo_image_reserve
     (studio branch before the unchanged article branch), seo_image_apply_hold (studio branch), seo_creator_command and
     seo_method_save_receipt (acquisition kind lists only, Milestone 2).
   - runtime-readiness.ts accepts exactly one pending migration only when the bundle has 144 files, file 144 is 0144 with
     the pinned checksum, and 0142 payments + 0143 direct WhatsApp inbox are applied with their exact checksums (same
     pattern as the 0142/0143 bridges). MHP payment, WhatsApp and inbox behaviour preserved (their PG proofs are green).
   - Apollo untouched: PR58 not integrated or resumed, no automation restarted, nothing renumbered.

AUDIT (second pass, after the build)
Six independent reviews (SQL security of 0144 §5–6; typed-brief generation code; durable render path; enquiry capture;
routes/views/docs accuracy; test quality) raised 73 findings. Each was re-verified against the code; every confirmed one
is fixed in ce19e27, the rest are recorded under "Accepted" in docs/creative-studio.md. Headline fixes:
- Enquiry form could re-attribute an existing customer's earlier sale to a campaign (outcomes now time-ordered and judged
  by the enquiry's own opportunity; proved with a real won opportunity).
- A phone contact point let a visitor attach their email to someone else's CRM record (email only now).
- Hourly cap was read-then-compare (now a DB admission under lock; proved with seeded admissions).
- Touches dropped for a concept handed off on several channels (any issued link on any channel now qualifies; proved).
- Render workers could write to any set of the brand (now bound to the queued operation; proved).
- Same command id with changed content silently "Saved" (now 409); invalid render requests failed minutes later (now at submit).
- Image worker: unexpected throws contained; storage read-back and recording retried safely without a second call;
  refused vs unconfirmed reservations distinguished; every SQL hold reason has owner text; 401/403/429 refusals read by
  meaning; prompt uses confirmed `positioning` not the free-text `summary`; over-long brief refused up front; generated
  image lookups by id (no 60-row window); estimate counts unresolved earlier-month attempts as admission does and no longer
  calls the reservation an "upper bound".
Accepted, not changed: archived/deleted-contact oracle via 200/503 for a known email; each enquiry creates permanent CRM
records (bounded by cap+honeypot, no per-IP throttle); lead activities attributed to the capture owner as user actor (as
GHQ inbox); the record step re-checks claim+sponsor but not policy when pixels already exist; soft-deleted contacts keep
touch rows (reader excludes them); edits request does not send moderation/safety_identifier (unverified for that endpoint);
deleting a mapped CRM stage fails until remapped.

RECEIPTS (source ce19e27; PG receipts run at 61dbfa0, same orchestrator/src)
- Typecheck clean. Supply-chain gate: 117 packages, SBOM current.
- npm test: 4365 tests, 4297 pass, 0 fail, 68 skipped (DB tests, run separately below).
- Fresh dedicated disposable cluster (r72proof, port 5433, never `main`), real least-privilege roles, genuine owner sessions:
  creative-studio-pg 8/0, video-pg 4/0, distribution-pg 5/0, learning-pg 4/0, generation-pg 10/0,
  render-jobs-pg 7/0 (real headless Chromium), enquiry-pg 8/0, acquisition-campaign-pg 5/0,
  seo-blog-media-storage 2/0, seo-blog-media-engine 1/0, group-hq-inbox-crm 1/0, mhp-wa-direct-inbox 1/0,
  mhp-event-whatsapp 2 pass / 1 FAIL.
- That one failure (subtest "MHP009C WhatsApp follow-up …", 'Expected PostgreSQL error 23503') fails IDENTICALLY on
  canonical b388f07 alone in a clean worktree with 143 migrations and no 0144. Pre-existing; untouched; for the MHP owner.
- Browser walkthrough (production portal + worker compositions on a disposable DB, Chromium): render request 0.35 s;
  worker recorded and playback-checked a 1080×1920, 10.5 s MP4 in ~15 s and it played; one synthetic provider call,
  one usage debit; enquiry created 1 contact + 1 opportunity and no touch (its tags matched no issued link); no console
  errors. Every screenshot carries "PROOF RUN · SYNTHETIC PROVIDER RESPONSE · no paid request was made".

NOT DONE HERE (honest gaps)
- No live provider call. No authorised allowance/credential existed in the build environment. The pictures in the evidence
  are synthetic gradients from a stubbed endpoint, not provider output. Smallest real test: one brand, operator policy open
  with maxConcurrency 1, studio allowance 1, brand image allowance ≥1, ONE 1024x1024 medium image from a short brief with
  no references. Expected cost: a few US cents of output-image tokens; read the stored usage on the attempt rather than
  estimating (published per-token rates conflict). Acceptance: one attempt row candidate_received with usage, one
  generation row, image visible on the brief page, artwork created from it.
- Official API docs were unreachable from the build environment; sizes, quality levels, the edits endpoint and the refusal
  code were confirmed from search snippets only. Whether images/edits accepts moderation/safety_identifier is unverified.
- Production Chromium revision not run. Local proofs used /opt/pw-browsers/chromium_headless_shell-1243 (Chrome for
  Testing 153). playwright-core 1.61.1 pins headless-shell revision 1228 (Chromium 149.0.7827.55); its download was
  blocked here. findCreativeChromium covers the .playwright-browsers/chromium_headless_shell-*/chrome-headless-shell-linux64
  path. Verify in production: build log shows the install line; worker logs "creative-studio-v1 … renderer found"; one
  render task and one video task finish and the video plays.
- Quality is not owner-selectable: the 0137 operator policy fixes model and quality platform-wide (existing rule); owners
  choose size and references.
- The per-version edit form on the Compare page cannot swap in a generated image; the new-artwork form can.

ROLLOUT REQUIREMENTS (all consumers)
1. Deploy this release to EVERY service that runs readiness (Growth HQ web, relaunch72-seo-blog-worker, any other
   consumer of the same DB) with CREATIVE_STUDIO_ENABLED unset. Not during an unfinished 0142/0143 cutover.
2. Add the Chromium headless-shell build suffix to the SEO worker service's build command (same as Growth HQ's):
   `&& (PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers npx --no-install playwright-core install --only-shell chromium || echo '…renderer stays off')`.
   That service is configured in the Render dashboard, not in repository manifests.
3. Apply 0144 with the normal migration runner (seconds; lock_timeout 5s, statement_timeout 60s). Readiness then reports
   no pending migrations everywhere.
4. Set CREATIVE_STUDIO_ENABLED=true on the worker, then on web.
Flags / credential NAMES (never values): CREATIVE_STUDIO_ENABLED (web+worker); SEO_BLOG_ENABLED (both, existing);
SEO_BLOG_IMAGE_API_KEY (worker makes the call; web reads only that it is present to show "provider configured", as for
article images — without it the Generate button is disabled); DATABASE_CONTENT_COMMAND_URL (both, r72_content_command);
DATABASE_CRM_COMMAND_URL (web, r72_crm_command; required for the /enquire route); SESSION_SECRET (web; signs enquiry
tokens; no new secret); CREATIVE_STUDIO_CHROMIUM (optional explicit browser path); SEO_BLOG_WORKER_INTERVAL_MS
(render latency, default 60000, min 15000). The /enquire route and the embed/hosted links need the portal's configured
public base URL.

OWNER/OPERATOR STEPS FOR IMAGE ALLOWANCES
1. Operator (DB role r72_owner only): the shared paid-image policy is closed by default. A config change must bump
   version; model/quality are fixed; limits are integers:
   SET ROLE r72_owner;
   UPDATE app_private.seo_image_operator_policy SET version=version+1,
     config=config||'{"enabled":true,"maxConcurrency":1,"perAttemptMicrousd":<hold per image>,"monthlyMicrousd":<monthly cap>}'::jsonb;
   perAttemptMicrousd is a fixed reservation per attempt against the monthly cap; it is not the charge and does not cap it.
   Close again with "enabled":false and version=version+1. This policy also governs article images for brands that opted in.
2. Owner: SEO Blog → brand → Publishing → brand image allowance (imagesPerMonth; shared with blog images; default 0).
3. Owner: Creative studio → Generate a new image → Allowances → tick "Allow paid images from typed briefs", set images
   per UTC month (default off/0).
4. Owner (attribution): Creative studio → Enquiry form → choose first stage and the "qualified" stage, add the https
   privacy-notice link, tick "Accept enquiries", Save; paste the embed code on the page the tracked links open (or use the
   hosted link).

RECOVERY (compatible, no data loss)
- Unset CREATIVE_STUDIO_ENABLED: studio, jobs and /enquire stop; queued studio jobs block with "Nothing was requested or
  charged". No table is dropped. Close the operator policy to stop paid images everywhere. Switch individual enquiry
  forms off in the studio.
- 0144 has no down-migration and needs none: older code ignores its tables. After 0144 is applied, do not roll back to
  code that is not 0144-aware (the bridge only allows that exact pending file).
- Unknown provider outcomes stay held and counted; resolve through the existing 0137 operator_resolution path (r72_owner).
  Never re-send; never claim a refund.

WHAT I'D LIKE FROM YOU (Codex)
1. Review PR #71 against the current canonical head; if canonical has moved again, tell us and we'll merge it in (merge,
   never rebase).
2. Confirm the all-consumer rollout order above fits your release process, and whether the SEO worker service can take
   the Chromium build suffix.
3. Decide with Martin: open the operator policy (hold and monthly cap)? which brands get a studio allowance? run the one
   live image test? which brands switch the enquiry form on?
4. Triage the pre-existing mhp-event-whatsapp MHP009C failure with the MHP owner (it is not from this branch).
5. Do not merge or deploy without Martin. Do not activate publishing, paid ads, outreach, budget automation or schedules.
```
