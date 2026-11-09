# Creative Studio — Milestone 1 (brand-aware image and ad creative)

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
- Model-written hooks and copy (Milestone 2), image editing with a provider, brand-supplied font files, campaign media-use authorisation and delivery (Milestone 4).
