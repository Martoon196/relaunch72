# Apollo private prospect discovery

Source scaffold only. `APOLLO_ENABLED` defaults to off; the database account switch and each explicitly enrolled brand also default off. Nothing here sends, queues, creates a campaign, uploads an RL72 contact list, buys credits or invokes Apollo's sequencer. Data is kept in private discovery tables rather than inserted into the campaign/contact pipeline.

Only Martin's Prop Invest UK and Key Properties UK may be enrolled. Migration 0143 creates no enrolments. It follows the unchanged MHP payment migration 0142. An operator must verify their real workspace IDs, owner ID and founder-owned organization enrolment before inserting `apollo_brand_policy` rows with keys `prop-invest-uk` / `key-properties-uk`. Customer workspaces cannot enable themselves; names and browser-supplied IDs are not authority. Every database command requires a genuine, current managing-owner session matching the enrolled owner. No grants to web/worker roles and no direct content-command table access.

## Setup

1. Confirm the actual account/API entitlement. As of 6 November 2026, support enabled the three scoped endpoints on Martin's Basic trial after the company-domain update; a Private scoped key is saved securely. That is account-specific trial evidence, not a promise that every Free/Basic trial includes access. Do not buy a subscription or credits, import contacts, connect a mailbox or enable sequences for this coverage experiment.
2. Save `APOLLO_API_KEY` and `COMPANIES_HOUSE_API_KEY` using the existing server secrets mechanism. Never paste keys in chat, Git, CSV or command arguments. Confirm enabled endpoints and the dashboard's actual free-credit allowance, remaining balance and reset date. The older 900/year assumption is not treated as verified.
3. Rehearse migration 0143 on disposable PostgreSQL and review before any separate production release. The old Apollo packet's source-only 0142 was renumbered; the payment 0142 bytes are preserved. Do not apply either payment or Apollo migrations opportunistically during coverage setup. This 0143 bundle takes strict readiness; it cannot be deployed onto a 0141/0142 database without a coordinated compatibility/cutover packet for every strict consumer.
4. An operator records evidence in `app_private.apollo_account_policy`: a monthly global ceiling (default 50), the confirmed currently available **free** credits, `confirmed_at`, `resets_at`, and explicit enablement. Brand ceilings default 50; the global ceiling is shared, so two brands do not each get an additional 50. Leave headroom and account for other Apollo account users/usage. This isolated experiment must not share a free allowance with untracked spend. Never configure a larger available balance than the actual free remainder. Reconfirmation requires accounting for outstanding unknown charges; it is not a way to reset usage.
5. Enable only the verified private brand policy rows and set `APOLLO_ENABLED=true`. Missing configuration holds; it never falls back to another key, account or paid plan. The owner Overview displays used/reserved brand/global credits and remaining allowance when enabled. Pausing either policy stops new calls; started calls can still settle their charges.

## Corporate-only, pull-only

The CSV is an owner-approved list of **companies**, not contact uploads. For each row, Companies House is queried first by number; a name+postcode search is allowed only when it yields exactly one match. Current status, type, number and name must match an active Ltd/PLC/LLP. Domain association comes from the owner-reviewed company seed; Companies House does not prove website ownership. Ambiguity, stale verification, consumers, sole traders, dissolved companies and private landlord/investor records hold before any Apollo request. Corporate landlords must be incorporated companies, not individuals. No existing RL72 name, email, telephone or contact list is sent to Apollo.

People search is bounded to a single company domain and one page (100 previews), with title/seniority/location/industry filters. Apollo documents this domain filter as including current or previous employers: preview counts reflect that limitation. A returned person must additionally have a matching current organization domain before their vendor ID is stored/enrichable. Missing organization/email evidence is **unknown**, not a confirmed absence. Counts without people are not proof an organization is absent. Organization search is a separate paid endpoint, not a free coverage shortcut.

Enrichment uses only a previously pulled vendor ID bound to a fresh verified company. Phones, personal email reveals and waterfall are explicitly disabled. The guard checks normalized email, company domain and company number against held/suppressed discovery and CRM records before reserving paid credit. Domain/company matches conservatively hold the whole company when contact identity is incomplete. Existing suppression is never overwritten. Discovery records carry source, vendor ID, retrieval time, email confidence/status, company verification, licence and credit provenance. This does not grant permission to contact anyone or export vendor data to customers.

## Credit accounting and failures

Every call is reserved atomically under one database-wide account lock: people preview 0, organization search 1/page, email-only person match up to 1 under the configured options. Global UTC calendar-month, brand UTC month, account free window and the coverage-run cap all apply. Reservations persist across restarts; unresolved charges remain counted, including across a month/reset boundary. No paid call can start without a current confirmed free allowance. No automatic credit purchase exists.

Explicit response `credits_consumed` is recorded when provided. Missing paid-endpoint accounting is **unknown**, retains the conservative reservation and trips the global stop switch; it is never reported as zero or silently refunded. A charge above the reserved bound trips the same switch. The usage-stats endpoint is not assumed to be a credit balance. Free-account testing must establish the actual account's accounting/permissions before paid lookups are useful. This conservative scaffold can stop after its first paid response if charge evidence is absent; do not remove that hold just to finish a coverage report.

Zero-credit people searches retry bounded 429/5xx with backoff. Paid timeouts/errors are not retried automatically because they might already have consumed credits. CH handles 429 and the coverage runner is sequential and capped at 100 firms (at most 200 normal CH requests), below CH's documented 600/5-minute allowance for one isolated run. Never run many concurrent coverage processes. Logs contain attempt ID, operation, status, retries and charge accounting, never keys, emails or raw vendor payloads. Plan/permission errors (401/402/403/422) stop the run and are reported without a workaround.

## Coverage

Copy `coverage-template.csv`; supply up to 100 genuine reviewed UK firms with `name,domain,company_number,postcode,segment` (agent/developer/landlord/broker). Do not use the synthetic test company as a real prospect. The repository has no supplied sample list of 100 firms.

Run from the repo root using the existing `r72_content_command` connection and a genuine short-lived owner session, supplied through protected environment variables `DATABASE_CONTENT_COMMAND_URL`, `APOLLO_OWNER_USER_ID`, `APOLLO_OWNER_SESSION_TOKEN`, `APOLLO_OWNER_SELECTED_WORKSPACE`. Do not extract browser cookies or print session tokens; an operator must arrange the approved session through the existing authentication mechanism.

```
node --import tsx scripts/apollo_coverage_test.ts --input firms.csv --brand VERIFIED_WORKSPACE_UUID --target-plan target.json --output private-report.json --max-credits 0
```

The CLI accepts only cap 0. The underlying guarded library retains its separate absolute 25-credit ceiling; the coverage command never invokes enrichment or paid organization search. It outputs per-company observations/holds, per-segment totals and actual/reserved/unknown credit totals. Output may contain business/company information; keep it private. Any held row exits 2. Coverage stops immediately on plan/permission errors or stale targeting. Enrichment and organization lookup are separately guarded library operations, not automatic coverage fallbacks.

### Brand-context targeting

Prepare and review one target brief per brand from its confirmed brand brain/profile, with this shape (use the real current IDs/versions/hashes/audience, never placeholders in a live run):

```json
{"schemaVersion":1,"brandId":"CURRENT_BRAND_UUID","profileVersion":1,"factsSha":"CURRENT_64_CHARACTER_FACTS_HASH","audience":"EXACT_CONFIRMED_PROFILE_AUDIENCE","objective":"The approved corporate campaign objective","filters":{"titles":["Director"],"locations":["United Kingdom"]}}
```

This file is operator-supplied targeting data, not proof an AI generated it or permission to send. The genuine owner session loads the current profile and knowledge through the existing RLS-scoped store before any vendor call and again before every company. Brand/profile/facts/audience or active knowledge mismatch holds; unresolved conflicts or unreadable/pending knowledge hold. Filters require bounded titles or seniorities plus locations, with optional industry IDs. They cannot inject another domain, credentials, budget or tool switches. Per-company CH verification and the hard domain scope still apply. The report records the validated target/knowledge hashes and filters for reproducibility. The CLI does not create a new audience, profile, campaign or target approval.

### Future email pilot, still disabled

Owner direction is 10 total campaign emails per brand per day, adjustable, including follow-ups, with a 50,000-model-token writing ceiling per brand per month. Those are future rollout requirements, not controls implemented or enabled by this discovery packet. Reuse the email wizard and existing `investor-mail` send/read contracts, connect the correct brand mailbox, and prove Growth HQ reply ingestion/cancel-on-reply, suppression and durable quota enforcement before any separate outbound activation. Apollo does not send or enroll prospects in sequences. A mailbox connection remains subject to its provider's permitted use. No credit cap is raised to fill a daily email target.

Fixture checks: `node --import tsx --test orchestrator/test/apollo-discovery.test.ts`. Actual-role PostgreSQL check: use the repository's explicit disposable integration workflow with `orchestrator/test/db/apollo-discovery.integration.test.ts`. No live API calls in CI.

## Basic later

After independently reviewing the new plan's licence and actual account limits, replace the secret/plan evidence and verified free/allowed budget configuration through the existing secrets/operator controls; no endpoint rewrite is needed. Raising a local budget never buys credits or broadens this integration to customers. Unknown accounting and corporate-only/private-owned-brand restrictions still apply. A paid allowance needs an explicit subsequent scope decision; this free experiment remains bounded to confirmed free credits.

Primary references, checked 6 November 2026: [People search](https://docs.apollo.io/reference/people-api-search), [Organization search](https://docs.apollo.io/reference/organization-search), [Person enrichment](https://docs.apollo.io/reference/people-enrichment), [API pricing](https://docs.apollo.io/docs/api-pricing), [CH guidelines](https://developer.company-information.service.gov.uk/developer-guidelines/).
