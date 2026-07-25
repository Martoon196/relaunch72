# Paid-ads rail (`AD`)

Generate ad campaigns from a completed relaunch's strategy, then load them into
the customer's ad account as **paused drafts** — never auto-spend. The creative
side is the real white-label opportunity (bidding is automated by Meta
Advantage+ / Google Performance Max); we produce the copy, angles, audience
suggestions and creative briefs, grounded in the same strategy and gated by the
same no-invention QA. Built mock-first (decisions D-055): runs at £0, a real key
turns it live.

## Two halves

1. **Generation — `AD` stage** (`orchestrator/src/ads/stage.ts`). A `StageDef`
   run through the generic stage runner (schema-fail / QA-fail → critique retry →
   park), grounded in **S2** (buyer) + **S3** (message & voice) + **S4** (offer).
   Prompt: `prompts/ad-campaign.md`. Output (`ad.json`): objective, platforms,
   audience (who / signals / exclusions), and 2–4 ad sets — each an angle, 1–3
   primary texts, 3–8 headlines (≤30 chars), 2–4 descriptions (≤90 chars), a CTA,
   a creative brief, and the landing target.

2. **Publishing — `AdsPublisher` rail** (`orchestrator/src/ads/`). Swappable
   backend (same mock/live pattern as the LLM client, socials, keyword):
   `MockAdsPublisher` (deterministic, records drafts) + `MetaAdsPublisher` (live,
   key-guarded; creates a **PAUSED** campaign via the Marketing API). A later
   Google/Zernio adapter is a new class, not a rewrite.

## No-invention + ad-policy QA (`qaAdCampaign`)

Ad copy is the highest-stakes place a fabrication can appear — it spends money and
must pass Meta/Google policy. So:

- **`ad.number_invented` (FATAL)** — every figure traces to intake/S2/S3/S4 or is
  visible arithmetic. No invented review counts, star ratings, "as seen on".
- **`ad.quote_fabricated` (FATAL)** — quoted testimony is a real S2 verbatim.
- **`ad.outcome_promised`** — no guaranteed results / "double your revenue"
  across any headline, body or description (banned by Meta & Google, and by our
  promise-only-what-you-control rule).
- **`ad.headline_too_long` / `ad.description_too_long`** — network char limits.
- **`ad.angle_ungrounded`** — each angle shares vocabulary with the strategy.
- Banned marketing-speak + the customer's H3 never-words.

## Safety model (three modes)

```bash
npm run ads -- --run runs/<id> --mock      # mock LLM + mock publisher (£0 mechanics)
npm run ads -- --run runs/<id>             # real copy, mock publish (safe preview)
npm run ads -- --run runs/<id> --publish   # real copy → PAUSED drafts in Meta (needs keys)
```

A real ad account is touched **only** with explicit `--publish`, and even then
every campaign is created **paused**. Nothing in this rail un-pauses or spends —
the customer reviews and enables in their own account. Behind the first paid pack.
