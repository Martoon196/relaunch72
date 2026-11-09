# Public-social outbound foundation

Status: **dark and unwired**. This directory contains no live HTTP client,
environment access, provider registry composition or worker. `contract_test`
accepts only module-branded, response-scripted HTTP and media-evidence objects.
Neither object contains an executable callback, so contract mode cannot invoke
a structural resolver or network dependency supplied by application code.

## Contract proved in this strike

Only a deliberately small X/Twitter v1 shape is represented:

- one Ayrshare User Profile, atomically bound to a workspace and connection;
- a completed, hashed profile-specific OAuth-link record;
- a trusted evidence-observation timestamp; OAuth link evidence more than five
  minutes in the future relative to that observation is rejected;
- Ayrshare API Key and Profile Key plus the two X OAuth 1.0a BYO headers that
  Ayrshare requires on every X request after 31 March 2026;
- printable ASCII text up to 280 characters, with URL schemes, `www`, bare
  domains, protocol-relative paths and IPv4-like link tokens fail-closed;
- zero media or one company-owned JPEG/PNG with exact version, content hash,
  blob key, blob hash, MIME type and validity evidence;
- an exact approval decision, content version, body/content/plan hashes,
  stable operation tag, plan-bound provider notes and source-freshness proof;
- a future schedule whose proof and signed media URL remain valid through a
  15-minute provider-fetch fence;
- exact POST acceptance, exact `GET /api/post/:id` reconciliation and bounded
  `GET /api/history?limit=25&platforms=twitter` unknown-outcome recovery.

Official contract references:

- <https://www.ayrshare.com/docs/apis/overview>
- <https://www.ayrshare.com/docs/apis/post/post>
- <https://www.ayrshare.com/docs/apis/post/get-post>
- <https://www.ayrshare.com/docs/apis/history/get-history>
- <https://www.ayrshare.com/docs/dashboard/connect-social-accounts/x-twitter-byo-keys>

## Intentionally blocked

- Unicode/emoji/link weighting, threads, replies, polls, videos and multiple
  images need separate X-specific validators.
- Facebook, Instagram, LinkedIn, TikTok, YouTube, Google Business Profile,
  Threads and Pinterest need their own option, response and reconciliation
  contracts. They are not accepted through a generic network map.
- A live transport must separately implement the exported origin-pinning,
  redirect-error, bounded-stream, abort-timeout and secret-manager contract.
- Before any live composition, persistence must supply a workspace-qualified
  durable single-caller `calling` lease. Ayrshare warns that simultaneous calls
  can both publish despite sharing an idempotency key.
- The activation repository must source `xOAuthEvidenceObservedAt` from trusted
  database/server time, not browser input, before creating the credential bundle.

Until those pieces are separately reviewed and activated, this module proves
payload and failure semantics only; it cannot post anything.
