# Creative Studio — Milestones 1–5 (brand-aware creative; campaign intelligence; video and rich media; distribution and attribution; learning)

**Status, stated separately:**

| | State |
|---|---|
| Source complete (Milestone 1 scope below) | Yes — branch `claude/exciting-dirac-q38u2u`, based on canonical `codex/relaunch72-platform-foundation` @ `6151fa5` (includes the 0142 payments integration). |
| Integrated with canonical foundation | Not yet. Ready for the release owner to integrate; no conflicting files with the 0142 payments work except the readiness bridge (see Release). |
| Deployed | **No.** |
| Verified live | **No.** No provider call, credential, publishing or spend was used or is needed for this milestone. |

The studio is a **Creative studio** tab in the existing multi-brand SEO area (`/portal/seo-blog/b/<brand>/creative`), off by default (`CREATIVE_STUDIO_ENABLED`). It produces finished, stored, downloadable artwork for any programme brand from that brand's confirmed Brand Brain, with exact-version approvals. Nothing is published, scheduled, sent or spent.

## 1. Reuse check

| Capability | Existing implementation | Proven status (before this work) | Missing | Extension made |
|---|---|---|---|---|
| Multi-brand Brand Brain | `seo-blog` brands, confirmed `BrandProfile` (offers, prices *as written*, approved claims, exclusions, conversion pages, `factsSha`), knowledge incl. `visual_guidance` (0131); `app_private.seo_creator_profile` (0139) | Engine + PG proofs | Nothing turned it into creative rules (colours, logo, disclosures) | `creative-studio/brand-context.ts` resolves per brand; owner-confirmed **creative kit** versions (0144). Reuses `seo_creator_profile` in SQL. |
| Image Studio UI | `portal/image-studio-*` | Read-only, **Property Predator-hardcoded**, generation locked, "command boundary absent" | Not generic; cannot produce an image | Left untouched (PP-specific). Generic studio added to the multi-brand area instead. |
| Paid image generation | `seo-blog/image-generation|intent|jobs|worker|service-pg` + 0137 ledger (admission, reservations, nonce, receipts, uncertain outcomes) | Code + disposable-PG proofs; operator policy default **disabled / zero**; **article-bound** (`seo_image_source(article)`), fixed `gpt-image-2` 1536×1024; the stored worker downgrades `prepared` to held `apply_unavailable`; no live run on record | Cannot admit a non-article brief | **Reused, not modified**: receipted candidates from this pipeline are offered as backgrounds with provenance (intent, attempt, candidate SHA). No new paid path was added (see §7). |
| JPEG handling | `seo-blog/jpeg-preparation.ts` | Tested | No text/logo compositing | Additive `decodeVerifiedJpeg` export reuses its hardened header/orientation checks for every input image. |
| Private storage | `app.seo_blog_blobs` (workspace RLS) | Live schema | — | Stores artwork and logo bytes; SQL verifies each digest. |
| Approvals | company-content approvals, SEO media quality reviews, creator approvals | Existing | No exact approval for a creative image version | 0144 approvals bound to exact render SHA + profile version + facts digest + kit version. |
| Distribution | Article campaigns, social uses (0137), Zernio calendar | Owner-gated | Hand-off of finished artwork | Milestone 4: exact-size approved images enter the article's existing private images; everything after that is the existing owner-gated path (see Milestone 4 below). |
| Method packs | 0.1.1 packs incl. `visual-briefing` (0138–0140) | Private authoring approved | Not used for raster artwork | Unchanged. Milestone 2 feeds them into model-written hooks/copy. |
| Ads connectors | `src/ads/meta.ts` | Interface only, unproven | — | Untouched. No ad activation exists here. |

## 2. What was implemented

- **Brand resolution** (`brand-context.ts`): profile is usable only if confirmed, conflict-free and bound to exactly the active knowledge (mirrors the SQL rule). Essential gaps (unconfirmed profile, unknown offer, missing/unapproved destination for adverts, article image without an article) **block** drafting with a plain explanation. Decorative gaps use a **labelled** neutral palette and a plain-text brand name instead of a logo. Colours found in visual guidance are shown as suggestions, never applied without confirmation.
- **Concepts** (`concepts.ts`): up to three distinct angles (offer-, approved-claim-, positioning-, article-, takeaway-, brief-led) drafted deterministically from approved facts only — no model call. The exact stored price is used only where one exists and never on organic posts. Fewer facts produce fewer concepts with an explanation. Figures not in approved facts are flagged and need explicit confirmation at approval; restricted wording (profile exclusions + kit) blocks approval. Coordinated carousel cards; the last card carries the CTA.
- **Deterministic compositor** (`renderer.ts`): HTML/CSS laid out and rasterised by an offline headless Chromium (all requests aborted except in-memory, verified bytes on a private pseudo-origin; no page scripts). Vendored Inter (SIL OFL 1.1, `fonts/INTER-OFL.txt`). The approved logo file is placed unchanged; text, prices and disclosures are real typography. Five placements with safe areas (square 1080², portrait 1080×1350, vertical 1080×1920, landscape 1200×628, article 1600×900), focal-point cover crops, headline fitting, and **measured WCAG contrast** on the actual pixels under each text box with an adaptive scrim. Overflow and low contrast are reported as blocking issues — never silently clipped. Generated scenes carry a default "Illustrative image" marker. One browser per batch, one batch at a time per process.
- **Versioned library** (`store.ts`, `pg-store.ts`, migration **0144**): append-only sets, versions, approvals, hand-offs and idempotent commands. Concept edits re-render only that concept (component digests show unchanged parts); focal edits re-render one format; stale head lists are refused. Approval = one exact image; it never approves captions, campaigns, schedules or paid ads. Kit or brand-fact changes make approvals stale; **Refresh from current brand** re-renders and re-approval is required. Downloads are the exact stored bytes, digest-verified, labelled `-approved` only for a currently usable approval.
- **UI** (`portal/creative-studio-view.ts`): Create images → Compare (concepts side by side per format) → Edit → Approve → Download / Add to campaign. Kit editor with logo upload. Works at phone width.
- **Composition** (`portal/creative-studio-composition.ts`, `seo-blog-service.ts`, `seo-blog-router.ts`): mounted only when enabled; same CSRF/same-origin/session rules as the rest of the area.

## 3. How to open and use it

1. Set `CREATIVE_STUDIO_ENABLED=true` (after 0144 is applied) on the Growth HQ service.
2. Open **SEO Blog → choose a brand → Creative studio**.
3. **Edit creative kit**: colours, the approved logo (PNG/JPEG; SVG refused), required disclosure, restricted wording.
4. **Create images**: purpose, source (approved offer / article / short brief), audience, approved destination, formats, number of concepts, background (brand colours, an uploaded approved image, or an image already generated by the article image pipeline).
5. **Compare**, **Edit concept** or **Move focal point**, then **Approve this image** (confirm any flagged figures), then **Download** or **Add to campaign**.

## 4. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CREATIVE_STUDIO_ENABLED` | off | Mounts the tab and routes. |
| `CREATIVE_STUDIO_CHROMIUM` | — | Optional explicit browser binary. Otherwise `.playwright-browsers/` (installed by the Growth HQ build step) or `/opt/pw-browsers` is discovered. Without a browser the studio states that the renderer is unavailable and produces nothing. |

Growth HQ build (owner-approved, reviewable in its own commit): after the unchanged npm integrity gate, typecheck and tests, a **non-fatal** step installs Playwright's pinned headless shell into the project directory. It downloads from Playwright's CDN, so the npm SBOM gate does not cover it; the supply-chain policy test allows exactly this suffix on this one service only.

## 5. Checks performed (exact source)

- `npm run typecheck` — clean.
- Full offline suite `npm test`: 4,249 tests — 4,188 pass, 60 skipped (opt-in real-database files), 1 failure found and fixed (new definer role added to the disposable-reset allowlist); the DB test files were rerun: 625 pass, 0 fail.
- `test/creative-studio.test.ts` (10): image verification; per-brand resolution with no cross-brand or Property Predator leakage; honest drafting; idempotent commands; component-level edits; exact approvals; stale invalidation; isolation; saved-image provenance; escaped markup reaching only the private origin; **real Chromium** output (exact dimensions, real logo pixels, measured contrast, overflow and low-contrast detection, headline-only card regression).
- `test/db/creative-studio-pg.integration.test.ts` (7 subtests) on disposable **PostgreSQL 16** (CI uses 18) after applying all 143 migrations, as the real `r72_content_command` role with genuine owner sessions: tenant isolation at the SQL boundary (including a genuine session aimed at another workspace), no direct table privilege, command replay without re-rendering, conflicting replay refused, superseded versions not approvable, kit and profile-fact changes enforced by SQL, cross-brand hand-off refused, append-only rows, forged digests refused, no jobs or deliveries created.
- Readiness: `creative144` (exact MHP 0143 ledger + only 0144 pending; never during the 0142 or 0143 cut-overs) and the unchanged `payments142` semantics against the 142-file bundle.
- Visual: `test/manual-creative-studio-demo.ts` drives the real forms in Chromium for two fictional brands; screenshots and exact artwork in `docs/creative-studio-evidence/` were inspected. The inspection found and fixed a false "does not fit" on headline-only carousel cards.

All example brands, logos and backgrounds are **synthetic fixtures** (procedurally drawn, not provider output, not real businesses).

## 6. Release and recovery (release owner)

Prerequisite: the 0142 payments cut-over is complete and verified, and its production reservation is released by its owner. This release must not be deployed during that reservation; its readiness gate only accepts an exactly-applied 0142.

1. Integrate onto the then-current canonical tip; if new migrations landed, renumber 0144 and update its checksum pins (readiness, SQL contract).
2. Exact-source CI: typecheck, full suite, disposable PG: `node --import tsx scripts/rl72-boosters-pg-bootstrap.mjs`, then `node --import tsx --test test/db/creative-studio-pg.integration.test.ts`.
3. Deploy that exact source to **every** strict schema consumer with `CREATIVE_STUDIO_ENABLED` unset; verify `/ready` on each (not `/health`).
4. Apply 0144 with the migrator connection; `npm run db:check`; verify `/ready` again.
5. Check the Growth HQ build log for the headless-shell install line (or the "renderer stays off" line).
6. Set `CREATIVE_STUDIO_ENABLED=true` on Growth HQ only; owner walkthrough on one owned brand.

Recovery: set `CREATIVE_STUDIO_ENABLED=false` (routes unmount immediately). Keep a 0144-capable release: earlier releases' strict readiness refuses an applied 0144. Never delete the additive tables or recorded approvals.

## 7. Not in this milestone (honest gaps)

- **New paid generation from a free-text brief.** The existing durable paid ledger admits only article sources. Extending it means changing reviewed SQL admission functions shared by every brand (`seo_image_reserve` and its source checks) and the fixed 1536×1024 request; that needs its own reviewed change and an owner-set operator policy and brand image allowance. Today: generate through an article's Campaign page (existing allowance), then reuse the saved image here.
- **Live provider proof.** The image policy is disabled with zero headroom and no image credential is configured. The single remaining live proof: one owner-authorised article image intent within an explicitly set allowance (the reviewed request is one `gpt-image-2` medium 1536×1024 image), then reuse it in the studio.
- Image editing with a provider, brand-supplied font files, campaign media-use authorisation and delivery (Milestone 4).

---

# Milestone 2 — Campaign intelligence and assembly

**Status:** source complete on the same branch; not deployed; not verified live. Generation uses the brand's existing writing allowance through the reviewed creator boundary; no live model run was made here (deterministic fixture model only).

## Reuse check

| Capability | Existing implementation | Proven status | Missing | Extension made |
|---|---|---|---|---|
| Saved research | `TopicPlan.sources`: dated, bounded passages with primary/confidence flags | Live engine + tests | Never used for campaign planning | `seo-blog/acquisition-evidence.ts` builds a bounded evidence pack (accepted plans first, deduplicated, ≤6 sources) with no new search or fetch |
| Audience language | Knowledge `audience_notes` / `faqs` bound to the confirmed profile | Live | Not used for objections | Included as owner facts (`knowledge:<id>:<version>`) only when bound to the confirmed profile |
| Evidence-checked writing | Method packs 0.1.1 + `validateMethodEvidence` (claim ledger, numbers present in evidence, source freshness, three distinct hook options, proof decision) | Reviewed, PG-proven | No acquisition output | Reused unchanged through existing pack stages `copy` + `social` (conversion-copy, social-repurposing, production-core). Pack releases and hashes untouched |
| Model-backed drafting with allowance | Campaign creators (0139): atomic reservation, receipts, held/unknown recovery, exact approvals, export | PG-proven | Email/advocacy only | Third creator kind `acquisition` (Hook & Close pack). SQL: 0144 adds the kind to the table check and to `seo_creator_command` / `seo_method_save_receipt` — the 0139 bodies verbatim apart from those lists |
| Creative assets | Milestone 1 studio | This branch | Not linked to campaigns | Each concept links to the studio with its copy, audience and destination pre-filled (one concept) |

## What a proposal contains

Objective and primary metric; 3–9 audience **insights** (problem / objection / opportunity), each citing supplied evidence IDs and marked *observed* only when backed by research, audience guidance or an article (otherwise *inferred*); channel roles limited to the owner's selection; 1–3 distinct **concepts** (angle, hook, headline, primary text, the exact approved destination, channels, insights addressed, illustrative creative direction); **UTM-tracked links** per concept and channel (`utm_campaign=<name>-<id>`, `utm_content=concept-n`); a **measurement plan** (metrics, review interval, learning rule, attribution limits); **predictions** labelled as hypotheses; and an **Actual results** section that states none are recorded.

## Guards (enforced on generation, owner edits and approval)

- Evidence IDs must be from the supplied pack; observed vs inferred is checked; evidence is server-built and a browser-supplied pack is discarded.
- Channels limited to the owner's selection; every concept uses the exact approved destination; concepts and hooks must be distinct.
- No commercial commitments (refunds, guarantees, discounts, trials, warranties, "% off", price promises) unless already in approved offers or claims; existing figure guard still applies.
- Predictions and measurement contain no numbers, rates, costs or returns; nothing may claim results were achieved; no competitor spend.
- A model output that breaks these is held, not shown as a draft. Replays and recovery never call the model or charge again.

## Checks

- `test/acquisition-campaign.test.ts` (8): evidence pack bounds and bound-guidance rule; one reserved run, forged evidence replaced, idempotent replay; pack/channel/destination/article gates; every guard; invented-guarantee output held; edit/approve/export with predictions separate from absent results; UTM identities; routes and review page.
- `test/db/acquisition-campaign-pg.integration.test.ts` (4) on fresh disposable PostgreSQL 16 after 143 migrations, real runtime role: exact `acquisition` receipt, single usage charge, reservation released, evidence stored with the brief, replay/recovery charge nothing, SQL refuses an acquisition start without the conversion-copy pin, kind constraint admits only the new kind. The existing creators and creative-studio PG proofs pass unchanged alongside it (26/26 total).
- Visual: `test/manual-acquisition-demo.ts` (fictional brand, fixture model) — `docs/creative-studio-evidence/m2-*.png`.

## Use

Production rules → ensure **Hook & Close** is on → Campaign creators → **Acquisition campaign**: objective, audience, offer, approved destination, channels, concepts, supporting articles → review insights and evidence, edit concept copy → approve → export (JSON or text). Use **Create artwork for this concept** to produce its images in the studio.

## Not in this milestone

- New research is not started from the proposal; it uses research already saved. Run topic research first if the evidence gaps say so.
- Predictions are qualitative by design. Measured outcomes (leads, bookings, sales) arrive with Milestone 4 (distribution and attribution via existing CRM/LeadRelay contracts).
- Release: unchanged from Milestone 1 (single additive 0144, after the 0142 cut-over). Note an unmerged, stopped Apollo branch also claims a `0144_` filename; renumber whichever lands second.

---

# Milestone 3 — Video and rich media

**Status:** source complete on the same branch; not deployed; not verified live. Everything renders locally: no video, avatar or voice provider, no provider call and no charge.

## Reuse check

| Capability | Existing implementation | Proven status | Missing | Extension made |
|---|---|---|---|---|
| Video in the codebase | Posting client accepts `video/mp4`, `video/webm` (`zernio-posting-client.ts`); no producer | Contract only | No way to make a video | Videos produced here use those exact types for the Milestone 4 hand-off |
| Renderer | Milestone 1 Chromium compositor with measured contrast | This branch | Stills only | Optional transparent overlay capture of the exact measured layout; contact-sheet and video rendering in the same offline session |
| Encoding | Pinned headless Chromium's built-in MediaRecorder | Probed here: H.264 High MP4 and WebM supported | Recorder writes fragmented MP4 | `mp4-remux.ts`: lossless rewrite to a standard index-first ("fast start") MP4; all 325 decoded frames proved pixel-identical with ffmpeg in development |
| Versioning / approvals | Milestone 1 library (0144) | PG-proven | Single media type | `storyboard` and `video` media kinds as separate lineages per concept and format, reusing lineage, stale-context and approval rules |

## Behaviour

- **Storyboard** (Draft a storyboard): scenes drafted only from the concept's own copy (opening, supporting line, end card with the real button; carousel cards become scenes). Rendered as real frames on a contact sheet captioned with timing, motion and voiceover *script*, labelled **STORYBOARD — NOT A VIDEO**. Never approvable (service, memory store and SQL all refuse).
- **Scene-level revision**: edit on-screen text, supporting line, duration (1.5–8 s), motion (zoom/pan/still), button and script per scene; add or remove scenes; ≤30 s total. Each save is a new storyboard version recording exactly what changed; unchanged scenes keep their exact content.
- **Render video** from the current storyboard version only: each scene's measured overlay layer (scrim, real text, real logo, disclosure, illustrative marker) is animated over the background with gentle motion and crossfades, recorded to H.264 MP4 (WebM fallback), rewritten to fast-start MP4, then **independently played back** in a fresh page (dimensions, a decodable non-blank frame, full play-through length). Only then is it shown as a playable video; a failed check is a blocking issue.
- A video version records the exact storyboard version and spec digest it came from; SQL refuses a video without that exact provenance or with non-video bytes.
- **Estimate** shown before rendering: duration, approximate render time on this server, no provider call or charge. Videos are silent with on-screen text.
- **People and endorsements**: no avatar or voice generation. Uploaded imagery needs an explicit permission confirmation for any identifiable person before it can be used in video. Customer quotes with attribution, star ratings and "reviews/testimonials" copy are blocking issues.
- Brand-kit or fact changes make storyboards unrenderable until saved again and existing video approvals stale, as for images.

## Checks

- `test/creative-studio-video.test.ts` (7): scene drafting and limits; endorsement detection; storyboard → edit → video lineage; storyboard never approvable; replay never re-renders; concept edits leave videos and approvals intact; unplayable output, endorsement copy, stale context and missing likeness permission refused; forged provenance refused; **real Chromium** recording (container signature, playback-measured length, fast-start box order, digest); remux refusal paths.
- `test/db/creative-studio-video-pg.integration.test.ts` on fresh disposable PostgreSQL 16 after 143 migrations, real runtime role: storyboard key and SQL approval refusal; video stored as `video/mp4` under its own key and approvable; forged storyboard reference and image bytes posing as video refused. All four integration files together: 30/30.
- Visual: `test/manual-video-demo.ts` through the real forms (kit → artwork → storyboard → scene edit → render → approve): H.264 High 1080×1920, 10.97 s against 11.0 s planned, rendered in ~15 s. Evidence: `docs/creative-studio-evidence/m3-*`.

## Remaining proof and limits

- MP4 recording was proven on this container's newer headless build (Chromium 153). The production build pinned by `playwright-core@1.61.1` (headless shell 1228) could not be downloaded here because the session's network policy blocks `cdn.playwright.dev`. If that build lacks H.264 recording, the renderer automatically produces WebM (accepted by the existing posting contract) and still enforces the playback check; confirm on the first Growth HQ build.
- The browser recorder produces variable frame timing; platforms requiring constant frame rate or audio tracks are not addressed. No music, voice or captions file is produced.
- Brand font files, provider image-to-video and avatar/voice providers are intentionally not added: no permissioned use case or credentials exist yet.

---

# Audit of Milestones 1–3 (before Milestone 4)

An independent review of the whole diff (eight angles: line-by-line, removed behaviour, cross-file, reuse, simplification, efficiency, altitude, conventions) produced 20 findings. All were addressed except two recorded as deliberate:

| Finding | Fix |
|---|---|
| Portal server drops idle sockets after 30 s; a video render records in real time | Creative render requests (draft, concept, refresh, storyboard, scenes, video) extend their own socket timeout to 120 s. Recorded as a bounded stop-gap: the durable fix is a job + status polling like article images (see Remaining). |
| MP4 remux wrote the version-1 `tkhd` duration at the wrong offset | Corrected to +24; a synthetic fragmented-MP4 test now parses mvhd/tkhd/mdhd/stts from the output; the real-Chromium test checks header durations against the timeline. |
| Zero default sample duration would produce a 0-length MP4 | Remux refuses and the recorded bytes are kept as-is. |
| Playback check could outlive the page timeout and throw a generic error | Session timeout 90 s, check waits bounded, evaluation failures become an honest "failed playback check". |
| Owner goal containing a number (e.g. "Fill 10 slots") made every proposal fail the no-invented-numbers guard | Guard now covers hypotheses and the measurement plan (and the primary metric), not the owner's restated goal; claimed results in the goal are still refused. |
| Command hash included the server-derived evidence pack, so an identical resubmission after new research was refused | Hash covers owner inputs only. |
| A stale storyboard with unchanged scenes could never be refreshed | Saving an unchanged storyboard after a brand/kit change re-renders it as "refreshed from current brand context". |
| Focal-point edit accepted storyboard/video ids | Refused as not found. |
| `renderVideo` assumed overlays exist | Clear error when a renderer cannot capture the overlay layer. |
| Empty contrast map stored `Infinity` | Defaults to 21:1 when a frame has no measured text. |
| Storyboard/video commands checked replay before authorisation | Authorisation first, like every other command. |
| Artwork URL extension not checked against the stored media type | 404 on mismatch. |
| Fonts re-read from disk per render; two or three Chromium launches per storyboard/video | Fonts cached per process; one browser session renders frames and then the sheet or the recording. |
| View duplicated the render-estimate formula | Shared `videoEstimate`. |
| Dead corpus expression; unused parameter | Removed. |
| Superseded topic plans still fed research | Excluded with rejected plans. |
| Missing header-duration test | Added (above). |
| Reuse `canonicalCompanyContentJson` | Not changed: it throws on `undefined` values, while the studio's canonicaliser must drop undefined optional fields (e.g. `media`) so digests stay stable; the two are not interchangeable. |
| Altitude: long renders held in a request | Recorded; see Remaining. |

Remaining from the audit: move storyboard/video rendering behind a durable job with status polling (the SEO article-image pattern) so a deploy or restart mid-render leaves an honest "unknown" record rather than a dropped request. Until then renders are bounded to 30 s of video and the request's own 120 s socket limit.

# Milestone 4 — Distribution and attribution

Approved creative now reaches the **existing** integrations, and the studio reports what actually happened from the
**existing** records. Nothing new publishes, schedules, sends, spends or stores leads.

## Reuse check

| Need | Existing piece found | What it can do | Used how |
| --- | --- | --- | --- |
| Social and website hand-off | Article media path (`seo-blog/media-review.ts`, 0137): owner upload → exact JPEG preparation → quality review → hero/social use authorisation → post approval (company-content approvals) → posting plan (`campaign-queue.ts`) → connected Zernio calendar job | Owner-gated, capped, waits for the blog to be confirmed live | Approved **portrait / landscape / article** images enter it unchanged in size as the Instagram / LinkedIn / blog format. Every later step is the existing one, untouched. |
| Campaign hand-off | Acquisition proposals (Milestone 2) with tracked links | Export only; there is no delivery integration for them | Hand-off issues a link tagged with the campaign **and** the exact artwork version. |
| Delivery states | `seo_blog_media_commands` (authorise / materialise receipts), `property_predator_owned_social_jobs` and `_receipts` (`accepted`, `published`, `failed`, `outcome_unknown`) | Recorded by the existing calendar worker | Read-only SQL view per posting plan. |
| CRM and lead linkage | `app.contacts`, `contact_attribution_facts` and `contact_import_attribution_facts` (both already have `utm_*` columns), opportunities and pipeline stages, `conversion_milestone_facts` (`appointment`, `sale`), `conversion_commerce_facts` (`payment_collected`, `subscription_cancelled`) | Workspace-scoped; the journey board already reads the same attribution tables | Read-only, per-brand counts by exact `utm_campaign` / `utm_content`. **No second lead store.** |
| LeadRelay | `integrations/leadrelay` is a control proxy (no inbound outcomes). The unmerged `codex/leadrelay-campaign-stop-relay` maps `sales.appointment.booked` → `meeting.booked` and `commerce.purchase.completed` → `purchase.confirmed` | Default-off stop relay; no qualification event in the canonical catalogue | Outcome meanings match those contracts (booking = appointment milestone; sale = payment). No follow-up engine is added or triggered. |
| Paid ads | `src/ads/meta.ts` (paused campaign shell only, legacy run pipeline) | Never un-pauses; no creative upload | Listed per platform; nothing is called. Google, LinkedIn and TikTok Ads have no connector. |

## Behaviour

- **Hand off** (on any approved image or video) offers this brand's articles and its acquisition proposals' concept × channel pairs. The route is chosen from the asset, not the owner's wording:
  - `article_media` — exact-size image → the article's private images, labelled *From Creative Studio*, with no crop control (re-cropping would cut the text). The candidate is the approved bytes; SQL re-checks the candidate digest, the `creative-studio-<version>.jpg` provenance, the prepared profile and the variant digest before recording the hand-off.
  - `tracked_link` — `utm_content=concept-<n>-cs<first 8 hex of the version id>` plus the proposal's `utm_campaign`; SQL checks both tags are in the URL and belong to this campaign and version.
  - `export_only` — square, vertical and video for articles (no matching format; never cropped).
- **Distribution and results** (bottom of each set) shows a ladder per hand-off and per post: *handed off → queued → provider accepted → published → delivered → lead → customer*. Each status is *reached* only when its own record exists; *failed*, *not recorded*, *not applicable* and *stopped* are shown as such and never upgraded. Delivered applies to messages only, so it is *not applicable* for social posts and *not recorded* for exported email.
- Article posts link to the exact reviewed blog URL (enforced by the existing campaign), so leads cannot be attributed to that artwork — the ladder says so instead of guessing.
- **Actual results** on an acquisition proposal replaces the placeholder with per concept / artwork counts (leads, qualified, booked, sold, customers, subscriptions cancelled, first/latest touch) and the attribution limits. Each contact counts once under its latest tagged touch; no revenue, ROAS, CAC or winner is computed.
- **Paid advertising channels** lists Meta, Google, LinkedIn and TikTok individually: connector, drafting, activation, creative upload and reporting. Drafting is separate from activation and a suggested budget never authorises spend.

## Database (still inside unreleased 0144)

Section 3 adds no table. It adds `SELECT` grants and per-workspace read policies for the existing NOLOGIN `r72_creative_studio_definer` on the existing media, calendar-job, CRM, journey and commerce tables, and one `SECURITY DEFINER` function, `app_private.creative_studio_distribution(workspace, session, 'delivery'|'outcomes', input)`, executable only by `r72_content_command` with a genuine managing-owner session. The hand-off branch of `creative_studio_command` gained the route checks above. (Checksum superseded by the audit below.)

## Checks

- `test/creative-studio-distribution.test.ts` (4): the real article media path with real JPEG preparation (exact bytes, one 1080×1350 format, provenance, idempotent replay, square refused, stranger refused); tracked link tags and outcome reading; ladder rules (queued ≠ accepted ≠ published; failed/unknown/cancelled never upgraded); paid-channel table.
- `test/db/creative-studio-distribution-pg.integration.test.ts` (4 subtests), real PostgreSQL 16 as `r72_content_command` with genuine owner sessions: forged or ordinary-upload article images refused; tracked links with another artwork, another campaign or tags missing from the URL refused; delivery states read only from this brand's receipts (another brand's plan invisible, cross-workspace session refused, no direct table access); outcomes count tagged contacts once, exclude other campaigns, other brands and deleted contacts, and write nothing. Upstream rows are seeded by the disposable superuser with replication-role FK bypass (test seeding only).
- Manual visual proof: `test/manual-distribution-demo.ts` (real Chromium artwork, real router). Evidence: `creative-studio-evidence/m4-*.png`. **The CRM numbers in `m4-tracked-link-ladder-synthetic-crm.png` and `m4-actual-results-synthetic-crm.png` are synthetic fixture rows.**
- Full suite: 4,284 tests, 0 failures, 63 skipped; creative and acquisition PG tests 17/17 plus the new 4.

## Limits and owner decisions

- **No live lead form records campaign tags today.** `contact_attribution_facts` only accepts affiliate rows (0016 CHECK), and the portal form, Growth HQ inbox and MHP capture do not read `utm_*`. Until one capture path stores them (a change to a live, shared workflow — owner and release-owner decision), live leads show as zero. Imported contacts with tags are counted now.
- Subscription starts are not recorded against CRM contacts in the outcome tables (only payments and cancellations are; MHP purchase records hold Stripe subscription ids but are not contact-linked).
- No LeadRelay qualification event exists in the canonical catalogue; "qualified" means the CRM pipeline stage whose slug is `qualified` (the seeded stage) or a won opportunity. Nothing guards that slug if a workspace ever renames it.
- Video has no connected social path for these brands; videos hand off as exports.
- Long renders still run in-request (D-070 stop-gap); the durable render job is not part of this milestone.
- Release: 0144 still waits for the 0142 payments cut-over and must be renumbered if the stopped Apollo branch's `0144_apollo_private_discovery` lands first.

# Milestone 5 — Learning and optimisation

The studio now turns real outcomes into dated, evidence-linked findings, compares concepts and artwork with stated
uncertainty, and suggests the next test. It never computes revenue, ROAS, CAC or a winner, never suggests a budget
and never starts, funds or schedules anything.

## Reuse check and where findings live

| Need | Existing piece | Decision |
| --- | --- | --- |
| Outcomes to learn from | Milestone 4's read of the existing CRM, journey and commerce rows | Reused unchanged. The SQL outcome query was moved into one internal function so the journal can recompute exactly the same counts. |
| Brand memory | Brand guidance documents (`seo_blog_records` knowledge) feed proposals as confirmed audience notes | **Not written automatically.** Any new guidance document unconfirms the brand profile for the creative studio and campaign creators (both require the profile to cover exactly the active documents), which needs a paid profile extraction and makes approved artwork stale. Findings therefore go to an append-only per-brand journal; the owner can explicitly **copy a recorded finding set into brand guidance** as an audience note, with that consequence stated and acknowledged. Once the profile is refreshed and confirmed, the note is cited by the next acquisition proposal through the existing Milestone 2 evidence pack. |
| Activity and approvals | Existing owner session, command replay and append-only patterns | Reused. |
| Cross-brand reuse | None existed | Owner-written general patterns only (below). |

## Behaviour

- **What we learned** on each acquisition proposal (below *Actual results*):
  - one observation per concept/artwork tag (counts and dates);
  - gaps for missing or unrecognised tags;
  - comparisons of qualified, booking and sale rates with 95% Wilson ranges. A comparison is drawn only when every arm has at least 20 tagged leads: *Not enough data*, *No clear difference* (ranges overlap), or *Observed difference — not proof*. Lead volumes are never compared, because reach and spend per link are not recorded.
- **Suggested next tests** (at most three) each change one thing against a control, with what stays the same, the measure, the review date (from the proposal) and *“No budget is suggested… nothing here authorises it.”* Rules: confirm tag capture; use artwork-tagged links; add a second variant; iterate on the stronger concept; try a more distinct angle; keep running until there is enough data.
- **Record these findings** saves the statements, the exact outcome read and the server date. SQL recomputes the outcome counts in the same transaction and refuses the record if the CRM changed, if any finding cites counts that were not observed (exact, ordered comparison), if the campaign is another brand's, or if the recorder is not the session owner.
- **Share a general pattern** (from a recorded finding): owner-written, 20–300 characters, refused if it contains numbers, links, emails, colours, currency or percent signs, tracking tags, or this brand's name, website or offer names (checked in TypeScript and again in SQL). Shared patterns appear only in **the same person's other managed brands** (Creative studio overview → *Patterns from your other brands*), labelled “not evidence for this brand”, never added to proposals automatically, and can be withdrawn (history kept).

## Database (still inside unreleased 0144)

Section 4 adds two append-only, workspace-scoped tables, `app.creative_studio_findings` and `app.creative_studio_patterns`, owned by the existing NOLOGIN definer, with no runtime table privilege. It also adds one owner command boundary, `app_private.creative_studio_learning`, and extends the command action list. Pattern reads across brands are limited by `app_private.can_manage_workspace` for the current person and to rows whose latest state is *shared*. (Checksum superseded by the audit below.)

## Checks

- `test/creative-studio-learning.test.ts` (4): Wilson ranges; findings with dates and evidence; comparison thresholds and strengths; next-test rules; no budget, ROAS, CAC or winner wording; pattern guard; the real router journey (record, stale evidence refused, brand name refused, share, explicit acknowledgement before copying into guidance, withdraw). The learning forms sit outside the proposal edit form.
- `test/db/creative-studio-learning-pg.integration.test.ts` (3 subtests, real PostgreSQL 16, `r72_content_command`, genuine sessions):
  - SQL stores its own evidence read;
  - inflated, swapped, stale and foreign evidence is refused, as is recording on behalf of someone else;
  - rows are append-only and there is no direct table access;
  - patterns with figures, the brand name or an offer name are refused;
  - a pattern is visible to the same owner's other brand and invisible to a different owner, and disappears when withdrawn.
- Visual evidence: `creative-studio-evidence/m5-what-we-learned-synthetic-crm.png`. **The counts are synthetic fixture rows.**
- Full suite: 4,289 tests, 0 failures, 64 skipped. Creative, acquisition, distribution and learning PostgreSQL tests: 26/26. Supply-chain gate passed.

## Limits

- Learning is only as good as the tags: until a live lead form stores campaign tags (Milestone 4 limit), live leads are invisible here.
- Findings are observations from tagged contacts; overlapping ranges, small samples and unrecorded reach mean most early campaigns will honestly show *Not enough data*.
- Patterns travel only between brands the same person manages; there is no organisation-wide or cross-customer sharing.
- Copying findings into brand guidance is deliberately manual because of the profile re-confirmation it causes.

# Audit of Milestones 4–5

Six independent reviews (SQL security, Milestone 4 logic, Milestone 5 logic and statistics, routes and views, factual claims, the article-media integration path) produced 30 findings; none was high severity and none was a cross-brand leak. All were addressed except those recorded as accepted.

| Finding | Fix |
|---|---|
| A posting plan replaced by a newer one leaves its calendar job `cancelled` with no cancel command; the ladder showed it as still waiting | The SQL read now reports `superseded`; the ladder treats superseded or `cancelled` jobs as *stopped*, except a plan that already published. |
| Every revision carrying the hand-off image became its own "post" row, so an edited post appeared twice | One row per post: the revision with a live plan, else the current revision (`postUses`, unit-tested). |
| A retry from a freshly rendered page used a new command id, so a failed hand-off after a successful import would add a second identical private image | The hand-off reuses an existing Creative Studio import for the same exact version, and the import command is derived from version + article + format. Tested. |
| "Never cropped" was enforced only by hiding the control; `POST image-crop` still accepted a studio candidate | `crop()` refuses candidates whose proposal came from the Creative Studio. Tested. |
| Tracked-link route did not check the link host or that the concept index matched the target | SQL now requires a confirmed conversion-page host and `concept-<n>` equal to the target concept. Tested on PostgreSQL. |
| `finding_record` interpolated the campaign id into a regex before proving it was a UUID (a malformed id became a raw regex error) | UUID check first. Tested. |
| Observations or comparisons with an empty evidence list could be journaled unanchored | SQL requires evidence for every non-gap finding and an allowed `kind`. Tested. |
| Malformed queue ids in the delivery read and bad campaign tags surfaced as raw database errors | Validated in SQL; the reader maps 42501/22023/22P02 to 403/400. Tested. |
| `creative_studio_distribution` was marked STABLE while calling the VOLATILE session lock | Marked VOLATILE with a comment. |
| "No clear difference" was explained as "the concepts perform similarly" (overlapping intervals do not show equivalence) | Reworded; the note now states the rule is deliberately cautious. |
| One arm with fewer than 20 leads blocked every comparison | Only arms with 20+ leads are compared; smaller arms are named as excluded. |
| With three or more arms only the extremes were described | Statement says "highest and lowest observed rates" and lists the others. |
| Copying findings into brand guidance was not idempotent (a double submit added two documents) | The same recorded finding set copies once (matching active document reused). Tested. |
| After copying, Setup still shows the profile as confirmed (audience notes are not "factual" for blog writing) while the studio and creators refuse it | The success message now says exactly that and points at *Re-extract from current guidance*. |
| Pattern guard did not consider conversion-page labels; `new URL()` on an unparsable stored website would 500 | Labels added to the brand terms; URL parse guarded. |
| The journal accepts at most 40 findings; many tags could exceed it | `buildLearning` caps at 40 with a summarising gap finding. |
| A failed CRM read on the proposal page showed "No results recorded. This is a plan." | Only a missing proposal shows plan-only; read failures show a "could not be read" notice. Same for acquisition targets and other-brand patterns. |
| Wording: subscription starts, the meaning of "qualified", article URLs "without campaign parameters" | Corrected to what the code does (see Limits above). |
| Landscape 1200×628 → LinkedIn 1200×627 was proved only by reading | Covered by the unit test (candidate digest, one exact-size format). |
| Small UI items: undefined `.small` class on the campaign page, oversized checkbox override, cramped paid-channels table on phones, contradictory "read just now" note | Fixed. |

Accepted as-is: the 600 KB article-variant cap could reject a photo-heavy full-bleed render (the hand-off now reports it plainly and suggests download); the orphan candidate blob on a 409 is pre-existing behaviour of the owner-upload path; substring brand-term matching can over-refuse a pattern (the message names the term).

Test gaps closed on real PostgreSQL: the internal outcome counter is not callable by the runtime role; foreign-host and concept-mismatch links refused; malformed ids refused; a non-managing (viewer) membership in another owner's brand reveals nothing; re-sharing a pattern id refused; patterns append-only. The 0144 checksum at that audit was `57be028a…`; the current pin is `CREATIVE_STUDIO_CHECKSUM` in `orchestrator/src/db/creative-studio-schema.ts`.


# Typed-brief image generation (new images from a description)

The owner types what a picture should show, reviews the cost and allowances, and asks for **one** paid image. A background worker makes the call; the image is stored privately as a candidate (never approved) and can be turned into branded artwork with the existing compositor, where the headline, price, logo and disclosure are added exactly.

## Reuse check

| Need | Reused | Added |
|---|---|---|
| Provider, credential, model, quality | The article image transport (`seo-blog/image-generation.ts`), `SEO_BLOG_IMAGE_API_KEY`, gpt-image-2 at **medium**. The article request body is byte-identical (tested). | A `size` option (the three documented sizes) and reference images through the documented edits endpoint (multipart `image[]`, at most 3). A bounded read of a 400 body recognises the documented `moderation_blocked` code; its text is never stored. No second provider, no model/quality fallback. |
| Paid admission | 0137: operator policy singleton, `seo_image_reserve` (global epoch lock, concurrency, monthly cost, per-brand `budgets.imagesPerMonth`), immutable attempt rows, the deferred one-debit guard, receipts, candidate storage, holds. | A studio branch in `seo_image_reserve` keyed on the intent schema, ahead of the unchanged article branch; it adds the brand's **studio sub-allowance** (`settings.studioImages`). No article was created to pass article-only admission. |
| Durable work | `app.seo_blog_jobs` (SKIP LOCKED claims, leases) and the existing worker tick. | A studio image job (`kind=write`, `stage=image`, creative intent schema) routed before the article paths. A worker without the studio runner blocks it: "Nothing was requested or charged". |
| Storage and review | Private media assets and receipts of the article pipeline; the brand's private media store for previews. | `creative_studio_briefs` and `creative_studio_generations` (append-only, RLS, definer functions only). |

## Safety order (worker)

1. Load reference bytes (an unavailable reference stops before any reservation).
2. Admission is acknowledged only after COMMIT (reservation, start projection, exactly one usage debit).
3. Exactly one provider call per admission.
4. The receipt (and any bytes) is saved; one retry with the same envelope, never another call.
5. The stored pixels are decoded, and the generation is recorded with the job marked done in one transaction.

An existing started attempt (unknown outcome, e.g. a timeout) is **held for reconciliation and counts against the allowance**; it is never re-sent. A refresh, double click or re-run returns the same job. Another image of the same brief version needs an explicit new intent naming the previous one. An intent made under an older operator policy is held (`operator_policy_changed`) and the owner must request again. Missing provider usage is recorded as unknown, never zero.

## Prompt boundaries

The provider receives only:

- the brief text, with links, emails and phone numbers removed;
- the confirmed profile summary (300 characters);
- the active visual guidance, only when the owner ticks it.

It never receives offers, prices, claims, conversion pages, audiences, contacts or credentials (unit-tested). The prompt forbids words, numbers, prices, logos, identifiable people, testimonials and claims in the picture, so "a modern kitchen background" cannot yield an invented headline or price.

## Owner and operator steps

1. **Operator** (database role `r72_owner` only): open `app_private.seo_image_operator_policy`. Set `enabled`, `maxConcurrency`, `monthlyMicrousd` and `perAttemptMicrousd` (the reservation shown to owners as an upper-bound hold, not a price). It is closed by default.
2. **Owner**: SEO Blog → brand → **Publishing**. Set the brand image allowance (`imagesPerMonth`, shared with blog images).
3. **Owner**: Creative studio → **Generate a new image** → **Allowances**. Tick *Allow paid images from typed briefs* and set *Studio images per UTC month*. It defaults to **off / 0**. A writing (model-token) allowance is not an image allowance.
4. Write a brief → **Save brief and review the cost**. The page shows:
   - one paid request;
   - the model and quality;
   - the size and reference count;
   - the reserved hold;
   - why the exact cost is unknown in advance;
   - the remaining brand, studio and platform allowance.
5. Tick the confirmation → **Generate image**. The page polls the job, and you can leave it. Once the image appears: **Create artwork from this image**.

Configuration: `CREATIVE_STUDIO_ENABLED=true` on both the web service and the SEO worker, and `SEO_BLOG_IMAGE_API_KEY` on the worker (the existing secret name; the value is never logged).

## Checks

- **Real PostgreSQL** (`test/db/creative-studio-generation-pg.integration.test.ts`, 8 subtests, the real `r72_content_command` role with genuine owner sessions and a worker principal). The provider HTTP is scripted, so nothing is sent or charged. It proves:
  - defaults are off;
  - one durable job survives replay and double click;
  - one call, one debit, an atomic record and the exact stored bytes;
  - restart recovery makes no second call;
  - a new-intent rule;
  - an unknown outcome is held and never repeated;
  - the transient concurrency hold is requeued;
  - a policy change is held;
  - the studio allowance is held;
  - two jobs racing for the last image produce exactly one paid call;
  - a reference reaches the provider as one multipart part;
  - reference and brand isolation;
  - no direct table access, and the tables are append-only.
- **Unit** (`test/creative-studio-generation.test.ts`, 11 tests): brief rules, prompt boundaries, transport compatibility, the edits multipart, refusal classification, and the worker order with fakes. Also one service test for previews and backgrounds.
- **Visual** (`test/manual-creative-generation-pg-demo.ts`): the production portal and worker compositions on a disposable database, driven in Chromium. Every screenshot is marked *SYNTHETIC PROVIDER RESPONSE*: the picture is a generated gradient, not a provider image. It found and fixed:
  - generated previews were refused by the article-variant media route, so a dedicated brand-scoped, digest-checked preview route was added;
  - loading generated images depended on article image review being configured;
  - a stale banner after the polling reload;
  - the cost list was cramped on phones.
- **Live provider proof: not performed.** No authorised allowance or credential was available in this environment. The smallest real test is **one** 1024×1024 medium image from a short brief with no references on a test brand, with the studio allowance set to 1. Expected cost is a few US cents of output-image tokens at medium quality. Published per-token rates conflict, so read the stored usage on the attempt rather than estimating.

## Limits

- No automatic reconciliation of an unknown outcome. It stays held and counted until an operator resolves it with the existing reconciliation process.
- The per-version edit form in *Compare* cannot yet swap in a generated image. Use the new-artwork form (*Create artwork from this image*).
- Only the brand's own current private images can be references (generated studio images and article candidates). Arbitrary uploads are not sent to the provider.

# Durable render jobs (artwork, storyboards, video)

Rendering no longer runs inside the HTTP request, and the earlier 120-second socket-timeout extension is removed. These actions now record one durable job in the existing `app.seo_blog_jobs` table (`kind=write`, `stage=creative_render`) and return at once with a task page:

- Create images, Edit concept, Refresh, Move focal point
- Draft a storyboard, Save storyboard, Render video

The job is keyed by the form's command id, so a refresh or double click returns the same job. The task page polls and opens the result when the job is done. You can leave the page; the job survives restarts. The existing SEO worker runs the job through the same service method that used to run inline. No new queue, scheduler or worker process is added.

- **Uploaded backgrounds** are verified and stored by the request; the job carries only the stored reference. The worker re-verifies the exact bytes and refuses a mismatch ("integrity check"). No image bytes are kept in job rows.
- **Authority.** `creative_studio_command` (0144) accepts a worker call only when all of these hold:
  - it carries the claim of a job that is `running` with an unexpired lease, the same lease owner and the same attempt;
  - the job is a `creative_render` job of the same workspace;
  - the job's sponsor still manages the brand;
  - the call is one of: read, `command_get`, `set_create`, `versions_append` (and writes only under the job's own command).

  Approval, hand-off and kit changes always need the owner's session. Revoking the sponsor stops the job without writing anything (proved on PostgreSQL).
- **Retries.** Each service command is idempotent, so a re-run replays instead of duplicating. Owner-correctable problems stop the task with the service's message, for example changed brand facts, a newer version, or a missing offer. A renderer or server fault is retried once after a minute, then stops with "Nothing was published".
- **Worker requirements (rollout).**
  - Set `CREATIVE_STUDIO_ENABLED=true` on the SEO worker as well as Growth HQ.
  - Install the Chromium headless shell on the SEO worker service with the same build suffix Growth HQ uses: `&& (PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers npx --no-install playwright-core install --only-shell chromium || echo '…renderer stays off')`. That service (`relaunch72-seo-blog-worker`) is configured in the Render dashboard, not in this repository's manifests.
  - On start, the worker logs `capability creative-studio-v1 … renderer found|NOT found`.
  - Render latency is the worker interval (`SEO_BLOG_WORKER_INTERVAL_MS`, default 60 s, minimum 15 s) plus the render itself.
- **Checks.**
  - `test/db/creative-studio-render-jobs-pg.integration.test.ts` runs on real PostgreSQL with the production `creativeRenderRunner` and real headless Chromium. It proves:
    - the request records the job and renders nothing;
    - a double submit returns the same job;
    - real 1080×1080 JPEGs are recorded as the sponsor;
    - a restart replays without adding versions;
    - focal and uploaded-background jobs work;
    - a tampered reference is refused;
    - forged, stale or wrong-attempt claims, other brands, approval, kit and foreign-command writes are all refused;
    - a revoked sponsor stops the job.
  - Unit tests cover the job shape and the runner's stop and retry rules.
  - Route test: no render inside the request, task page, a double submit returns the same job, another owner cannot follow the task, and the result opens when done.
  - Visual walkthrough (`test/manual-creative-generation-pg-demo.ts`): the artwork request returned in about 0.4 s. The worker recorded and playback-checked a 1080×1920, 10.5 s video in about 15 s, and it played in Chromium. No console errors.

# Campaign enquiries into the existing CRM (real attribution capture)

Until now only imported contacts carried campaign tags, so live campaign leads always showed as zero. Brands now have an **enquiry form**. When a visitor arrives from a tracked link and sends it, the lead enters this brand's CRM through the existing `crm.createLead` command, and the campaign is recorded only when its tags are genuine for this brand.

## Reuse check

| Need | Reused | Added |
|---|---|---|
| Lead creation, de-duplication, opportunity, task, command receipts | `CrmCommandService.createLead` as the `r72_crm_command` role. It acts as the owner who switched the form on, as the Growth HQ inbox does with its configured owner. | Nothing in the CRM itself. |
| Public form safety | The investor-site pattern: hosted page or iframe embed, a signed one-hour form token, a honeypot, a no-referrer and strict CSP page, and an hourly cap. | The token also signs the exact UTM values, so tags cannot be altered at submit. |
| Pipelines | Existing `app.pipelines` and `app.pipeline_stages`. A brand that already has a default pipeline uses it as it is. | A brand with no pipeline gets the standard "Enquiries" pipeline (New enquiry, Contacted, Qualified, Won, Not proceeding) when the owner first saves, in the same shape as existing provisioning. |
| Attribution | Not `contact_attribution_facts`: it stays affiliate-only and untouched. The legacy import table is not used either. | `app.creative_studio_lead_touches`. It is append-only and holds one row per CRM command. It references the contact, opportunity, campaign and the exact tracked-link hand-off. Contact erasure removes the row. |

## Rules

- **Tags are untrusted.**
  - The page keeps only `utm_source`, `utm_medium`, `utm_campaign` and `utm_content`, each with a conservative shape.
  - A touch is stored only when SQL finds a tracked link this brand issued for its own acquisition campaign with exactly that campaign and content, and whose link carries the same source and medium.
  - Malformed, unknown, altered and other-brand references still create the lead, but with no campaign touch (proved).
  - No personal data is ever placed in a URL: name, email, phone and message travel only in the POST body.
- **Qualified.** The owner maps the stage that means "qualified" by its **stage id** (Creative studio → Enquiry form). Results count a lead as qualified when it reaches that stage or a later open stage of the same pipeline, or when it is won. Renaming the stage or changing its slug keeps the meaning (proved). Without a mapping, only won opportunities count, the read says `qualifiedMapped: false`, and qualified rates are not compared. A stage merely slugged `qualified` is no longer trusted.
- **Switching on.** The form is off until the owner saves a privacy-notice link and switches it on. It stops when switched off, when the owner no longer manages the brand, or when the brand is paused. It accepts at most 50 enquiries per hour per brand.
- **Idempotency.** A double submit replays the same CRM command, so there is one lead and one touch. A honeypot hit creates nothing.
- **Not done.** Nothing is emailed, published or spent. No revenue, cost per acquisition, return on ad spend or winner is calculated.

## Owner steps

1. Creative studio → **Enquiry form**: choose the first stage and the "qualified" stage (or accept the standard pipeline), add the privacy notice link, tick *Accept enquiries*, then **Save**.
2. Paste the embed code on the page the tracked links open (recommended). It forwards only the four tags from that page's address into the form. Alternatively, link to the hosted page.
3. Campaign results then show tagged leads, qualified, booked and sold for each concept and artwork.

## Checks

- **Real PostgreSQL** (`test/db/creative-studio-enquiry-pg.integration.test.ts`). The upstream acquisition campaign row is seeded, because generating it needs a model. Everything else is real:
  - the hand-off SQL issues the tracked link;
  - the public handler serves and receives the form;
  - `crm.createLead` runs as `r72_crm_command`;
  - the touch function and the existing outcome reader run as `r72_content_command`.

  It proves:
  - the off-by-default and privacy-notice rules;
  - the standard pipeline and the mapping by id;
  - a key works only for its own brand;
  - one lead and one touch after a double submit, placed in the owner's pipeline and first stage, with source `creative_studio_enquiry`;
  - the reader attributes the lead to the exact campaign and artwork;
  - a real `crm.moveOpportunityStage` to the mapped stage counts as qualified, including after renaming the stage;
  - unknown, altered-source, malformed and cross-brand tags create the lead but no touch;
  - tampered tags, a missing consent tick and a switched-off form are refused, and a honeypot hit creates nothing;
  - the runtime role has no table access.
- The Milestone 4 proof now shows that a stage slugged "qualified" is not counted until it is mapped.
- Unit tests cover the UTM filter, tokens bound to brand, key, tags and time, input checks, the embed code and the owner page.

## Rollout

- The public route `/enquire/<brand>/<key>` is mounted on the main web service only when `CREATIVE_STUDIO_ENABLED=true` and the portal's CRM command pool (`DATABASE_CRM_COMMAND_URL`, role `r72_crm_command`) is composed. No new secret: tokens use the existing portal session secret.
- The hosted link and the embed code use the portal's configured public base URL.
