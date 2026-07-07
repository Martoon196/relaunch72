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

**D-027 · Quote-provenance checks are retryable too; double quotes reserved for real testimony (S7 prompt v1.0.1).**
Live trades S7 (thinking-off, generated cleanly) parked FATAL on s7.invented_quote: the model wrapped
rhetorical OBJECTIONS it was rebutting in double quotes ("Someone else will do it cheaper", "What if
you find something expensive?") — not fabricated testimonials, but the check can't tell a made-up
customer quote from a rhetorical aside by form. Fix, two parts: (1) s6.quote_fabricated,
s7.invented_quote and s8.invented_quote are now RETRYABLE (a critique — "that quote isn't real
testimony" — fixes the formatting slip; persistent fabrication still parks after the retry, and the
human gate is the final backstop). (2) The S7 prompt (→ v1.0.1) now explicitly reserves double quotes
for real customer words and forbids quoting objections/worries/rhetorical questions/myths. Extends
D-025: the whole no-invention family (numbers + quotes) is retryable; only unsupported credential
words (proof_word_unsupported) and outcome-promise guarantees (risk_reversal_promises_outcome) stay
FATAL, because those words have no legitimate non-fabrication use.

**D-028 · S7 CTA can be a link OR a reply (not every email needs {{link}}).**
Live trades S7 parked on s7.cta_count: 6 of 12 emails used reply-based CTAs ("Reply and tell me
what's going on") with no {{link}} — high-engagement, deliverability-friendly, exactly right for
welcome emails, but the check rigidly demanded one {{link}} per body. The check now accepts one CTA
that is EITHER a {{link}} in the body OR a reply instruction (cta starts with "Reply" / body says
"reply to this email"), never both. S7 prompt (v1.0.1) documents the two CTA modes. Retryable like
the rest of S7's structural checks.

**D-029 · S8 distribution thresholds tuned to realistic output (platform floor 30%, offer cap 8).**
Live trades S8 parked on distribution: Facebook 20 / Google Business Profile 10 (check demanded ≥12
each) and 8 offer posts (cap was 6). Both are realistic — a GBP *listing* naturally carries fewer
posts than a Facebook feed, and 8/30 selling posts (27%) is normal for a business that sells. The
model held these choices across two retries. Relaxed: the two-platform floor is now 9 (≈30%, never
starve one) and the offer cap is 8 (still "mostly value, not a month of selling"). S8 prompt → v1.0.1
with matching guidance and default mix. The ≥4-per-lane and ≤9-per-lane balance stays.

**D-030 · s10.price_conflict recognises S4-derived currency figures (not just headline prices).**
Live coach S10 raised 3× price_conflict on £1,200 in the guarantee copy (S6 sales page, S7 promo
emails). It was NOT a rogue price: the intake states the refund policy verbatim (D4 — "I refund
everything except those two"), S4 designed it into risk_reversal_options with the arithmetic shown
("Six sessions at £1,800 means £300 per session; four remaining is £1,200 returned"), and S6/S7
carry it forward showing the maths. The per-stage S6/S7 number gates (inventedNumbers, which allows
visible arithmetic + prior figures) correctly passed it; only the stricter s10 currency scan, whose
legal set was just recommended_stack headline prices, flagged it. Fix: the legal-price set now also
includes every £-tagged figure S4 stated in its own prose (refunds, per-session rates, payment-plan
instalments) — S4's no-invention gate already validated those, so a currency figure S4 produced is a
grounded price the copy may restate, not an invention. Only £-tagged S4 figures count, so an
incidental "nine years" in S4 prose can never launder a bad price into the copy. A price present in
no S4 figure and no intake number still flags.

**D-031 · qaS8 gains the s3_banned_word check qaS7 already had; voice-ban checks honour negation.**
Live coach S10 also raised 2× s3_banned_word ("transformation", "scale") on S8 posts. Two findings:
(1) qaS7 enforces S3's model-added voice bans per-stage (s7.s3_banned_word) but qaS8 did NOT — the
30-post pack, the highest-volume copy deliverable, only met S3's extra bans at the terminal, non-
retryable S10 lint. Added s8.s3_banned_word (retryable) so S8 gets an in-stage critique-retry to
rewrite, mirroring S7. (2) "transformation" was used in a negated rebuttal ("That's not a
transformation — just the job done properly"), the coach actively distancing from the hustle word
they banned — exactly the on-brand framing scanBannedPhrases already exempts for the global/H3 list
via NEGATOR_BEFORE. The three s3_banned_word sites (s7, new s8, s10) previously used a cruder
phraseRegex.test with no negation handling; all three now route through a single shared matcher
(bannedHits) so voice-list bans get the same negator + suffix treatment as the global list. "scale"
in "engineers at scale" is un-negated and correctly still flags — now caught retryably in S8.

**D-032 · S5 spend recommendations must name G3 figures or speak directionally — no minted amounts.**
Live ecom S5 parked (twice) on s5.number_invented: the plan advised "using £100 to £150 of your
£200–500 budget" to boost a Reel. £200–500 is the real G3 budget (grounded), but £100 and £150 are
figures the customer never stated and the model minted them as a spend sub-range. The gate is right
to block this — hard rule #1, and the no-invention number gate deliberately can't tell a spend
allocation from a fabricated revenue projection, so a blanket "any £ ≤ budget ceiling" allowance
would be unsafe. The gate's arithmetic only accepts figures built from visible integer operands
(counts ≤31 / spelled integers) × B2/B3/intake bases, so "half of £200 = £100" would still fail
("half" is a word, 0.5 isn't a derivable multiplier). The reliable fix is behavioural: S5 prompt
(v1.0.1) now tells the model to name the G3 budget figure itself ("your £200–500 budget") or use
directional language ("most of your budget", "a small test spend, well under your ceiling") and never
mint a bare new pound amount — the owner picks the exact figure, the plan picks the move. Revenue math
from B2/B3 still shows its arithmetic inline as before. Prompt-only; no gate change. Resumed ecom from
S5 with the fixed prompt.

**D-033 · S5 number gate: include prior-stage PROSE figures + accept visible subtraction.**
Ecom S5 (resumed with D-032's prompt fix — the spend behaviour was now correct, "put most of your
monthly budget behind…") parked again, this time on the figure £107 in a coat→kit upsell email:
"the bed and feeder bring the total to £165, so there is £107 left to complete the kit." £107 is
grounded twice over: S4 explicitly computed it ("she pays £107 (£165 − £58)"), and it is visible
subtraction of two real prices (£165 Calm Kit − £58 Settle Coat, both from D1/D3). Two gate gaps:
(1) s5Numbers only pulled prior stages' NUMERIC fields (numericLeaves), not figures a prior stage
stated in its PROSE — so S4's computed £107 was invisible to it. Fixed by also unioning
intakeNumberSet over each prior stage's stringified text, exactly as qaS9 already did (S6–S9 had this;
S5 was missed). (2) inventedNumbers' arithmetic did ×, ÷ and additive subset-sum but not subtraction,
so "£165 − £58 = £107 left" (a real remainder shown in the copy) read as invented. Added a visible-
subtraction path: a figure passes if a LARGER allowed operand shown in the same string, minus the
figure, is a subset-sum of the shown parts — additive-only, can only rescue a genuine remainder, never
a free-floating number (regression-tested both directions). Verified against the real parked S5 output
(now clean) + 157 unit tests. Resumed ecom again.

**D-034 · Ecom "instant calm" s10 flag kept as a strategist-gate item, not auto-scrubbed.**
Ecom completed with one s10.s3_banned_word flag: "instant calm" (an S3-banned overpromise for a
calming-kit brand) in the S6 sales page. In context it is a REBUTTAL — "…not for an owner who already
knows that nothing that promises instant calm is going to keep that promise" — the brand naming and
rejecting the exact overpromise it bans. Honest, on-brand copy. It flagged only because NEGATOR_BEFORE
lists no/not/never/without but not "nothing". Deliberately NOT broadening the negator: "nothing" is
ambiguous — "nothing that promises X keeps it" (rebuttal, suppress) vs "nothing beats X" (endorsement,
must NOT suppress) — and NEGATOR_BEFORE is shared by every banned-word scan, so adding it risks global
false negatives (letting a real overpromise through). For brand-defining words a business defines
itself AGAINST, the strongest copy often names the rejected concept, and a human distinguishes rebuttal
from overpromise better than the matcher can — so the s10 strategist gate surfacing it for founder
approval is the correct behaviour, not a bug. Known follow-up (logged, not rushed): qaS6 lacks the
in-stage s3_banned_word check S7/S8 have — a real consistency gap, but fixing it well depends on the
same negator nuance, so it waits for a considered pass rather than a time-pressured change.

**D-035 · Deep Intake form built self-hosted, generated from the field spec (not Tally/Fillout).**
LS-11 specced "Tally or Fillout." Built self-hosted instead: (1) both are third-party accounts I can't
create without asking (hard rule #3), and the founder said to keep momentum; (2) a self-hosted form has
zero external side-effects, no per-response cost, and full control; (3) rendering it from the canonical
INTAKE_FIELDS spec (orchestrator/src/intake/form.ts) means the customer form and the pipeline's A1–H4
input contract are the SAME source — they cannot drift, which a separate Tally build cannot guarantee.
Client validation mirrors runS0 (required/conditional/min-words/option/placeholder-echo); S0 stays the
server authority. Self-contained single HTML (npm run intake:build → site/intake/index.html), branded,
save-and-resume, `--endpoint` for an optional webhook POST. Verified end-to-end in headless Chromium:
a real intake validates clean and passes runS0. Founder to confirm self-hosted vs porting to Tally; the
Stripe-gated link + webhook receiver + nudge email are Phase-5 automation, tracked separately.

**D-036 · Stripe payments backend — DI'd, env-only secrets, test-mode-derived-from-key.**
Built the real automated payments flow (orchestrator/src/server): POST /api/checkout creates a Stripe
Checkout Session; POST /api/stripe/webhook verifies the signature and records the paid order to
data/orders.jsonl; POST /api/intake runs the S0 gate and, on accept, spawns the pipeline detached so
payment→intake→build is hands-off. Design choices: (1) the SDK is behind a structural StripeLike
interface injected into all logic, so every route/path tests with a fake client and NO key (10 tests)
— the real `stripe` import lives only in index.ts. (2) liveMode is DERIVED from the key prefix
(sk_live_ vs sk_test_), so a test key can never accidentally run as live (hard rule #2). (3) every
secret + Price ID comes from env (.env.example documents them); the server refuses to start without a
key; data/ (orders + submitted intakes = PII) is git-ignored (hard rule #4). Frontend checkout gained
an apiBase seam: set it and checkout POSTs to the backend; leave it empty and it falls back to Payment
Links, then the dev walk-through. No account, key, or Stripe call needed to build/test — the founder
adds a test key + creates the four products to switch it on. Boot + /health + /api/checkout smoke-verified.

**D-037 · Stripe egress is blocked in the CCR sandbox; client made proxy-aware; setup runs where Stripe is reachable.**
Wired the founder's TEST secret key into .env (git-ignored) and ran `npm run stripe:setup` — it fails
because this session's egress proxy denies api.stripe.com (curl CONNECT → 403; the proxy README: a 403
is an org egress-policy denial — report it, do not route around it). The allowlist covers Anthropic +
package registries only. So the payments backend can't touch Stripe from inside the sandbox. Not a code
bug: 189 tests pass and the design is sound. Two fixes for the founder: (a) allow api.stripe.com in this
environment's network policy (Claude Code env settings), then re-run setup here; or (b) run `stripe:setup`
+ `serve` where Stripe is reachable (local machine / the eventual host) — which is the natural home for a
payments server anyway. Made the Stripe client proxy-aware (makeStripe reads HTTPS_PROXY via
https-proxy-agent) so it works the moment the host is allowlisted and doesn't silently bypass a proxy.
Security: the test keys were pasted in chat — advise rotating them before go-live (test keys can't move
real money, so low risk).

**D-038 · Payments API made Render-deployable: CORS added, workspace-aware blueprint, data dir configurable.**
The static funnel is on Pages but can't take a card; the payments server needs a Node host, and the founder
chose Render (same platform as their Property Predator). Four changes made it deployable: (1) **CORS** — the
site (relaunch72.com) calls the API cross-origin, which the browser blocks without it; added an allowlist
(relaunch72.com, www, martoon196.github.io, localhost) echoed per-request via setHeader, an OPTIONS preflight
→ 204, `Vary: Origin`, and a disallowed origin gets no allow-origin header. Extensible via `ALLOWED_ORIGINS`.
(2) **Monorepo build** — it's an npm workspaces repo (lockfile at root), so `render.yaml` builds from the
repo root (`npm install`) and starts the workspace (`npm run serve`, delegator added to root package.json);
`tsx` moved devDeps→deps since the server runs on it and spawns `npx tsx` for the pipeline; lockfile resynced.
(3) **DATA_DIR** — orders/intakes dir is now env-configurable so a Render persistent disk can hold them across
redeploys (free tier is ephemeral + sleeps; documented the Starter+disk upgrade). (4) **Runbook** —
docs/deploy-render.md walks the dashboard/account steps (Blueprint, stripe:setup for price IDs, secrets,
webhook registration, apiBase wiring, test-card loop) + the go-live switch. Verified: typecheck clean, 192
tests (3 new CORS), and a real boot — /health 200 in TEST mode, preflight 204 with headers, evil origin gets
nothing. Blueprint defaults to test-mode + free plan; no money moves and nothing deploys until the founder
connects the repo in Render.

**D-039 · Server starts UNCONFIGURED instead of crashing when no Stripe key is set (fix: first Render deploy failed).**
The founder connected the repo and Render's first Blueprint deploy failed. Cause: the server called
`process.exit(1)` when STRIPE_SECRET_KEY was absent — but on a first Blueprint deploy the sync:false secrets
are still blank, so the process quit before the health check could pass. Crash-on-missing-config is hostile to
the cloud deploy model (the service must bind the port + answer /health to be considered healthy). Fix: start
regardless — /health always 200 and now reports `configured: <bool>`; checkout + webhook return 503 "payments
not configured yet" until a key exists (a never-called Stripe stub stands in so the empty-key SDK constructor
can't throw); boot logs "UNCONFIGURED mode". No safety loss: no payment can be processed without a key, exactly
as before. Reproduced the failure locally (empty key → clean boot, /health 200 configured:false, checkout 503)
and confirmed the fix. 193 tests (1 new), typecheck clean. autoDeploy:true means pushing this triggers Render's
redeploy, which should now go green; the founder then pastes secrets (step 3 of the runbook). Diagnosed without
Render log access — inferred from the deploy model; if a green redeploy still fails it's a different cause
(build/install) and needs the actual logs.

**D-040 · Prices auto-provision from the key on boot — founder sets zero STRIPE_PRICE_* vars.**
The founder picked "auto-create from my key" over running stripe:setup or hand-making four products — matches
their standing preference ("I give the key and you do the wizardry"). Added `ensureCatalogPrices(stripe, provided)`
to catalog.ts: if any STRIPE_PRICE_* is set it's the manual path (returned unchanged, no Stripe calls); otherwise
it calls the existing idempotent `provisionCatalog` and returns the created/reused IDs. index.ts calls it once,
AFTER the server is listening (so a slow/failed Stripe call can't block /health), and mutates cfg.priceIds in
place (the handler sees it by reference). Failure is caught + warned, server stays up. Net effect on Render: the
only required secrets are STRIPE_SECRET_KEY, ANTHROPIC_API_KEY, and (after the URL exists) STRIPE_WEBHOOK_SECRET
— no price IDs. Blueprint + runbook + .env.example updated to make STRIPE_PRICE_* optional. Verified: 195 tests
(2 new — auto-provisions when empty; no Stripe calls when IDs supplied), typecheck clean, and a real boot with
the test key — TEST mode, provision attempted, failed gracefully on the sandbox's Stripe egress block (403 →
"Invalid JSON received from the Stripe API", the D-037 wall), /health stayed 200. On Render (Stripe reachable)
the same path creates the four prices. Live provisioning can only be verified where egress allows Stripe.

**D-041 · Postmark transactional send wired into delivery — opt-in via --send, dry-run by default.**
Founder chose Postmark for transactional email (Brevo for marketing). The delivery module was pure builders
(buildDeliveryEmail/buildEml) with no send. Added src/email/postmark.ts: PostmarkLike interface + deliveryMessage
(pure mapper, validates the recipient and refuses a malformed address) + makePostmark (real client over node:https,
proxy-aware like makeStripe). Wired into `deliver` behind a new `--send` flag: default stays a dry-run (writes
email.txt/.eml, sends nothing); --send requires POSTMARK_SERVER_TOKEN + --to and attaches the branded PDFs if they
fit an 8MB budget (Postmark caps ~10MB). --send is the founder's explicit "email this real person" intent — hard
rule #3 (ask before emailing a real address) is respected: nothing autonomous, and I ran no real send from here.
Sender/reply-to via EMAIL_FROM/EMAIL_REPLY_TO (default hello@relaunch72.com; needs a verified Postmark sender
domain before real sends work). Verified: 199 tests (4 new — field mapping, invalid-recipient refusal, fake-client
contract), typecheck clean. Real Postmark send can only be exercised where egress allows api.postmarkapp.com + a
token exists. Brevo marketing sync is the next piece.

**D-042 · Brevo marketing sync wired — scorecard leads + paid customers into list-triggered automations.**
Second half of #30. The nurture/onboarding *sequences* live as automations in Brevo's UI; the code's job is to
push each contact into the right list so those automations fire. Added src/email/brevo.ts: BrevoLike + contactBody
(pure, validates email, updateEnabled:true so it upserts rather than erroring on an existing contact) + makeBrevo
(proxy-aware node:https). Two trigger points, both optional (AppDeps.marketing — absent = marketing off, routes
still 200 so nothing breaks): (1) POST /api/subscribe → onLead → leads list; the scorecard's existing SUBSCRIBE_URL
seam now points at it (relaunch72.com origin already on the CORS allowlist). (2) the Stripe webhook → onCustomer →
customers list, fire-and-forget after the order is recorded so a Brevo hiccup never fails the webhook (Stripe would
retry otherwise). index.ts builds the hooks from BREVO_API_KEY + BREVO_LIST_LEADS/CUSTOMERS. Verified: 206 tests
(7 new — contactBody mapping/validation, subscribe route synced/unsynced/400, webhook onCustomer), typecheck clean,
and a real boot + /api/subscribe over HTTP (200 synced:false with marketing off, 400 on a bad email). Live Brevo
calls need a key + egress to api.brevo.com. Remaining for #30: convert the nurture/onboarding copy £→$ and a setup
runbook.

**D-043 · Funnel email copy converted £→$; email setup runbook written; #30 complete.**
Closed out #30. (1) Converted all funnel source copy (01/02/04) £→$ 1:1 — 112 replacements — so the email
sequences are load-ready and consistent with the live site + Stripe catalog ($97/$997/$147/$2,497, credit → $900).
The agency anchor went £3–5k → $3–5k for full currency consistency; NOTE the live autopsy/upgrade *pages* still
show a £3–5k anchor (deliberately kept earlier) — flagged to the founder to flip if they want site+email to match,
not changed unilaterally (live outward-facing). (2) Wrote docs/email-setup.md: the account-side runbook mirroring
deploy-render.md — Postmark server + domain verification + token + the `deliver --send` flow; Brevo key + two lists
+ building the nurture/onboarding automations from the pack; which trigger fires which sync; a go-live checklist.
Net #30 state: all email CODE done + tested (Postmark transactional send, Brevo lead/customer sync, /api/subscribe,
scorecard wired) — 206 tests; the remaining work is founder ESP account setup (keys, domain verify, build the two
Brevo automations), documented in the runbook. No real email sent from here (no tokens + egress-blocked + hard
rule #3).
