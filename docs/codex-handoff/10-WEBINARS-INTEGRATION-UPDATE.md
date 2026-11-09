# 10 · Native webinars — integration update for Codex

From: Claude (owner's webinar branch). To: Codex, for integration, review and deploy sequencing.
Date: 9 Nov 2026. Owner: Martin Howard.

PR **Martoon196/relaunch72#74** is now **ready for review** against `codex/relaunch72-platform-foundation`.
Head `e432d98db113830c9b8f09c92d94712286418b6b`, tree `cd3c6a186dde787093d542cc61e9d1781ff40a91`, base `10e77a6`
(trunk unchanged since the last merge; the PR is mergeable-clean).

**Constraint that still stands: do not deploy until the owner has run the live Cloudflare test.** Merging is
your call once review passes; the migration is additive and the 143 recovery release stays ready after it.

## What changed since the last handoff (page 09)

1. **Your ffmpeg direction was followed.** The service stays on Render's native Node runtime. The studio relay
   resolves `ffmpeg` from PATH by default; `WEBINAR_STUDIO_FFMPEG` is only an optional override. Finding the
   executable is not treated as proof: at start-up the server checks pipe input, RTMPS output, WebM/Matroska and
   MP4 demuxers, FLV muxer, Opus and AAC decoders and the AAC encoder, then pushes a Chrome-shaped and a
   Safari-shaped one-second clip through the relay's exact arguments to stdout and reads the FLV back. No network,
   no provider, about half a second. The Webinars setup panel lists every check with its result, and the studio
   turns on only when the required checks pass (Safari's are reported separately). No npm ffmpeg package, no
   Docker. I could not open render.com from the build environment, so "Render includes FFmpeg" rests on your
   confirmation and is verified by the probe after deploy.

2. **Audit pass.** A full-diff review found no security defects and ten real issues, all fixed with regression
   tests (commit `19b7161`). The ones that matter for integration:
   * Migration `0144_native_webinars.sql` changed in two places: confirmation jobs now expire no earlier than
     two days out (late replay registrants get their link), and a longer ready recording for a live input
     replaces a shorter fragment as the replay. **New SHA-256:
     `dea9e16c2743b58b5901f95be06abcfc39d2237dc087b1c949478eb17357f3af`**, pinned in `src/db/webinar-schema.ts`
     and asserted by `test/db/sql-contract.test.ts`. The migration is unreleased, so no deployed ledger is affected.
   * Attendee room polling is limited per registration, not per client address (an office NAT is no longer
     throttled as one person). Signed playback tokens are reused until 20 minutes remain. Hot attendee routes make
     one database round trip. The explicit marketing opt-in reaches the CRM as `opted_in`.
   * The studio WebSocket assembles frames in linear time.

3. **hls.js 1.6.19 → 1.7.4** (published 28 Oct 2026). Lockfile and `security/sbom.cdx.json` regenerated; the
   supply-chain gate passes with 118 external packages.

## Evidence at this head

| Kind | Result |
|---|---|
| `npm run typecheck`, full `npm test` | 4315 tests, 4252 pass, 0 fail, 63 skipped (DB tests skip without the explicit disposable-DB switch) |
| Disposable PostgreSQL integration (`test/db/native-webinars*.integration.test.ts`) on the real `r72_content_command` and `r72_crm_command` roles | pass (migrated through 0144, checksum above) |
| Studio relay through real ffmpeg into a local RTMP receiver; probe failure cases via wrapper executables | pass |
| Studio in Chromium with fake devices and screen share | H.264 1280×720 + AAC received; no key in the page |
| Live Cloudflare (encoder and studio) | **not run**; needs the owner |

## What I need from you

1. **Review and merge order.** The unmerged Creative Studio branch (`claude/exciting-dirac-q38u2u`) also uses
   migration number 0144. Whichever merges second renames its file to 0145, updates its schema constant, re-pins
   the checksum and the `runtime-readiness.ts` clauses, and re-runs `sql-contract` and `runtime-readiness` tests.
   If webinars go second, the edits are mechanical and I can do them on request.

2. **Deploy sequencing, after the owner's live test:** capable release to every consumer → migrator → verify
   `app_private.schema_migrations` shows 0144 with the checksum above and `/ready` → restart. While 0144 is
   pending the webinar service is not composed and `/portal/webinars` shows the setup state. Rollback to the 143
   release is safe after 0144; there is no down-migration. `WEBINAR_EMAIL_MODE=off` and
   `WEBINAR_WORKER_ENABLED=false` are the no-deploy brakes.

3. **Configuration names to set on Render (never values here):** `CLOUDFLARE_ACCOUNT_ID`,
   `CLOUDFLARE_STREAM_API_TOKEN`, `CLOUDFLARE_STREAM_CUSTOMER_CODE`, `CLOUDFLARE_STREAM_SIGNING_KEY_ID`,
   `CLOUDFLARE_STREAM_SIGNING_JWK`, `CLOUDFLARE_STREAM_WEBHOOK_SECRET`, `WEBINAR_ACCESS_SECRET`,
   `WEBINAR_EMAIL_MODE` (keep `off` until reviewed), `WEBINAR_EMAIL_TEST_RECIPIENTS`, `WEBINAR_EMAIL_SENDERS`,
   `WEBINAR_PUBLIC_ORIGIN`, `WEBINAR_WORKSPACE_ORIGINS`, and optionally the `WEBINAR_MAX_*`,
   `WEBINAR_RECORDING_RETENTION_DAYS`, `WEBINAR_WORKER_ENABLED`, `WEBINAR_STUDIO_*` bounds. Full table in
   `docs/webinars.md`.

4. **Post-deploy check before the owner's live test:** Webinars → Setup status → *Compatibility checks on this
   server*; every required check should pass on Render's ffmpeg. If one fails, report the exact failing check.
   The reviewed contingency is Render's Docker runtime with `apt-get install -y ffmpeg`; it is not applied.

5. **Keep unrelated work off:** email outreach, Apollo (including the stopped automation), paid advertising and
   budget optimisation are untouched and must stay so. The MHP YouTube funnel is untouched; the reversible
   cutover plan is in `docs/webinars.md` and runs only after a reviewed native webinar.

## The owner's live test (unchanged, for the record)

One live input on the existing Cloudflare account, `WEBINAR_EMAIL_MODE=test`, one owner-only registrant,
5-minute rehearsal from OBS, Go live, attendee on a phone, CTA, Q&A, End session, replay. Then the same from the
Studio in Chrome with camera, microphone and a shared screen, recorded as separate evidence: *Encoder connected*
while sending, attendees see the composite, the replay contains the studio picture and audio. This is the only
proof of the RTMPS → Cloudflare → recording path.

## Map

Code: `orchestrator/src/webinars/` (service, worker, stream, studio, websocket, probe media, public router/view,
client scripts), `orchestrator/src/portal/webinar-router.ts` and `webinar-view.ts`, wiring in `portal/router.ts`,
`portal/postgres-platform.ts`, `server/index.ts` (HTTP upgrade for `/api/webinars/studio`), `mhp/mount.ts`.
Tests: `test/webinars.test.ts`, `test/webinars-studio.test.ts`, `test/db/native-webinars*.integration.test.ts`,
harness `test/db/webinar-harness.ts`, preview `test/manual-webinars-preview.ts`. Decisions D-068 to D-070.
