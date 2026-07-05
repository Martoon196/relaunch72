# Relaunch72

AI-powered done-for-you marketing system. Customer pays → completes the 45-question
Deep Intake → an orchestrated pipeline of chained Claude API calls generates 9
marketing deliverables → automated QA → human sign-off → branded delivery within 72 hours.

**Source of truth for all specs is Notion** (Build HQ, Deep Intake v1.0, Pipeline Spec v1.0,
Offer Spec v1.1). Field IDs (A1–H4) and stage contracts (S0–S10) in those docs are canonical —
code mirrors them, never redefines them.

## Monorepo layout

| Path            | What                                                              |
| --------------- | ----------------------------------------------------------------- |
| `/orchestrator` | TypeScript pipeline: S0 intake QA gate, stages S1–S10, QA layer, run manifests, CLI |
| `/prompts`      | Versioned stage prompts (`*.md` with `version|stage|model|date` header block) |
| `/fixtures`     | Dummy intakes (clearly fictional test businesses) for pipeline development |
| `/runs`         | Pipeline run outputs + manifests (gitignored — contains customer data in production) |
| `/site`         | Next.js public site (M4)                                          |
| `/admin`        | Admin QA queue (M3)                                               |
| `/docs`         | Decision log and engineering docs                                 |

## Quick start

```bash
npm install
cp .env.example .env       # add ANTHROPIC_API_KEY for live runs
npm run pipeline -- --fixture trades            # full nine-deliverable stack
```

Flags:

- `--fixture <trades|coach|ecom>` — pick a dummy intake from `/fixtures`
- `--input <path.json>` — run an arbitrary intake file instead of a fixture
- `--through <S0…S9>` — stop after this stage (default `S9`, the full stack)
- `--mock` — run against a deterministic mock model (no API key, no cost; exercises
  schema validation, QA checks, retry and manifest mechanics; **never** a substitute
  for a real quality review)

Each run writes `runs/<timestamp>-<name>/` containing `intake.json`, per-stage outputs,
raw model responses per attempt, and `manifest.json` (prompt versions + hashes, models,
token counts, cost estimate, QA results, timestamps).

Exit codes: `0` ok · `2` intake rejected by S0 (nudge required) · `3` a stage parked for human review · `1` unexpected error.

## Rules that live in code

- **Fact-echo**: S2 `verbatims` must be exact substrings of intake field C2 — hard fail.
- **No invented numbers**: S1 leak estimates must derive from B2/B3.
- **Retry policy**: schema-fail or QA-fail → one retry with the failure critique appended;
  second failure parks the run for human review. Failed stages are never silently shipped.
- **No fabricated proof, ever** — in code, fixtures, copy or demos (hard rule #1).
- Secrets in env only; `.env` is gitignored.

See `/docs/decisions.md` for every judgement call made along the way.
