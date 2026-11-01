# SEO blog production engine — baseline, adapter plan and handoff

Spec: *Relaunch72 SEO Blog Engine Specification for Claude* (31 Oct 2026).
Branch: `claude/epic-cori-ge5bh9` in `Martoon196/relaunch72` and in `Martoon196/propertypredator`.

## What an owner can do with this source (once deployed and configured)

1. Open **Brands** (`/portal/seo-blog`), click **Add brand**, enter a name and an optional website. One
   atomic database call creates the brand's canonical workspace, the owner's membership and the blog
   brand record. Retrying the same form does not create a second workspace. A brand switcher opens any
   brand the signed-in owner manages.
2. In **Brand setup**: set the website, locale (default `en-GB`) and timezone (default `Europe/London`);
   upload PDF/DOCX/TXT/Markdown guidance, paste text, or upload PNG/JPEG/WebP visual references; see
   exactly what was read (for example "Text was read from 1 of 2 pages … OCR is not available"); replace
   or retire documents (each change is a new version); extract a structured brand profile; edit and
   confirm it. Conflicting prices or obsolete offers are shown as conflicts instead of being resolved by
   guesswork. Connect a website (GitHub static repository, or a signed website content API).
3. In **Topics**: press **Plan my content** with no topic. The engine reads the website (sitemap plus
   home-page links, including standalone editorial pages), researches through the configured provider,
   proposes a cluster (one pillar + six supporting briefs, the existing CC format), checks every brief
   for duplication against the site and all planned work, explains why each fits, labels demand as
   measured (provider + date) or qualitative, and suggests dates (pillar first). Accept, omit or postpone
   briefs, then **Generate selected articles** (with a usage estimate).
4. In **Articles**: full articles with sources (URL, retrieval date, supporting passage), contextual links
   only to real published pages, metadata, featured image (an existing brand image by URL), checks with
   a concrete fix per issue, full editing, single-section regeneration, whole-article regeneration,
   version history and previews of any version, Markdown/HTML export.
5. In **Calendar**: month, week and list views, an unscheduled tray, drag-and-drop which submits the
   same form a keyboard user fills in (date, time, website), automatic placement by cadence, hold,
   cancel schedule. Times are brand-local and stored with the exact UTC instant.
6. In **Publishing**: automatic publishing (off by default), **Pause all blog publishing**, ongoing
   production (off by default), automatic plan acceptance, cadence, planning horizon (30 days default),
   backlog ceiling, monthly writing/research/image budgets (zero by default — no spend until set),
   length preference and author.
7. **Activity**: task progress (survives leaving the page), cancel/retry, and the brand's audit history.

## Evidence classes (kept separate on purpose)

| Class | Status |
| --- | --- |
| Implemented source | Done on `claude/epic-cori-ge5bh9` (both repositories). |
| Offline/isolated tests | relaunch72: 16 engine acceptance scenarios, 7 unit tests, 1 portal HTTP test; full suite green (see below). PP: 6 new blog tests. |
| PostgreSQL integration | `test/db/seo-blog-pg.integration.test.ts` passed against a local PostgreSQL 16 with migrations 0001–0096 + 0131 applied, running as `r72_content_command`. Skipped in CI unless a disposable DB is supplied. |
| Deployed software | **None.** Nothing was merged, published, migrated or deployed. |
| Configured automation | **None.** No brand has automatic publishing or ongoing production on. |
| Verified public articles | **None.** No article has been published to any real website (A8 live is outstanding). |
| Real research/generation quality | **Not assessed.** Tests use a scripted model and fake search; outputs are labelled *simulated*. |

## Baseline read

| Item | Value |
| --- | --- |
| relaunch72 base | `codex/relaunch72-platform-foundation` @ `cd8aa8f47b21ebe88b329de4bcc2814f1faf74e1` (matches the spec's recorded head) |
| relaunch72 baseline tests | 3,641 pass / 0 fail / 41 skipped; `tsc --noEmit` clean |
| propertypredator base | `master` @ `86c3af7486c6e4f38042f485a0b2210968c70574` |
| martinhowardproperty | `main` @ `9c99d3825e286677ea75dd96172933ed239f7897` (read-only inspection; not changed) |
| Workspace `AGENTS.md`, coordination manifest, audit ledger | Live on the Windows host workspace; **not reachable from this cloud session**. Their rules (publisher procedure, Astra ratification, root-only integration and live effects) were followed by not merging, publishing, migrating or deploying anything. |

## Destination inspection and adapter decision

- **MHP** (`martinhowardproperty.co.uk`): static GitHub Pages site deployed straight from `main`
  (`CNAME`, `.nojekyll`, directory-per-page `/<page>/index.html`, `sitemap.xml` with `<loc>` only, no
  build workflow). → **`github_static` connection type.**
- **PP** (`propertypredator.com`): FastAPI serves `frontend/` same-origin; Render does **not** auto-deploy
  (deploy hook only, per its CLAUDE.md), so a repository publisher would require an application deploy
  per article. Existing standalone editorial pages (e.g. `how-it-works`,
  `ai-summaries-vs-analysis-that-shows-its-working`) are inventoried, not treated as empty. →
  **`content_api` connection type**: a small signed endpoint stores each article; `/blog`,
  `/blog/<slug>` and `/sitemap.xml` are rendered server-side. No deploy per article.

Neither adapter is named after a brand. A new brand connects either type from its own Brand setup with
configuration and a credential only.

### Adapter contract (`orchestrator/src/seo-blog/publishers/types.ts`)

`validateConfig`, `publicUrlFor`, `indexUrlFor`, `checkConnection`, `publish` (idempotent; throws
`PublisherOutcomeUnknownError` when the outcome cannot be known), `findExisting` (reconciliation read).
Verification is common: the public URL must serve the meta marker
`r72-blog:<article>:<version>:<sha16>` before an article is marked **Published**.

- `github_static`: one atomic commit (Git Data API) writes only `<blogPath>/<slug>/index.html`,
  `<blogPath>/index.html` (with its own entry manifest) and one `<url>` in the existing sitemap
  (existing entries and the `lastmod` convention preserved). Non-forced fast-forward ref update from
  the exact head read; a concurrent site edit causes a re-read, never an overwrite. A page at the
  article path or an index the engine did not create is refused. Optional repository template with
  `{{head}}`/`{{content}}` keeps the site's branding.
- `content_api`: `POST {endpoint}` and `GET {endpoint}/status`, signed with
  `HMAC-SHA256(secret, "<ts>.<METHOD>.<path>.<sha256(body)>")`, 5-minute window, idempotent on
  article+version, slug conflicts refused. PP re-sanitises the article HTML against a strict allowlist.

## Implementation map

relaunch72 (`orchestrator/`):

| Area | Files |
| --- | --- |
| Domain types, policy gate, DST-safe diary, duplicate checks | `src/seo-blog/types.ts`, `policy.ts`, `schedule.ts`, `dedupe.ts` |
| Guarded fetching (private/local/metadata ranges blocked, address-pinned sockets, revalidated redirects, size/time caps), HTML/sitemap parsing, inventory | `src/seo-blog/safe-fetch.ts`, `html.ts`, `inventory.ts` |
| Uploads: PDF text layer, DOCX, TXT/MD, pasted text, image references; limits 20 MiB / 10 MiB (env-configurable) | `src/seo-blog/knowledge.ts` |
| Research provider seam (DataForSEO Google organic SERP — the supplier the keyword rail already rents) and bounded source passages | `src/seo-blog/research.ts` |
| Model stages (profile, plan, article, section) through the platform `LlmClient`, schema-validated with one critique retry; untrusted material fenced as data | `src/seo-blog/generation.ts`, `prompts/seo-blog-*.md` |
| Quality/factuality checks (unsupported or mis-cited figures, fabricated quotes, outcome promises, regulatory statements without a primary source, copied source text, duplication, broken internal links, unsafe markup, metadata, completeness, voice) | `src/seo-blog/checks.ts` |
| Rendering (escaped HTML, restricted Markdown, JSON-LD with `<` escaped, index manifest, sitemap merge, Markdown export) | `src/seo-blog/render.ts` |
| Publishers | `src/seo-blog/publishers/{types,github-static,content-api,registry}.ts` |
| Credential sealing (AES-256-GCM, AAD bound to brand + destination) | `src/seo-blog/vault.ts` |
| Engine service (brands, knowledge, profile, inventory, planning, writing, editing, approval, schedule, destinations, preview/export, dispatch, reconciliation, durable jobs, budgets, activity) | `src/seo-blog/engine.ts` |
| Stores | `src/seo-blog/store.ts` (contract + memory), `src/seo-blog/pg-store.ts` (PostgreSQL) |
| Migration | `src/db/migrations/0131_seo_blog_engine.sql` |
| Portal | `src/portal/seo-blog-{service,router,view}.ts`; wired in `portal/router.ts`, `portal/provision.ts`, `portal/postgres-platform.ts`, `server/index.ts` |
| Worker | `src/workers/seo-blog/cli.ts`, `npm run serve:seo-blog-worker` |
| Tests | `test/seo-blog-engine.test.ts`, `test/seo-blog-units.test.ts`, `test/seo-blog-portal.test.ts`, `test/seo-blog-fixtures.ts`, `test/db/seo-blog-pg.integration.test.ts`; ledger tests updated in `test/db/sql-contract.test.ts`, `test/db/runtime-readiness.test.ts` |
| Screens (desktop + mobile, rendered from the portal test) | `docs/seo-blog-evidence/*.png` |

propertypredator (`backend/`): `services/blog_content.py`, `routers/blog.py`, `main.py` (router include
before the `/{slug}` catch-all), `tests/test_blog.py`.

The existing CC stage, schemas and runner are untouched; the planner reuses the seven-brief cluster
format with explicit researched-source provenance.

## Publishing policy as implemented

`evaluatePublication` runs immediately before each publication, on freshly read brand settings, article,
exact version, current check report and destination:

| Auto publish | Needs my approval | Behaviour |
| --- | --- | --- |
| Off | either | exact current version must be approved |
| On | off | publishes at the diary time if every other control passes |
| On | on | exact current version must be approved |

Also enforced at execution time: **Pause all** holds approved work; critical checks hold in every mode
and approval cannot override them; checks must be current for the exact version **and** the current
brand facts (a changed factual document makes the profile stale and holds publication; visual guidance
does not); the destination must be connected; work more than 2 hours late is held as *missed* (never
replayed in a burst); a late approval does not publish — the owner chooses a new time. Each publication
stores the policy snapshot and exact version used. Edits create a new version and clear approval.

Operation safety: the publication row (unique per brand/article/version/destination/owner-set slot) is
written **before** the provider call; the article row-version fence makes a duplicate worker lose;
timeouts become *outcome unknown* and are reconciled with `findExisting` before any re-send; *Published*
is set only after the public URL serves the version marker; attempted and verified times are kept apart.

## Acceptance criteria status

| ID | Status |
| --- | --- |
| A1 | Offline + PostgreSQL: create two brands, idempotent retry, isolation (store and forced RLS), visible unreadable/rejected uploads. **Live UI on a deployed portal not yet exercised.** |
| A2 | Offline with fake research: researched clusters per brand, titles/intent/angles/sources/dates, duplicate checks against standalone pages and planned work. **Real research quality not assessed.** |
| A3 | Offline: pillar + supporting articles with sources, links, metadata, preview. Featured image = existing brand image by URL; **image generation is not connected** (shown as unavailable). |
| A4 | Offline + PostgreSQL: section regeneration keeps other sections byte-for-byte, history retained, checks rerun. |
| A5 | Offline: form/keyboard rescheduling persists date/time/timezone/destination; BST, GMT, spring gap (01:30 → 02:30 shown) and autumn repeat tested. Drag-and-drop is a progressive enhancement over the same form (not browser-automated). |
| A6 | Offline: every truth-table row, pause, auto-off, edit-invalidates-approval, overdue held. |
| A7 | Offline: edited version and changed policy while waiting are enforced at dispatch. |
| A8 | Offline only (in-memory GitHub; in-memory signed site). **Live publication not done** — needs a deployed portal, migration 0131, credentials and an explicitly authorised real article. |
| A9 | Offline: lost GitHub response reconciled; concurrent workers → one publication, one index entry, one sitemap entry; concurrent human edit preserved. |
| A10 | Offline: crash mid-write and crash after operation record both recover without duplicates or surprise publication. |
| A11 | Offline: missing research, exhausted budget, model failure (task blocked, nothing fabricated), critical factuality, malformed upload, foreign-brand access — each truthful and brand-local. |
| A12 | relaunch72 full suite green with the area mounted only when `SEO_BLOG_ENABLED=true`; PP full suite run (see handoff message). No checkout/auth/subscription/tool code changed. |

## Configuration required (none of it is set by this change)

relaunch72 service:

| Variable | Purpose |
| --- | --- |
| `SEO_BLOG_ENABLED=true` | Mounts `/portal/seo-blog` and enables the worker. Absent = 404, nothing else changes. |
| `DATABASE_CONTENT_COMMAND_URL` | Existing `r72_content_command` identity (already required in PP production). |
| `SEO_BLOG_CREDENTIAL_KEY` | Base64 32-byte key for sealing website credentials. Without it, website connections are disabled with a clear message. |
| `ANTHROPIC_API_KEY` | Real generation. Without it, generation is shown as unavailable. `RELAUNCH72_MODEL_SEO_BLOG_*` can override the model per stage. |
| `SEO_BLOG_DATAFORSEO_LOGIN` / `_PASSWORD` (or the existing `DATAFORSEO_*`) | Research. Without them, planning is blocked with "connect a research provider". |
| `SEO_BLOG_KEYWORD_METRICS=dataforseo` | Optional measured demand; otherwise demand is labelled qualitative. |
| `SEO_BLOG_MAX_DOCUMENT_BYTES`, `SEO_BLOG_MAX_IMAGE_BYTES`, `SEO_BLOG_WORKER_INTERVAL_MS`, `SEO_BLOG_WORKER_BATCH` | Optional limits. |

Worker: a separate process `npm run serve:seo-blog-worker` with the same variables.

PP service: `BLOG_PUBLISH_SECRET` (≥ 32 chars; same value entered as the credential in the PP brand's
content-API connection), optional `BLOG_PUBLIC_BASE_URL` (default `https://propertypredator.com`).
Endpoint for the connection: `https://propertypredator.com/api/blog/publish`.

MHP: a fine-grained GitHub token with Contents read/write on `Martoon196/martinhowardproperty` only,
entered in the MHP brand's GitHub-static connection (`branch=main`, `publicBaseUrl=https://martinhowardproperty.co.uk`,
`blogPath=blog`, `sitemapPath=sitemap.xml`; optional `templatePath` once a branded template is committed).

## Release order and gates (for root / Astra — not performed here)

1. Independent review of both branches at their exact SHAs; Astra ratification.
2. Apply migration **0131** before deploying the relaunch72 code: runtime readiness requires the full
   ledger, so a deploy before the migration fails readiness by design.
3. Deploy relaunch72 with `SEO_BLOG_ENABLED` unset; confirm existing smoke checks. Then set the variables
   above, start the worker, and run the live acceptance journey (A1–A8) on two new brands.
4. Integrate and deploy the PP endpoint through the PP publisher procedure (`smoke_prod.py`), then set
   `BLOG_PUBLISH_SECRET`. `/blog` stays `noindex` and absent from the sitemap until the first article.
5. Publishing one specifically selected real article (A8) needs its own content approval. Automatic
   publishing and ongoing production stay off until deliberately configured per brand.

## Recovery

- **Jobs**: Activity → *Cancel* / *Retry*. A crashed worker's lease expires (10 minutes) and the next
  worker resumes; idempotency keys (`plan:<command>`, `write:<brief>`, `daily:<date>`) prevent duplicates.
  Blocked tasks (budget, provider, profile) resume after *Retry*.
- **Outcome unknown**: never re-send manually. The worker reconciles via the destination's status read
  (`findExisting`); present → verified; confirmed absent → the same operation is re-sent; a different
  version on the site → failed with nothing overwritten.
- **GitHub static site**: every publication is a normal commit whose message carries
  `r72-operation: <id>`; revert that commit to unpublish. History is never rewritten (no force pushes).
- **Content API site (PP)**: rows live in `blog_articles`; deleting a row unpublishes the page and its
  sitemap entry. Engine-side publication history (`app.seo_blog_publications`) is append-only in effect
  and is never deleted.
- **Kill switch**: Publishing → *Pause all blog publishing* (per brand), or unset `SEO_BLOG_ENABLED`
  (whole area and worker), or unset `BLOG_PUBLISH_SECRET` on PP (endpoint returns 503).

## Known limits and follow-ups

- No OCR (as specified for the first release); scanned pages are reported unreadable.
- Featured-image **generation** is not wired; owners choose an existing brand image URL. Uploaded visual
  references are stored privately and are not yet publishable as article images.
- Blobs are stored in PostgreSQL (bytea, 20 MiB cap); object storage would be preferable at volume.
- The brand switcher selects brands by URL inside the blog area; authority is re-checked by PostgreSQL
  (owner/admin membership + session re-lock) on every transaction. This deliberately does not swap the
  whole portal session, so PP Growth HQ flows pinned to the PP workspace keep working. Flag for review.
- The combined multi-brand calendar filter is not built; each brand has its own calendar.
- Drag-and-drop was not browser-automated; the equivalent form path is tested.
- MHP has no branded blog template yet; the neutral default template is used until one is committed.
