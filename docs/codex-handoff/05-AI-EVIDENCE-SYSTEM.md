# 05 — AI EVIDENCE / NO-INVENTION SYSTEM

This is Relaunch72's headline differentiator. It is **real and tested** — but it is important to understand precisely *what* it checks and *where* it does not reach.

## What it is, mechanically

The "no-invention" system is a set of **QA functions that run over each stage's schema-valid JSON output** and return issues; the stage runner parks a stage that has issues (immediately, no retry, if the issue is *fatal*). It is **not** a stored evidence graph or a claim-extraction pipeline — it is deterministic string/number analysis at generation time.

### Source evidence model
- The "evidence base" is the **customer's own intake fields** (and prior stage outputs), assembled on demand into a normalized haystack: `haystack(intake, fieldIds)` (`src/qa/checks.ts:39-43`) and per-stage number sets like `allIntakeNumbers` / `s3Numbers` / `s7Numbers`.
- There is **no separate evidence/source table, no document ingestion, no citation ids.** Provenance is computed by matching generated text against these fields at check time, then discarded.

### Claim extraction
- Not a general NLP claim extractor. The system extracts three kinds of "claim" from generated strings:
  1. **Numbers** — `extractNumbers` (via `inventedNumbers`, `src/qa/checks.ts:135`).
  2. **Quoted passages** — `extractQuotedSpans` → `quoteTracesTo` (`checks.ts:61-66`).
  3. **Proof/outcome words & banned phrases** — `scanBannedPhrases`, proof-word checks, outcome-promise patterns (`src/qa/banned.ts`, `checks.ts` `OUTCOME_PROMISE_PATTERNS`).
- Free-form factual assertions that contain no number, quote, or flagged word are **not** checked for support.

### Claim → source provenance rules
- **A number passes** only if it is a small count (≤31), a period length (days/weeks/hours…), a year, a value literally present in the consumed intake/prior numbers, or derivable by *visible* arithmetic over B2/B3 (revenue/sale inputs) with 1% tolerance (`inventedNumbers`, `src/qa/checks.ts:82-140+`). Anything else = invented.
- **A quote passes** only if, after edge-punctuation stripping, it is a substring (≥12 chars) of a consumed intake field (`quoteTracesTo`, `checks.ts:61-66`; `findVerbatimSpan`, `:69-79`). S2 additionally requires verbatims to be **exact substrings of C2** (the anti-hallucination fact-echo, `checks.ts:5-6`).
- Provenance is **recomputed each run, not stored** — there is no persisted "this claim came from field C2" record.

### QA checks (per stage)
`qaS1`(`:311`), `qaS2`(`:434`), `qaS3`(`:528`), `qaS4`(`:715`), `qaS5`(`:914`), `qaS6`(`:1076`), `qaS7`(`:1267`), `qaS8`(`:1501`), `qaS9`(`:1690`), plus rail checks `qaContentCluster`(`:1863`), `qaSocialPost`(`:1999`), `qaAdCampaign`(`:2092`), and global banned/lexicon (`src/qa/banned.ts`). Each `QAIssue` has a `check` name, `message`, and optional `fatal` flag.

### Hard-failure conditions
- **Fatal issues park the stage IMMEDIATELY with NO retry** — "a model that fabricates proof doesn't get a second chance" (`src/stages/runner.ts:149-156`). Fatal checks (grep `fatal: true`):
  - `s4.risk_reversal_promises_outcome` (`checks.ts:747-749`)
  - `s6.proof_word_unsupported` (`:1138-1140`)
  - `cc.number_invented` (`:1888-1890`), `cc.quote_fabricated` (`:1903-1905`)
  - `social.number_invented` (`:2034`), `social.quote_fabricated` (`:2052`)
  - `ad.number_invented` (`:2115`), `ad.quote_fabricated` (`:2126`)
- **Non-fatal issues** get exactly **one** automatic retry with a critique appended; a second failure parks the stage for the human queue (`src/stages/runner.ts:92-181`). A model **refusal** or **max_tokens** truncation also parks (`:121-127`). Nothing failing is ever silently shipped.

### Human approvals
- The assembled 72h **pack** has a human sign-off gate: approve / send-back writes `signoff.json` and flips bundle status (`src/server/admin/router.ts:90-115`, `src/signoff/signoff.ts`). Delivery reads that decision.
- **Ongoing rail output (manager / portal Run) has no equivalent approval gate** before it is "published" (today it only reaches a mock GHL/CRM timeline). If live publishing is added, an approval gate must be added with it.

### Versioning
- Prompts are versioned and content-hashed; each stage record captures `prompt_version` and `prompt_sha256` plus the `model` used and every attempt's raw output (`src/stages/runner.ts:80-118`; prompts loaded from `prompts/` via `src/stages/prompt.ts`).
- QA logic itself is code, versioned in git; the spec is "Pipeline Spec v1.0" and thresholds are documented in `docs/decisions.md` (D-001, D-002, D-014).

### How client-supplied statements are treated
- Intake fields are the **source of truth** and are trusted verbatim. Double-quoted customer words are **exempt from the banned-phrase scan** (a customer may use a "banned" marketing word about themselves) — `qaS2` exempts double-quoted spans but not generated prose (`checks.ts:183`, tested in `qa.test.ts:183`).
- The system never fact-checks the *truthfulness* of what the client wrote; it only guarantees the AI does not add numbers/quotes the client didn't supply.

### How unsupported claims are blocked
Generated text → schema validate → QA scan → if any issue: fatal ⇒ park now; else retry once then park (`src/stages/runner.ts:129-181`). So an unsupported number/quote either parks the run or is bounced back to the model to remove, and can never reach the deliverable silently.

---

## Two real test examples

**Accepted grounded output** — a fully grounded, interlinked mock content cluster passes with zero issues:
```
test/content-cluster.test.ts:23  test('qaContentCluster passes a grounded, interlinked mock cluster', …)
test/content-cluster.test.ts:26    assert.deepEqual(qaContentCluster(cluster, intake, prior), []);
```
The mock cluster is generated only from intake-derived material, so every number/quote traces back and QA returns `[]`.

**Blocked unsupported claim** — injecting a fabricated statistic triggers a FATAL park:
```
test/content-cluster.test.ts:41  test('cc.number_invented (FATAL) fires on a fabricated statistic', …)
test/content-cluster.test.ts:43    c.pillar.key_points[0] = 'Businesses like this see 73% more enquiries within 45 days of publishing.';
test/content-cluster.test.ts:45    const hit = issues.find(i => i.check === 'cc.number_invented');
test/content-cluster.test.ts:47    assert.equal(hit?.fatal, true);   // invented numbers park immediately
```
(Companion test at `:50-54` does the same for a fabricated customer quote → `cc.quote_fabricated`, fatal.)

---

## Two reach limits the auditor must weigh

### Do generated CRM replies use the same safeguards?
**There are no generated CRM replies today** — no message/conversation generation exists (see `03-CRM-AND-EVENTS.md`). So the safeguards neither apply nor are bypassed *yet*. **Risk:** the QA system is wired into the **pipeline stage runner** (`src/stages/runner.ts`), not into a general "any AI output" path. If SMS/email/WhatsApp reply generation is built, it will **not** automatically inherit these checks — they must be explicitly routed through `qa/checks.ts`-style validation. Flag this as a design requirement.

### Can dashboard metrics be traced to real observations?
**No.** The portal dashboard KPIs are **not** measured performance:
- Keyword "volumes" shown come from the **mock** provider by default (`src/portal/run.ts` uses `MockKeywordProvider`), i.e. deterministic hash-derived numbers, not real search volume.
- Some KPI tiles are **hard-coded display constants**, not counts: `posts = d.artifacts.post ? 30 : 0` and `ads = d.artifacts.ad ? 2 : 0` (`src/portal/views.ts` `dashboardPage`). "30 posts scheduled" appears whenever a single post artifact exists.
- There is **no analytics/observation integration** (no Meta/GA/Ayrshare stats ingestion), so nothing on the dashboard is traceable to a real-world outcome.
The no-invention rule governs **generated deliverable copy**; it does **not** currently govern the **dashboard's own summary numbers**, which mix mock data and literals. This is a notable gap given the "nothing invented ever" positioning — the guarantee holds for content, not for the dashboard's metrics.
