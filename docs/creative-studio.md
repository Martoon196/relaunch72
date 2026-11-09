# Creative Studio — Milestones 1–3 (brand-aware creative; campaign intelligence; video and rich media)

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
| Multi-brand Brand Brain | `seo-blog` brands, confirmed `BrandProfile` (offers, prices *as written*, approved claims, exclusions, conversion pages, `factsSha`), knowledge incl. `visual_guidance` (0131); `app_private.seo_creator_profile` (0139) | Engine + PG proofs | Nothing turned it into creative rules (colours, logo, disclosures) | `creative-studio/brand-context.ts` resolves per brand; owner-confirmed **creative kit** versions (0143). Reuses `seo_creator_profile` in SQL. |
| Image Studio UI | `portal/image-studio-*` | Read-only, **Property Predator-hardcoded**, generation locked, "command boundary absent" | Not generic; cannot produce an image | Left untouched (PP-specific). Generic studio added to the multi-brand area instead. |
| Paid image generation | `seo-blog/image-generation|intent|jobs|worker|service-pg` + 0137 ledger (admission, reservations, nonce, receipts, uncertain outcomes) | Code + disposable-PG proofs; operator policy default **disabled / zero**; **article-bound** (`seo_image_source(article)`), fixed `gpt-image-2` 1536×1024; the stored worker downgrades `prepared` to held `apply_unavailable`; no live run on record | Cannot admit a non-article brief | **Reused, not modified**: receipted candidates from this pipeline are offered as backgrounds with provenance (intent, attempt, candidate SHA). No new paid path was added (see §7). |
| JPEG handling | `seo-blog/jpeg-preparation.ts` | Tested | No text/logo compositing | Additive `decodeVerifiedJpeg` export reuses its hardened header/orientation checks for every input image. |
| Private storage | `app.seo_blog_blobs` (workspace RLS) | Live schema | — | Stores artwork and logo bytes; SQL verifies each digest. |
| Approvals | company-content approvals, SEO media quality reviews, creator approvals | Existing | No exact approval for a creative image version | 0143 approvals bound to exact render SHA + profile version + facts digest + kit version. |
| Distribution | Article campaigns, social uses (0137), Zernio calendar | Owner-gated | Hand-off of finished artwork | Draft hand-off record only (no delivery effect). Connecting to social media-use authorisation is Milestone 4. |
| Method packs | 0.1.1 packs incl. `visual-briefing` (0138–0140) | Private authoring approved | Not used for raster artwork | Unchanged. Milestone 2 feeds them into model-written hooks/copy. |
| Ads connectors | `src/ads/meta.ts` | Interface only, unproven | — | Untouched. No ad activation exists here. |

## 2. What was implemented

- **Brand resolution** (`brand-context.ts`): profile is usable only if confirmed, conflict-free and bound to exactly the active knowledge (mirrors the SQL rule). Essential gaps (unconfirmed profile, unknown offer, missing/unapproved destination for adverts, article image without an article) **block** drafting with a plain explanation. Decorative gaps use a **labelled** neutral palette and a plain-text brand name instead of a logo. Colours found in visual guidance are shown as suggestions, never applied without confirmation.
- **Concepts** (`concepts.ts`): up to three distinct angles (offer-, approved-claim-, positioning-, article-, takeaway-, brief-led) drafted deterministically from approved facts only — no model call. The exact stored price is used only where one exists and never on organic posts. Fewer facts produce fewer concepts with an explanation. Figures not in approved facts are flagged and need explicit confirmation at approval; restricted wording (profile exclusions + kit) blocks approval. Coordinated carousel cards; the last card carries the CTA.
- **Deterministic compositor** (`renderer.ts`): HTML/CSS laid out and rasterised by an offline headless Chromium (all requests aborted except in-memory, verified bytes on a private pseudo-origin; no page scripts). Vendored Inter (SIL OFL 1.1, `fonts/INTER-OFL.txt`). The approved logo file is placed unchanged; text, prices and disclosures are real typography. Five placements with safe areas (square 1080², portrait 1080×1350, vertical 1080×1920, landscape 1200×628, article 1600×900), focal-point cover crops, headline fitting, and **measured WCAG contrast** on the actual pixels under each text box with an adaptive scrim. Overflow and low contrast are reported as blocking issues — never silently clipped. Generated scenes carry a default "Illustrative image" marker. One browser per batch, one batch at a time per process.
- **Versioned library** (`store.ts`, `pg-store.ts`, migration **0143**): append-only sets, versions, approvals, hand-offs and idempotent commands. Concept edits re-render only that concept (component digests show unchanged parts); focal edits re-render one format; stale head lists are refused. Approval = one exact image; it never approves captions, campaigns, schedules or paid ads. Kit or brand-fact changes make approvals stale; **Refresh from current brand** re-renders and re-approval is required. Downloads are the exact stored bytes, digest-verified, labelled `-approved` only for a currently usable approval.
- **UI** (`portal/creative-studio-view.ts`): Create images → Compare (concepts side by side per format) → Edit → Approve → Download / Add to campaign. Kit editor with logo upload. Works at phone width.
- **Composition** (`portal/creative-studio-composition.ts`, `seo-blog-service.ts`, `seo-blog-router.ts`): mounted only when enabled; same CSRF/same-origin/session rules as the rest of the area.

## 3. How to open and use it

1. Set `CREATIVE_STUDIO_ENABLED=true` (after 0143 is applied) on the Growth HQ service.
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
- Readiness: `creative143` (exact 0142 ledger + only 0143 pending; never during the 0142 cut-over) and the unchanged `payments142` semantics against the 142-file bundle.
- Visual: `test/manual-creative-studio-demo.ts` drives the real forms in Chromium for two fictional brands; screenshots and exact artwork in `docs/creative-studio-evidence/` were inspected. The inspection found and fixed a false "does not fit" on headline-only carousel cards.

All example brands, logos and backgrounds are **synthetic fixtures** (procedurally drawn, not provider output, not real businesses).

## 6. Release and recovery (release owner)

Prerequisite: the 0142 payments cut-over is complete and verified, and its production reservation is released by its owner. This release must not be deployed during that reservation; its readiness gate only accepts an exactly-applied 0142.

1. Integrate onto the then-current canonical tip; if new migrations landed, renumber 0143 and update its checksum pins (readiness, SQL contract).
2. Exact-source CI: typecheck, full suite, disposable PG: `node --import tsx scripts/rl72-boosters-pg-bootstrap.mjs`, then `node --import tsx --test test/db/creative-studio-pg.integration.test.ts`.
3. Deploy that exact source to **every** strict schema consumer with `CREATIVE_STUDIO_ENABLED` unset; verify `/ready` on each (not `/health`).
4. Apply 0143 with the migrator connection; `npm run db:check`; verify `/ready` again.
5. Check the Growth HQ build log for the headless-shell install line (or the "renderer stays off" line).
6. Set `CREATIVE_STUDIO_ENABLED=true` on Growth HQ only; owner walkthrough on one owned brand.

Recovery: set `CREATIVE_STUDIO_ENABLED=false` (routes unmount immediately). Keep a 0143-capable release: earlier releases' strict readiness refuses an applied 0143. Never delete the additive tables or recorded approvals.

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
| Model-backed drafting with allowance | Campaign creators (0139): atomic reservation, receipts, held/unknown recovery, exact approvals, export | PG-proven | Email/advocacy only | Third creator kind `acquisition` (Hook & Close pack). SQL: 0143 adds the kind to the table check and to `seo_creator_command` / `seo_method_save_receipt` — the 0139 bodies verbatim apart from those lists |
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
- Release: unchanged from Milestone 1 (single additive 0143, after the 0142 cut-over). Note an unmerged, stopped Apollo branch also claims a `0143_` filename; renumber whichever lands second.

---

# Milestone 3 — Video and rich media

**Status:** source complete on the same branch; not deployed; not verified live. Everything renders locally: no video, avatar or voice provider, no provider call and no charge.

## Reuse check

| Capability | Existing implementation | Proven status | Missing | Extension made |
|---|---|---|---|---|
| Video in the codebase | Posting client accepts `video/mp4`, `video/webm` (`zernio-posting-client.ts`); no producer | Contract only | No way to make a video | Videos produced here use those exact types for the Milestone 4 hand-off |
| Renderer | Milestone 1 Chromium compositor with measured contrast | This branch | Stills only | Optional transparent overlay capture of the exact measured layout; contact-sheet and video rendering in the same offline session |
| Encoding | Pinned headless Chromium's built-in MediaRecorder | Probed here: H.264 High MP4 and WebM supported | Recorder writes fragmented MP4 | `mp4-remux.ts`: lossless rewrite to a standard index-first ("fast start") MP4; all 325 decoded frames proved pixel-identical with ffmpeg in development |
| Versioning / approvals | Milestone 1 library (0143) | PG-proven | Single media type | `storyboard` and `video` media kinds as separate lineages per concept and format, reusing lineage, stale-context and approval rules |

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
