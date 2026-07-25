# Content-cluster engine (`CC`)

A **topical-authority content cluster** generator. One subject goes in; a pillar
article plus six interlinked supporting article briefs come out — built from a
completed relaunch's strategy, so the business owns the subject in Google and is
citation-ready for ChatGPT / Perplexity. It is our own-IP answer to the standalone
content tools in the market (e.g. Digital Womble "Content Strategy"), with one
difference that matters: the topics come from **strategy**, and every claim runs
through the same **no-invention QA** as the rest of the pipeline.

## What it produces

A single JSON object (`cc.json`), one **cluster**:

- **topic** — the one subject this cluster makes the business own.
- **money_page** — the single conversion page every article links to (slug,
  purpose, default anchor). The whole cluster funnels authority + clicks there.
- **pillar** — the cornerstone article brief. Hubs to all six supporting slugs.
- **supporting** (exactly 6) — each owns one distinct **fan-out query** (a real
  sub-question a buyer/AI asks) and links back to the pillar.

Each **article brief** is publish-ready structure, not a finished draft: `slug`,
`working_title`, `target_query`, `search_intent` (buy/compare/learn), `angle`
(grounded in S3), `outline` (H2s), `key_points`, a 40–60-word **snippet_answer**
(featured-snippet / AI-citation ready), `faqs`, `internal_links`,
`money_page_anchor`, and SEO `meta_title` / `meta_description`. A human or a later
stage expands each brief into prose.

## Why briefs, not full articles

Briefs are the unit our QA can actually verify for no-invention, and the unit a
human can sign off fast. Full-draft generation is a later add-on; the strategy,
structure and provenance — the hard part — live here.

## How it grounds — strategy first, not a keyword

The engine consumes **S2** (dream-buyer profile) and **S3** (message & voice) from
a completed run, plus the intake fields the topic draws on. Topics and fan-out
queries are mined from the buyer's real language (objections, trigger events, the
"instead of" alternatives, real customer words) — not from a keyword you type into
a generic tool. That is the competitor's structural gap: they optimise a topic you
hand them; we derive the right topic from what the business actually is.

## No-invention QA (`qaContentCluster`)

Same bar as the pipeline — nothing is invented:

- **`cc.number_invented` (FATAL)** — every figure must trace to intake / S2 / S3 or
  be visible arithmetic over allowed numbers. No bare years, no unearned
  percentages. This is the check a "live search-volume" generator cannot pass.
- **`cc.quote_fabricated` (FATAL)** — any double-quoted testimony must be copied
  from a real S2 verbatim or a consumed intake field.
- **`banned_phrase`** — global marketing-speak + the customer's H3 never-words,
  anywhere in the cluster (real quotes exempt).
- **Structural authority** — unique slugs; distinct fan-out queries; every
  supporting article links back to the pillar and the pillar hubs to all six;
  no dangling internal links; every article carries a money-page anchor; each
  angle shares vocabulary with the strategy (no untethered topics); the snippet
  stays snippet-sized.

Fail → one critique-retry → park for a human, exactly like S1–S9.

## Running it

```bash
# From a completed relaunch run (reads its S2 + S3, writes cc.json alongside):
npm run content -- --run runs/<run-id>

# Self-contained mechanics run (generates S2+S3 then the cluster, no API cost):
npm run content -- --fixture trades --mock
```

## Where it sits

`CC` is a **standalone** `StageDef`, run through the same generic stage runner as
S1–S9 but **not** part of the paid nine-deliverable `STAGE_ORDER`. It runs over an
already-completed relaunch, so it can never destabilise the core pack. When the
recurring **72-Day Package** platform lands, this becomes its content stage —
refreshing each customer's cluster on the cadence. Not before revenue.

**IP:** own IP, written from scratch, inspired-by-concepts only. No third-party
licensed material enters the code, the prompt, or the product.
