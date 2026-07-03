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
