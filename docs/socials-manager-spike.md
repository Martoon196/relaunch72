# SPIKE — AI Socials Manager

Turn our existing **S8 (30-day social content)** into scheduled, auto-published,
on-brand posts across a customer's connected accounts — inside the portal, behind
the no-invention QA + informed-consent gate — by **renting** a social API rather
than building a social-media-management platform. Makes the Phase D "AI Social
Manager" north star (decisions D-051) concrete.

**Status:** mock-able core **built + tested** (`orchestrator/src/social/`,
`npm run social`, 9 tests, proven end-to-end in mock mode). Remaining: the live
Ayrshare proof (real account, cost-per-post) + the written go/no-go — both
founder-gated on a paid key. Behind the first paid pack.

**Built so far:** the `SocialPublisher` interface + `MockPublisher` +
`AyrsharedPublisher` (live, key-guarded); `buildSchedule` (S8 → dated posts);
`qaSocialPost` (pre-publish no-invention guard); the `npm run social` CLI (writes
`social-plan.json`). A dry run over a mock S8 pack schedules all 30 posts with a
clean QA pass and £0 cost.

## The question the spike answers

Can we publish a week of S8 posts to ≥2 real accounts on a schedule via a rented
API, with our QA gate and opt-in warning in the flow — and what does it cost per
post? Deliverable is a **go/no-go on the rent vendor + a real cost-per-post
number**, before committing to the full manager or a self-host migration.

## Plug options (rent now, own later)

- **Rent (spike uses this): [Ayrshare](https://www.ayrshare.com)** — API-first,
  built to bolt posting + analytics into your own product; multi-profile,
  white-label; X, Instagram, Facebook, LinkedIn, TikTok, YouTube, Pinterest,
  Google Business Profile, Threads. Fallbacks: Vista Social, SocialPilot, Sendible.
- **Own (phase 2, out of spike): self-host Postiz or Mixpost** — no per-seat fee,
  full white-label, we control the pipeline. Migrate here if socials becomes core
  — the same "rent the components, own the assembly" call we made on video.

> Vendor facts are from Jan-2026 knowledge (egress blocked in this env). Verify
> current pricing, platform coverage and API terms before committing.

## Architecture — snaps onto what we already have

- **Input:** S8 output (`posts: {day, platform, format, hook, body, cta, pillar}`)
  — already generated and already QA'd by `qaS8`. S2/S3 voice enforced upstream.
- **New `orchestrator/src/social/` module** — a swappable publisher, mirroring the
  LLM client's mock/live split:
  ```ts
  interface SocialPublisher {
    connectAccount(platform, creds): Promise<AccountRef>
    schedule(post, whenISO): Promise<ScheduledRef>
    publish(post): Promise<PublishResult>
    status(ref): Promise<PostStatus>
  }
  ```
  Implementations: `AyrsharedPublisher` (live) + `MockPublisher` (tests, zero
  external calls). Vendor-swappable by design → Ayrshare→Postiz is a config change.
- **Pre-publish guard `qaSocialPost(post, intake, prior)`** — final no-invention
  pass per post in case a human edited it: numbers trace to intake/S2/S3, no
  fabricated quotes/claims, H3 never-words, valid platform/format. Reuses the
  shared checks in `qa/checks.ts`.
- **Consent + control (decision D-053 carries over):** opt-in per customer;
  informed-consent warning at connect time; every scheduled post visible in the
  portal (approve / skip); auto-post toggle; per-post audit trail (what, when, QA
  verdict).

## Spike deliverables / done-when

1. `SocialPublisher` interface + Ayrshare adapter + mock adapter.
2. `qaSocialPost` + tests (no-invention on posts).
3. CLI `npm run social -- --run runs/<id> --schedule <startDate> [--mock]` — reads
   S8, runs `qaSocialPost` on each post, mock prints the schedule / live queues it.
4. One **real** end-to-end: connect a throwaway account, schedule 5 posts, confirm
   they publish. Record **cost/post + latency**.
5. Written **go/no-go**: rent vs own + a cost model for the recurring €/mo tier.

## Non-goals (explicitly out of the spike)

Full portal UI, engagement / LLM-visibility analytics (follow-on — mirrors
BabyLoveGrowth's tracker), multi-tenant scale, self-host migration, the paid-vendor
commitment (founder decision).

## Dependencies

S8 (done) · portal auth Phase A (done) · a paid Ayrshare account + connected test
accounts (founder-gated — needs a go + credentials; nothing gets created or spent
without that).

## Risk / watch

Per-post API cost (real COGS — shapes the recurring price) · IG/TikTok app-review
requirements · per-platform automation ToS · rate limits.
