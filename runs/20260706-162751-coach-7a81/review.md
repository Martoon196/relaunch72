# Your Relaunch Stack — strategist review

- **Run**: `20260706-162751-coach-7a81` (live)
- **Business**: Deep End Coaching
- **Assembled**: 2026-07-06T17:10:42.638Z
- **Cost**: $2.6439 · tokens in/out 133756/149511

## Deliverables

| Stage | Deliverable | File | Prompt | Model |
|---|---|---|---|---|
| S1 | Relaunch Scorecard | `s1.json` | 1.0.1 | claude-sonnet-4-6 |
| S2 | True Buyer Profile | `s2.json` | 1.0.0 | claude-sonnet-4-6 |
| S3 | Message Spine + Voiceprint | `s3.json` | 1.0.0 | claude-sonnet-4-6 |
| S4 | Offer Stack Blueprint | `s4.json` | 1.0.0 | claude-sonnet-4-6 |
| S5 | Relaunch Roadmap | `s5.json` | 1.0.0 | claude-sonnet-4-6 |
| S6 | Shopfront Pack | `s6.json` | 1.0.0 | claude-sonnet-4-6 |
| S7 | Follow-Up Engine | `s7.json` | 1.0.1 | claude-sonnet-4-6 |
| S8 | 30-Day Content Engine | `s8.json` | 1.0.1 | claude-sonnet-4-6 |
| S9 | Relaunch On A Page | `s9.json` | 1.0.0 | claude-sonnet-4-6 |

## QA flags for this review

- **S1**: needed 2 attempts (retry critique applied) — read it with extra care
- **S3**: needed 2 attempts (retry critique applied) — read it with extra care
- **S4**: needed 2 attempts (retry critique applied) — read it with extra care
- **S6**: needed 2 attempts (retry critique applied) — read it with extra care
- **S7**: needed 2 attempts (retry critique applied) — read it with extra care
- **S8**: needed 2 attempts (retry critique applied) — read it with extra care
- **S9**: needed 2 attempts (retry critique applied) — read it with extra care

## Global lint (S10)

- `s10.s3_banned_word` S8.posts[7].body: contains "transformation", which S3's voice guide bans — the voice list binds every copy deliverable
- `s10.s3_banned_word` S8.posts[24].body: contains "scale", which S3's voice guide bans — the voice list binds every copy deliverable
- `s10.price_conflict` S6.sales_page.sections[4].body: quotes a price of 1,200, that is neither an S4 recommended price nor a price the intake states — every price in the pack must agree with the Offer Stack
- `s10.price_conflict` S7.promo_seq[3].body: quotes a price of 1,200 that is neither an S4 recommended price nor a price the intake states — every price in the pack must agree with the Offer Stack
- `s10.price_conflict` S7.promo_seq[4].body: quotes a price of 1,200 that is neither an S4 recommended price nor a price the intake states — every price in the pack must agree with the Offer Stack

## Sign-off

- [ ] Read every deliverable against the intake — would the owner say "you clearly read my answers"?
- [ ] Quotes spot-checked against C2 / intake (no invented proof anywhere)
- [ ] Prices consistent with the Offer Stack Blueprint everywhere they appear
- [ ] Approve → delivery fires (LS-19) · Reject a stage → targeted re-run with strategist notes

> This pack is marketing material prepared from information you provided. It contains no promise of revenue, results or outcomes — what you earn depends on your market, your offer and your follow-through. Review everything before publishing; you are responsible for claims made in your own name.
