# 07 — TEST MAP

## Command & current result

```bash
cd orchestrator && npm test        # node --import tsx --test test/*.test.ts
```
- **Total: 316 tests — 316 pass, 0 fail, 0 skipped** (measured; full log `test-output.txt`). Duration ~4.5s.
- `npm run typecheck` (`tsc --noEmit`): clean.
- **Caveat (see `00-START-HERE.md` #1):** on a fresh clone `npm test` fails with `Cannot find package 'tsx'` until `npm ci` is run — deps were absent in the handoff container. After `npm ci`, 316/316.
- The briefing's "316 tests, all green" is **verified accurate** as a raw count — but read the blind spots below before treating it as coverage of the platform's risky behaviours.

## Files & counts (32 files)
`test( )` occurrences per file (runner counts 316 vs 314 here because two files generate tests in loops):

```
34 qa-s3-s5      28 qa-s6-s9      27 qa           24 audit-regressions   22 server
17 subscriptions 15 s0            15 portal       10 s10                 10 content-cluster
 9 social         8 text           8 signoff       8 admin                7 ads
 6 portal-billing 6 manager        6 json          6 deliver              5 runner
 5 intake-form    5 catalog        4 rail-runner   4 portal-accounts      4 email
 4 crm            4 brevo          3 portal-run    3 portal-email         3 keyword
 3 ghl            1 fixtures
```

## Categories (what each cluster proves)
- **Evidence / no-invention QA** (largest block): `qa.test.ts`, `qa-s3-s5.test.ts`, `qa-s6-s9.test.ts`, `audit-regressions.test.ts`, plus rail-level checks in `content-cluster.test.ts`, `social.test.ts`, `ads.test.ts`. Cover invented-number, fabricated-quote, banned-phrase, outcome-promise, traceability.
- **Pipeline mechanics:** `runner.ts` (retry/park), `s0.ts` (intake gate), `s10.ts` (assembly), `json.ts` (LLM JSON extraction), `text.ts` (number/quote extraction).
- **Payments/server:** `server.test.ts` (routes, CORS, webhook, intake hook), `subscriptions.test.ts` (event mapping + stores + checkout), `catalog.test.ts` (price provisioning idempotency).
- **Portal/CRM:** `portal.test.ts` (auth gate, dashboard, run, billing routes), `portal-billing.ts`, `portal-accounts.ts`, `portal-run.ts`, `portal-email.ts`, `crm.ts`.
- **Manager/rails:** `manager.ts` (cadence/due), `rail-runner.ts`, `social.ts`, `keyword.ts`, `ads.ts`, `ghl.ts`.
- **Delivery/ops:** `deliver.ts`, `signoff.ts`, `admin.ts`, `brevo.ts`, `email.ts`, `intake-form.ts`, `fixtures.ts`.

## Which tests cross a real HTTP boundary
**None.** No test opens a socket — grep for `createServer` / `.listen(` / `fetch(` / `http.request` in `test/` returns nothing. `server.test.ts` and `portal.test.ts` drive the handlers through **fake `req`/`res` doubles** (`server.test.ts:82-95` Readable + object; `portal.test.ts:31-51` EventEmitter doubles). The "live HTTP smoke tests" referenced in `docs/decisions.md` were **manual `curl` runs**, not part of the automated suite. → An auditor cannot rely on the suite to catch real socket/streaming/header/proxy issues.

## Which tests use mocks
**Effectively all.** Stripe is a hand-rolled fake (`server.test.ts:27-32`); the LLM is `MockClient`; the CRM/accounts/order/subscription stores use their in-memory variants; every provider live adapter (Anthropic/DataForSEO/Ayrshare/Meta/GHL/Postmark/Brevo) is **never invoked** by a test. No test touches a real external API.

## Tenant-isolation tests
**Essentially none.** The only adjacent test is `portal.test.ts:98` ("a forged/expired cookie is treated as logged out"). There is **no test that tenant A, authenticated, cannot read or mutate tenant B's contacts/activities/billing.** Given isolation is application-only and some store methods take a global id with no tenant check (`src/crm/store.ts:65,90`), this is a **priority missing test.**

## Webhook replay / idempotency tests
**None.** `server.test.ts` tests good-vs-bad signature (`:151-158`), order recording (`:151`), and subscription recording (`:262-270`) — each a **single** delivery. There is no test for a duplicate/replayed event (Stripe delivers at-least-once), and the handler has no idempotency (see `06-BILLING-AND-PROVISIONING.md`). **Priority missing test.**

## Double-send / double-spend protection tests
**None, and largely not applicable yet.** Ad spend can't occur by construction (paused drafts only; `src/ads/meta.ts:11`) so there is no spend path to protect — but there is also no test asserting "never un-pause/never spend". No SMS/email double-send test (no messaging rail). No concurrency/double-click test on `POST /portal/run` or `/api/intake` (both can be invoked twice with no guard). **Priority missing test** once messaging/live ads land.

## Billing webhook tests
Present but shallow: `server.test.ts:151` (order on good sig, 400 on bad), `:262` (subscription lifecycle recorded when a store is wired), `:276` (subscriptions optional). Plus `subscriptions.test.ts` (17 tests) covering `subscriptionFromEvent` mapping across both Stripe API shapes, store merge/email-index, `isActive`, and subscription-checkout params. **Not covered:** replay/idempotency, failed-payment→access consequences, cancellation consequences, plan-change/proration.

## Evidence / no-invention tests
**Strongest area.** Representative:
- Accepted grounded output: `content-cluster.test.ts:23` → `assert.deepEqual(qaContentCluster(...), [])`.
- Blocked fabricated number (FATAL): `content-cluster.test.ts:41-47`.
- Blocked fabricated quote (FATAL): `content-cluster.test.ts:50-54`.
- Cross-stage number/quote traceability: throughout `qa-s3-s5`, `qa-s6-s9`, `audit-regressions`.
- Runner behaviour: parks on fatal with no retry / retries once then parks — covered in `runner.ts`.

## Missing critical tests (prioritised)
1. **Cross-tenant isolation** — A-cannot-see/mutate-B for contacts, activities, dashboard, billing. (Highest risk; no coverage.)
2. **Webhook idempotency / replay** — duplicate `checkout.session.completed` and `customer.subscription.*` must not double-record / double-provision.
3. **Real HTTP integration** — at least one test that boots `createServer` and exercises login→dashboard→run→webhook over a socket (the manual curl smoke, automated).
4. **Billing lifecycle consequences** — past_due/canceled under `BILLING_ENFORCED` blocks Run; active allows it (route logic is tested via mocks in `portal.test.ts`, but not the end-to-end enforcement wiring).
5. **Provisioning ↔ billing email join** — mismatched intake vs checkout email (orphaned billing) behaviour.
6. **Concurrency** — double `POST /portal/run` / double intake; JSON store read-modify-write races.
7. **Live-adapter contract tests** — even against recorded fixtures, so "one key flips it live" gets real coverage (currently zero).
8. **Dashboard-metric honesty** — assert KPIs reflect real counts, not hard-coded literals (`posts=30`, `ads=2`; `src/portal/views.ts`).
