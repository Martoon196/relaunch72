# Decision log

Every judgement call, newest last. Format: date · decision · reasoning · revisit-when.

## 2026-07-03 · M1 vertical slice

**D-001 · Spec interpretation: QA thresholds not specified in Pipeline Spec v1.0 are set here, conservatively.**
The spec defines *what* each QA rule enforces but not every numeric threshold. Choices (all in
`orchestrator/src/qa/`): S2 requires ≥2 verbatims, each ≥10 chars; S1 evidence quotes must be
≥12 chars (or an exact full field value); S1 leak-estimate figures must be justified by
*visible arithmetic* — small counts (≤31) and period constants (×12/×52) present in the same
string, applied to B2/B3/B2×B3 with 1% rounding tolerance. (An earlier hidden-multiplier rule
with 2% tolerance was rejected in testing: it let a fully invented £123,456 pass.) Revisit after
LS-18 graded runs.

**D-002 · "Exact substring" checks normalize Unicode quotes and whitespace only.**
Fact-echo checks (S2 verbatims ⊂ C2, S1 evidence quotes ⊂ intake) compare after NFC
normalization, curly→straight quote mapping and whitespace collapsing — nothing else (case is
preserved). Customers paste quotes with smart quotes; models emit straight ones. Without this,
byte-exact comparison hard-fails on typography, not on substance. The check still rejects any
paraphrase, reorder, or word change.

**D-003 · Banned-phrase lint runs from S1/S2 onward, not only at S10 assembly.**
Pipeline Spec lists the banned-phrase scan under S10/global QA, but Global QA principle 3 calls
the list global. Running it per-stage (retry-with-critique applies) means the M1 gate review sees
de-genericized output. List v1 taken verbatim from Pipeline Spec v1.0. Scope split: the GLOBAL
generic-phrase list applies to every stage; the customer's H3 never-words bind voice-bearing copy
stages (S3+) only — an audit/ICP legitimately says things like "the cheap certificate mills" even
when the customer bans "cheap" from their own copy.

**D-004 · S0 optional LLM "is this answer substantive?" call is stubbed OFF for M1.**
Spec permits one LLM classification per flagged field. M1 fixtures are exercised with the
deterministic checks (required / min-words / placeholder-similarity / option validation) only;
`RELAUNCH72_S0_LLM_CHECK` exists as the switch. Wire it in M3 with the real intake form.

**D-005 · Placeholders authored where the Intake spec says "placeholder shows a worked example" without giving text.**
Exact placeholder text from the spec is used where provided (A2, B4, D1 structure). C1/C3/C4/C5/G1
worked examples are authored here and live in `orchestrator/src/intake/spec.ts` — review them at
M3 form build (LS-11). Placeholder-similarity in S0 checks answers against whichever text ships.

**D-006 · A3 site snapshot fetch (optional per S1 spec) deferred to M2+.**
Fixtures carry fictional URLs; fetching them is meaningless. S1 receives A3 as text. A fetcher
slot exists in the stage input builder.

**D-007 · `/runs` is gitignored.**
In production it holds customer data — never committed. Fixture runs for a gate review can be
force-added deliberately (`git add -f runs/<dir>`).

**D-008 · Mock model mode exists for mechanics testing only.**
`--mock` produces deterministic, intake-derived stage outputs so schema validation, QA checks,
retry-with-critique, parking and manifests can be exercised without an API key. Mock manifests are
stamped `"mode": "mock"`. Mock output is never a substitute for the founder quality review
(adjacent to hard rule #1: nothing synthetic presented as real).

**D-009 · Fixtures are clearly-fictional businesses; their C2 quotes are synthetic test inputs.**
Hard rule #1 bans fabricated proof. Pipeline development requires C2 content, so fixtures use
invented businesses with invented customer quotes, used solely as test inputs — never in
marketing, demos-as-proof, or deliverables to real customers. Each fixture carries a
`"_fixture_notice"` field stating this.

**D-010 · Model selection: env override > default (`claude-sonnet-4-6`) > prompt-header model.**
Per-stage config via `RELAUNCH72_MODEL_<stage>` makes the S3/S4/S6 stronger-model A/B a config
change, per Build HQ. The prompt header records which model the prompt was written against; the
manifest pins what actually ran.

**D-011 · Anthropic client settings.**
Official TypeScript SDK, non-streaming (stage outputs ≤ 8k tokens), `maxRetries: 4` for
429/5xx (M5 hardens further), adaptive thinking on. A `refusal` stop reason parks the stage
immediately (no retry) — a safety refusal is a human-queue matter, not a prompt-fix matter.

**D-012 · S2 does not receive S1 output.**
Pipeline Spec S2 "In:" lists C1–C8, A5, A6, B2 only. The runner passes stages exactly their
declared inputs — no stage reads intake or prior output it doesn't need (spec: "No mega-prompt").

**D-013 · Orchestrator runs as a plain Node CLI in M1.**
Deployment target question (Vercel serverless vs Railway worker) is deferred: a full S1–S10 run
is ~10 sequential model calls over several minutes, which will exceed serverless request limits —
expect a Railway (or similar) worker proposal at the M2 gate. Nothing in M1 couples to either.

**D-014 · Adversarial review outcomes (43 findings triaged): fixes, accepted residuals, rejections.**
A five-dimension adversarial review (spec fidelity ×2, correctness, QA-bypass, fixtures/rules) ran
against the M1 slice. Fixed: banned-phrase scan now typography-tolerant (curly quotes,
hyphen/space variants, zero-width chars); £k/£m shorthand and NBSP-split thousands parse as their
real magnitude; the no-invented-numbers rule now covers top_3_leaks/quick_wins/narrative and
allows intake-echoed figures, period lengths ("90 days") and year mentions; S1 evidence can't be
gamed by trivial full-value quotes or one snippet reused six times (≥3 distinct spans required);
S2 verbatims must be distinct, ≥15 chars, ≥3 words; channel matching requires token-subset (not
single-token overlap); exclusions must be substantive; JSON extraction is balanced-brace and
string-aware; S0 validates H3 box types, slider keys, link shape, duplicate selections, and
whitelists the consent key; E5 label restored to canonical text; S1 prompt no longer references
C8 (not in its input contract; prompt → v1.0.1); Haiku-class models don't get adaptive thinking.
Accepted residuals (human gate is the backstop, revisit after LS-18): spelled-out numbers
("twelve thousand"), %-figures ≤100, deliberately planted multipliers in leak arithmetic,
adversarial homoglyphs, placeholder-similarity misses on genuinely-similar honest businesses.
Rejected findings are recorded in the review artifacts (session transcript).

**D-015 · Customer's own words are exempt from the banned-phrase lint.**
The verbatim-quoting QA and the banned-word lint can collide: a customer whose C2 review says
"seamless" must be quotable without parking the run. Resolution: S2's `verbatims` array is exempt
wholesale, and double-quoted spans inside any S1/S2 text are stripped before the scan — the ban
applies to generated prose, not to quoted customer language. A model could theoretically hide
banned prose inside quotes; the human gate reviews all quoted material anyway.

## 2026-07-04 · M2 backbone

**D-016 · S3–S5 shipped as v0.9.0 drafts, to be re-based on founder skill sources.**
Message Spine + Voiceprint (S3), Offer Stack Blueprint (S4) and Relaunch Roadmap (S5) are built
from the Pipeline Spec contracts plus craft; prompts carry version 0.9.0 until the owned skills
(core-message, offer-architect, roadmap notes) are pasted into the Notion "M2 skill sources" page
and ported in own-IP language (LS-5/LS-13) — then they graduate to 1.0.0. Mechanical
interpretations, all revisitable: differentiators are strings that must contain a double-quoted
E2/E3 verbatim; S4 recommendations cite D-fields by ID or quote; a >10× B2 price needs a
substantial rationale; risk reversals are scanned against outcome-promise patterns; G2 band caps
map to {<2:2, 2–5:5, 5–10:10, 10+:40} hours (hard fail); S5 self-consistency forbids actions on
channels in the plan's own do_not_do. H3 never-words bind from S3 onward (the voice starts here).

**D-017 · Founder ratifications (2026-07-04): Lexicon v1, Offer Spec v1.1, HTML→PDF doc generation.**
Lexicon adopted as `orchestrator/src/lexicon.ts` (display layer only; internal IDs stay canonical).
Doc generation is HTML→PDF (templates in git, rendered headless-Chromium; no Google Cloud
account/OAuth dependency) — Google Docs API rejected for account/ops friction, revisit only if
customers demand editable Docs.

## 2026-07-05 · S3–S9 skill-port integration

**D-018 · S3/S4/S5 prompts graduated to v1.0.0; S6–S9 shipped; per-stage no-invention checks are FATAL.**
The owned-skill port (LS-5/LS-13) landed: S3–S5 prompts re-based on the licensed method sources in
own-IP language (D-016's condition met — 0.9.0 → 1.0.0), S6–S9 written fresh. Every stage now has
a fatal no-invention path (`QAIssue.fatal` → park immediately, NO retry): S3 message copy, S4
prose + outcome-promising risk reversals (upgraded to fatal — that text ships into S6 guarantee
blocks), S5 plan figures, S6 quotes/numbers/credential-words, S7 quotes/numbers/percentages, S8
quotes/numbers, S9 table tracing + prose figures. Notable interpretations, all revisitable at the
M2 gate:
- **Cross-stage haystacks.** S6–S9 QA traces quotes and figures against the *full prior-stage
  outputs* (first stages to use the runner's `prior` argument). S6 quotes may come only from S2
  verbatims + consumed intake (E1–E4, A1, A5); S7 from S2/S3/S4 + F2/A1; S8 from C2 + S2/S3/S5
  (S3's banned_words leaves excluded so a banned phrase can't launder itself in as "sourced").
- **Stricter-than-S1 number rules where the surface is sales copy.** S6: no bare-year carve-out
  (a year in web copy reads as a founding/credential claim; S6 doesn't consume A4) and no
  B2/B3 arithmetic path; percentages must be input-echoed (bare "100%" tolerated as puffery).
  S7: *every* percentage must be input-echoed — %-stats are the classic fabricated proof in email.
- **S5 phase labels.** "Days 31–90" is a calendar position, not a projection — numbers ≤366 pass
  in `phases[].days` only (the draft rule would have parked every real plan).
- **S8 platform matching** is exact normalized string equality against F5 (closed enum) — NOT the
  C7 alias matcher, whose `x → twitter` rewrite breaks on the platform "X". Single F5 pick ⇒
  platform_a = platform_b. Per-platform format pairing lives in `S8_PLATFORM_FORMATS` (checks.ts)
  and must stay in sync with the prompt's format lists.
- **S7 shape elaborations**: subject_variants carry `{subject, hook_category}` (10-value own-IP
  enum) so "3 distinct hooks" is a Set-size check; `list_warmup_note` is
  `{list_status, note, reintro_email}` so "F2-cold ⇒ warm-up email present" is mechanical. Merge
  tokens fixed at `{{first_name}}`/`{{link}}`; exactly one `{{link}}` per body = "one CTA".
  F2 staleness heuristic is one-way (never/years/6+ months force `cold`; empty forces `none`).
- **S9 table tracing**: every `numbers_table` row declares its source (B1–B6, G1, S1–S5) and every
  figure in `value` must literally appear in that source (extractNumbers normalizes commas/£/k).
  G1 kept in the source enum (it's in S9's In list; its figure is guaranteed restated in S5).
  Horizon rule: forward spans > 92 days and annualisation markers fail (non-fatal).
- **Voice-scope**: H3 never-words now bind S4 (offer names flow into customer-facing copy) and the
  copy stages S6–S8; S9 deliberately stays global-list-only (bank-manager register, not brand voice).
- **Schema tightenings** (S4): recommended_stack ≤4, pricing_moves 2–6, category_note ≥60 chars,
  prices strictly ascending entry→core→premium with ≥1 entry + ≥1 core (QA, not schema).
- **CLI default** `--through` is now S9 — a run is the full stack unless narrowed.
Residual gaps unchanged in kind from D-014 (spelled-out numbers, quote-free fabricated proof like
"our clients rave", urgency theatre without figures) — prompts ban them explicitly; the S10 gate
and the human queue remain the backstop.

**D-019 · S10 is deterministic: lint flags for the strategist gate, never auto-retries.**
S10 (assembly & strategist gate) makes no LLM call, so its findings can't be fixed by
retry-with-critique — they queue for the human with the bundle. Checks: global banned-phrase
re-scan per stage voice scope; S3's own `voice.banned_words` additions bind S6–S8 (per-stage QA
only covered S7); currency amounts in S6–S8 must be S4 recommended prices or intake-stated prices
(S5/S9 excluded — their QA permits visible B2/B3 arithmetic this scan can't distinguish);
positioning-echo is a conservative zero-overlap detector on stopword-filtered tokens (only a doc
sharing NOT ONE distinctive token with S3's positioning+pillars flags); at least one promo email
must name a stack offer (offer NAMES only — lead_offer prose would make token overlap trivially
true). Assembly writes `bundle.json` + `review.md` (sign-off checklist, all stage flags, retry
warnings) into the run dir; manifest gains `s10`. The compliance line shipped on the bundle is
DRAFT v0 — founder ratifies exact wording at LS-15 before anything reaches a real customer.

**D-020 · Doc generation shipped: shared brand tokens, per-deliverable HTML templates, Chromium PDF.**
`orchestrator/src/docs/` renders a completed run to branded documents: `brand.ts` (tokens —
dark-premium ink, electric accent, grotesk headlines; the seed for LS-9), `templates.ts` (layout +
nine per-deliverable renderers + bundle index; every string HTML-escaped; compliance line in every
footer; mock runs carry a visible not-for-delivery notice), `render.ts`/`npm run render`
(HTML always; `--pdf` via the pre-installed Chromium through playwright-core, path overridable with
`RELAUNCH72_CHROMIUM`). Rendering is deliberately decoupled from the pipeline — fix a template,
re-render, nothing re-generates. LS-15's card said "Gamma or Google Docs API"; built to the
founder-ratified D-017 (HTML→PDF) instead. Currency symbol in the S4 template defaults to £ —
parameterise when a non-UK beta customer appears. Also: PERIOD_AFTER now treats hours/minutes/
seconds as period lengths (a real "48-hour turnaround" claim must not park a run; ≤366 bound and
the human gate still apply).

**D-021 · First live full-stack attempt taught two lessons (2026-07-05).**
Trades and coach parked at S1 on the first M2-gate attempt. Post-mortem: (1) attempt 1 hit the
16k max_tokens cap — adaptive thinking shares the output budget and live thinking ran long, so the
one retry was spent on a truncation critique instead of a QA critique. All stages now run at
max_tokens 32000 (a cap, not a spend). (2) The leak-arithmetic rule only accepted B2/B3 as bases,
so the coach model's honest "2 × £300 = £600" (F3 states £300) was rejected as invented.
`inventedNumbers` now takes explicit extra arithmetic bases; qaS1 passes the intake-echoed number
set, so visible working on any customer-stated figure passes. Copy stages (S6–S8) deliberately do
NOT get arithmetic bases — prices there must be exact echoes (S10 cross-doc price check guards the
gap regardless).

**D-021a · Addendum: streaming transport; visible sums.**
The SDK requires streaming above ~8 minutes of potential generation, so at max_tokens 32000 the
client now uses `messages.stream(...).finalMessage()` (supersedes D-011's non-streaming choice;
the runner contract is unchanged). Second live lesson from the same trades run: "£640 (= £600
leaflets + £40 boost, F3)" is visible ADDITION of intake-stated figures — the rule now accepts a
value equal to the sum of two other numbers in the same string when each addend is intake-echoed
or a small count (arithmetic-base stages only; copy stages stay echo-only). With all fixes live,
the trades S1 passed on its retry — the run then stopped only because the API account ran out of
credits. Gate blocked on founder topping up.

**D-022 · H3 word lists are parsed as free text, not CSV (gate lesson #3).**
The coach gate run parked at S3 because H3.must_use contains commentary ("… — and clients are
engineers, never 'leaders'") and the comma-split parser turned the fragments into required
must-words. New parser (banned.ts): quoted phrases are exact entries (token-boundary-aware, so
contractions like "isn't" inside quotes survive); "never 'X'" inside a MUST list is an instruction
about X, not a word to require; unquoted segments count only when ≤4 words and not
instruction-shaped ("go easy on exclamation marks" is guidance, not vocabulary). Dropped commentary
still reaches the model verbatim in the raw H3 input and the human gate reads the raw field — the
parser only decides what QA mechanically enforces. Also from this gate attempt: visible division
joined the leak-arithmetic grammar ("7 ÷ 4 × £850 ≈ £1,488"), with every derived multiplier
required to involve a count visible in the same string (12×12-style implicit products would
blanket the number line — caught by tests before shipping).

**D-023 · Pre-gate adversarial QA audit: 34 false-positives fixed before spending on live runs (2026-07-06).**
A 10-agent workflow probed every stage's QA against honest fixture output and confirmed (via probes)
34 false-positives — 11 FATAL — where the fence rejected legitimate, spec-following output. Root
cause of the fatal cluster: **the no-invention number gates were blind to the numbers the prompt
hands the model.** Unifying fix: a FATAL invented-number check's job is catching figures from
nowhere (fabricated "98%", "500 clients"), NOT policing which field a real price came from — so
every number gate now whitelists `allIntakeNumbers(intake)` (every figure the customer stated
anywhere) ∪ prior-stage numeric leaves ∪ visible arithmetic over those. A real owner price can no
longer fatally park a run; a figure from nowhere still parks. Specific fixes:
- **Shared number grammar** (`inventedNumbers`): multi-term subset-sum addition ("£58+£119+£24=£201"),
  visible division ("£6,500÷5=£1,300"), spelled-out multipliers ("two … × £850"); `night/fortnight`
  added to period units; a physical-measurement carve-out ("45cm", "240v"); `allowYear`/`percentEcho`
  options so S6/S7/S8 route through the one engine instead of hand-rolled loops.
- **`extractNumbers`**: a range's k/m suffix now scales the low bound too ("£10–30k" → 10000 & 30000),
  fixing S1/S9 fatal parks on an honestly-expanded revenue band.
- **Outcome-promise patterns**: refunds that name the amount ("you'll get every penny back — all
  £4,200") and descriptive prose ("a guarantee our customers can point to") no longer fire; genuine
  "we guarantee results" / "guarantee you 10 customers" still do.
- **`phraseRegex`**: single real-word bans get a trailing boundary — "elevate" no longer fires in
  "elevated"/"elevation", "seamless" not in "seamlessly"; multi-word phrases keep suffix leniency.
- **Banned scan**: a negator earlier in the clause suppresses the hit, so on-brand rebuttals ("a
  scared dog isn't naughty or stubborn") pass while the plain claim still flags.
- **`parseWordList`**: subject-verb instruction fragments ("clients are engineers") are no longer
  mis-parsed as required must-words.
- **S2**: verbatim floor lowered to the prompt's 10 chars / 2 words (provenance is already proven by
  the exact-C2-substring test); channel matching is plural-tolerant.
- **S3**: voice guardrail accepts a dash before "not"; number whitelist widened (above).
- **S4**: `d6_conflict` drops tokens from the owner's own vocabulary (A2/D1/D2/D3), so an instructed
  name like "Fuse Board Swap" no longer collides with a D6 that mentions "board".
- **S5**: qaS5 now receives prior outputs (sees S4 prices); forbidden-channel uses subset (not any
  shared token); phase themes and channel priorities are plural/short-name tolerant.
- **S6/S7/S8**: quote-provenance FATAL checks compare case-insensitively (a sentence-cased real quote
  isn't a fabrication); S7 quote haystack includes raw C2; S7 warmup no longer reads "no list" as a
  list; S9 table figures trace to the union of sources; S9 goal accepts spelled numerals; page cap
  reconciled to 575. All 34 encoded as both-directions regression tests. 142 tests passing.

**D-024 · Quote checks tolerate edge punctuation (near-verbatim fix).**
Live trades S1 parked when the model quoted F2 faithfully but added a sentence-final "." the source
lacks ("…never get round to it." vs "…never get round to it") — the byte-exact substring test
rejected an honest quote. `findVerbatimSpan` and the FATAL quote-provenance checks (s6/s7/s8
invented_quote, quote_fabricated) now strip leading/trailing punctuation and quote marks from a
span before matching. Internal wording must still match exactly, so a fabricated testimonial still
parks — only edge punctuation drift is forgiven. This fixes the whole quote-check family (S1
evidence, S3 differentiator, S4 citations, S6–S8 provenance) in one place.

**D-025 · No-invention retry policy: invented NUMBERS are retryable; fabricated PROOF is fatal.**
Live trades S4 parked with no retry when the model used a rhetorical invented figure ("whoever
quoted £180 on a Facebook group") — the check correctly caught an invented number, but FATAL-no-retry
was disproportionate: a one-line critique ("£180 isn't in the intake") reliably makes the model
delete it, and S1's own leak-number check was ALREADY retryable, so the pipeline was internally
inconsistent. Resolution: the numeric no-invention checks (s3/s4/s5/s6/s7/s8/s9 number_invented,
invented_number/numbers/percentage, s9 table tracing) are now RETRYABLE — one critique-retry, then
park — matching S1 and the Pipeline Spec's retry policy. The FATAL-no-retry reservation (Global QA
principle 2) stays for FABRICATED PROOF, where a second attempt is dangerous: fabricated quotes/
testimonials (quote_fabricated, invented_quote), unsupported credential words (proof_word_unsupported)
and outcome-promise guarantees (risk_reversal_promises_outcome). The no-fabrication guarantee is
intact — a persistent invented number still fails QA and parks after its retry; it just gets the one
retry the spec promises. Supersedes the blanket-fatal number stance in D-018. Locked by a
policy-assertion test.

**D-026 · Adaptive thinking OFF for the large copy stages (S6/S7/S8); + a `--resume` CLI.**
Live trades reached S1–S6 PASS, then S7 (12+ emails) returned an EMPTY response: with adaptive
thinking on a large structured deliverable, the model spends the whole token budget reasoning and
hits max_tokens before emitting any JSON — raising the ceiling to 64k made it worse (more room to
think, still no output). The hard reasoning is already done in S1–S5; S6/S7/S8 render decided
strategy into a big document. So those three stages now run with `thinking: false` (StageDef flag →
LlmRequest → client) at 32k, giving the whole budget to output. S1–S5 and S9 keep adaptive thinking
(they reason). Also added `pipeline --resume runs/<id>` (D-nearby): a parked run reloads its passed
stages' outputs as prior and continues from where it stopped — no re-running the backbone to retry a
late stage, and the operational primitive for the strategist's targeted re-runs at S10.
