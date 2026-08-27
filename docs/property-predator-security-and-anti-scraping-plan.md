# Property Predator Security and Anti-Scraping Strike Plan

**Status:** required launch gate

**Applies to:** Property Predator, Growth HQ, affiliate operations, CRM, content,
inbox, outbound rails, provider adapters and future white-label modules

**Effects policy:** all customer imports and provider effects remain off until the
relevant gates in this document pass

## The honest position

Jack is right: an internet-facing CRM can be scraped or exfiltrated if object
authorization, tenant isolation, session handling, exports, automation limits or
monitoring are weak. Public pages can never be made literally impossible to copy.
The engineering goal is to make unauthorized extraction low-yield, expensive,
detectable, attributable and containable while ensuring that authenticated users
can never cross a workspace boundary.

`robots.txt`, hidden OpenAPI pages and unpredictable URLs are not security controls.
The system must enforce authorization and limits at every data and effect boundary.

## Proven foundations already present

Growth HQ already has useful security foundations that must be preserved:

- database-backed, revocable portal sessions;
- forced PostgreSQL row-level security and workspace-scoped relationships;
- isolated command roles rather than one all-powerful application login;
- session-bound CSRF on portal mutations;
- strict portal security headers and an exact CORS allowlist;
- bounded request bodies;
- signed, replay-aware webhook boundaries;
- approval, idempotency, volume, spend and emergency-stop gates around provider work;
- text-only model calls with no direct model ownership of credentials or tools;
- provider effects disabled by default.

These controls reduce risk; they do not replace the work below.

## Immediate findings and branch repairs

| Priority | Finding | Current branch position | Remaining launch work |
|---|---|---|---|
| P0 | Legacy Stripe webhook accepted unsigned JSON when its endpoint secret was absent | Fail-open removed; secret and valid Stripe signature are mandatory; 128 KiB streamed cap and generic verification error added in `c8381d6` | Add durable event receipts/replay quarantine and verify local checkout intent, mode, account, price, product, currency, amount and customer before applying money or entitlements |
| P0 | Legacy compliance deletion could remove another tenant's child evidence | Scoped parent write now wins before child deletion in `c8381d6` + `5340dd3`; negative tests added | Complete independent review; add PostgreSQL two-tenant concurrency coverage and migrate to a scoped foreign key with cascade when the legacy schema is retired |
| P1 | Legacy refresh rotation is multi-winner and stores replacement bearer tokens | Open | One atomic row-lock/CAS rotation; token family and reuse revocation; hashes only; no raw replacement tokens; concurrent replay tests |
| P1 | Deleted-user access tokens can remain authoritative | Open | Require a current active account/session on sensitive requests; add suspend/delete/revoke-all tests |
| P1 | Bulk reads and exports are insufficiently bounded | Open | Keyset pagination, page/total caps, time/cost budgets, role-minimized DTOs, export reauthentication and audit receipts |

No item in this table authorizes a production deployment.

## Security strikes

### 1. Tenant and object isolation

- Maintain forced RLS for every Growth HQ workspace table.
- Introduce equivalent database or repository-enforced tenant context for every
  legacy Property Predator customer table.
- Build a generated two-user negative matrix covering create, read, update, delete,
  list, search, export, webhook and background-worker paths.
- Treat every caller-supplied object ID as hostile and return generic not-found
  responses for inaccessible objects.
- Prevent cross-workspace foreign keys, bulk operations and webhook correlations.

**Pass condition:** automated tests cannot read or mutate one byte across tenants,
including through stale sessions, exports, nested child records or guessed IDs.

### 2. Anti-enumeration, scraping and resource controls

- Put CDN/WAF controls in front of both services.
- Add distributed per-IP, per-account, per-device, per-workspace and per-route
  token buckets.
- Add concurrent-work, daily record, daily provider-call and monetary-cost caps.
- Return `429` with `Retry-After`; escalate repeated abuse to a bot challenge.
- Detect tiled geographic scans, sequential IDs, high-cardinality queries, rapid
  page walking, repeated 401/403/404 responses and low-and-slow extraction.
- Hard-cap all lists with keyset pagination and bounded filters.
- Keep public responses field-minimized; never expose internal/provider metadata
  merely because the UI currently ignores it.

**Pass condition:** a simulated scraper is rate-limited, alerted and unable to turn
pagination, search, map tiles, exports or parallel sessions into an unbounded dump.

### 3. Sessions, devices and step-up authentication

- Make refresh rotation single-winner and atomic.
- Store only refresh hashes; add token family, successor hash, reuse detection and
  family revocation.
- Provide named device/session inventory, revoke-one and revoke-all.
- Rotate sessions after login, privilege change and password reset.
- Require step-up authentication for exports, billing, provider activation and
  high-risk admin actions.
- Add MFA or passkeys for founders/admins before customer data goes live.

**Pass condition:** concurrent legitimate/stolen refresh attempts cannot create two
live successors; suspended/deleted users and revoked devices fail immediately.

### 4. Webhook, provider and effect boundaries

- Require exact signatures, timestamps, endpoint/account identity and replay
  receipts for Stripe, Mailgun, WhatsApp, social and webinar providers.
- Reconcile signed provider facts to an existing local intent; never let metadata
  alone grant money, credits, permissions or delivery state.
- Bound bodies, decompression, redirects, response size, retries and timeouts.
- Retain approval, consent, suppression, idempotency, recipient, spend, volume and
  kill-switch gates immediately before every external effect.

**Pass condition:** forged, replayed, cross-account, late, oversized, mismatched and
ambiguous provider events all fail closed without granting or sending anything.

### 5. Admin and service identities

- Replace broad shared admin tokens with named administrator identities, MFA,
  least-privilege scopes and per-action attribution.
- Give cron, ingestion, export and provider workers separate credentials.
- Hash stored credentials, compare secrets in constant time and rehearse rotation.
- Do not let one credential read all users, alter tiers, delete data and run jobs.

**Pass condition:** each sensitive action has one named actor, one narrow capability,
one immutable audit receipt and an alertable denial path.

### 6. AI data and prompt-injection controls

- Label customer/retrieved text as untrusted data, never as instructions.
- Bound prompt bytes, depth, keys and retained model output.
- Minimize/redact personal data before model calls and document provider data-use
  settings per tenant.
- Add adversarial tests for prompt injection, secret requests, cross-tenant data,
  system-prompt extraction and unsafe URLs/content.
- Preserve the rule that a model never directly receives provider credentials or
  owns an external effect; deterministic code must authorize every action.

**Pass condition:** malicious content can produce a rejected draft, never a secret,
tenant crossover, send, post, scrape, payment or provider call.

### 7. Security telemetry and alerts

- Generate a request/correlation ID at the edge and carry it through database,
  webhook, AI and provider evidence.
- Log allowlisted metadata only: actor, workspace, hashed session/device, route,
  action, result, rows/bytes/cost and limit decision.
- Never log secrets, setup links, raw tokens, raw intake/model content or unnecessary
  personal data.
- Alert on auth storms, ID scans, cross-tenant denials, 429 spikes, export surges,
  invalid webhook signatures, admin actions and provider-cost anomalies.
- Prove alert delivery with a safe canary.

**Pass condition:** the team can detect, scope and contain a simulated scrape or
account takeover from centralized evidence without exposing more private data.

### 8. Dependencies, secrets and build integrity

Current dependency baseline:

- Growth HQ has a committed npm lockfile. Direct runtime dependencies currently
  include PostgreSQL, AJV, Stripe, Anthropic, dotenv, HTTPS proxy support and the
  TypeScript runtime; compiler/test tooling is separated as development-only.
- Legacy Property Predator has 17 direct Python requirements, all exactly pinned,
  including FastAPI, Pydantic, HTTPX, Stripe, Anthropic, PostgreSQL, Google auth,
  JWT/cryptography and PDF/geospatial libraries.
- A point-in-time local `npm audit --omit=dev` on 27 August 2026 reported zero known
  production vulnerabilities across 69 resolved packages. This is not a guarantee
  and is not yet continuous CI evidence.

Required controls:

- lockfile/pin-only installs;
- checked-in software bill of materials for each release;
- vulnerability, malicious-package, licence, secret, SAST and infrastructure scans;
- dependency-review approval for additions and major upgrades;
- pinned CI actions and reproducible release artifacts;
- removal of unused packages and an emergency compromised-package playbook.

**Pass condition:** CI fails on a new critical vulnerability, secret, unregistered
dependency or unreviewed lockfile change, and a release can be traced to its source.

### 9. Backup, recovery and incident response

- Encrypt backups and prove retention/PITR settings.
- Run a dated restore into an isolated environment and verify application integrity.
- Maintain incident contacts, severity levels, evidence preservation, kill switches,
  credential rotation and customer/regulator notification decision trees.
- Run a scrape/account-takeover/provider-compromise tabletop exercise.

**Pass condition:** restore, secret rotation, global provider pause and alert delivery
have each been demonstrated rather than merely documented.

## External gates before launch

Before importing real customer data or enabling live money/provider effects:

1. all P0 and P1 items above are closed or explicitly rejected from launch;
2. the route/data/threat inventory is complete and signed off;
3. staging DAST and an independent penetration test cover tenant breakout, BOLA,
   enumeration, low-and-slow scraping, auth races, admin privilege, webhook replay,
   SSRF/egress, AI leakage and export abuse;
4. no unresolved High finding remains; every accepted Medium has an owner, expiry
   and written risk acceptance;
5. backup restore, incident tabletop, secret rotation and alert canary have passed;
6. provider effects still receive a separate founder activation approval.

## Evidence register

Each completed strike must record:

- exact commit and reviewed diff;
- automated and adversarial test names/results;
- disposable/staging environment identity;
- reviewer and review outcome;
- residual risk and named owner;
- production activation status (default: **OFF**).

## Standards used

- [OWASP Automated Threat OAT-011: Scraping](https://owasp.org/www-project-automated-threats-to-web-applications/assets/oats/EN/OAT-011_Scraping)
- [OWASP API Security Top 10 (2023)](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)
- [OWASP Top 10 for LLM and Generative AI](https://genai.owasp.org/initiatives/top-10-for-llm-and-genai/)
- [UK NCSC: API logging and monitoring](https://www.ncsc.gov.uk/collection/securing-http-based-apis/6-logging-and-monitoring)

This plan is engineering and operational guidance, not legal advice. Data-protection,
affiliate, PECR and contractual wording remains subject to solicitor review.
