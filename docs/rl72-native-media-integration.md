# Native RL72 affiliate media — canonical Growth HQ integration

**Status (2026-11-15):** A small, real integration milestone submitted for review. Not deployed or sellable; no provider, merchant, publishing or payment call was made.

## Canonical architecture

The foundation is `codex/relaunch72-platform-foundation`. It already includes the multi-brand **Creative Studio** (image generation from approved assets, local rendering, video storyboards, exact-version approval and hand-off), the private asset library, PostgreSQL workspace/session enforcement, a brand kit carrying disclosures, and existing content/social/CRM rails.

The older media prototype, [PR #107](https://github.com/Martoon196/relaunch72/pull/107), targets the legacy portal and writes per-tenant JSON files. Its Vizard/Shotstack providers, scripts and signed click tracking are reusable *design references* but not a production storage, auth or scheduling subsystem. **Do not merge #107 unchanged.**

This branch adds an affiliate-product intake path inside **that existing** Creative Studio form/service. It does not spin up a second `/studio` tenant system:

- Source radio: **An affiliate product** (requires **Product promotion** purpose).
- Merchant/product names supplied by the owner; conservative template copy deliberately contains no invented review, price, return, testing, result or commission.
- Server refuses unconfirmed brand facts, missing #ad in the brand's required rendering disclosure, and missing Amazon Associate earnings wording for the Amazon mode.
- Owner must acknowledge that product details, channel/site eligibility and media rights have been checked. These are **owner attestations**, not externally verified proofs.
- Destination still comes **only** from that brand's confirmed conversion pages. Direct browser-supplied affiliate URL is not accepted.
- Draft is stored and rendered via the **existing** Creative Studio session/PG command boundary, with the same context digest and renderer disclosure. Editing/approval/hand-off follow the same exact-version and no-auto-publish controls; no new migration or provider permission.
- New tests cover false disclosure, attestation, forged destinations and unreviewed content. CI typechecks, checks the Creative Studio regressions and uses disposable PG for real owner-session/tenant boundary proof.

## Deliberate release limitations

An owner attestation is not a licence check. The record stores a generic short brief, not a durable product object or signed eligibility receipt. The UI does not yet provide a catalogue, Amazon special-link validation/issuance, merchant import, tracked outbound redirects, actual order/commission data, import/repurposing of long source videos, Vizard jobs, Shotstack timeline SDK, external renders, or independent standalone checkout. The existing locally-rendered storyboard video is not a replacement for clipping user-owned long videos.

The source mode is a draft-intake convenience; it must **never** be treated as affiliate compliance clearance or publishing authorisation. A subsequent code change must introduce programme- and version-scoped evidence before permitting affiliate links in automatic distribution.

## Next engineering slices (in-place, not a second product)

1. **Durable programme/product/rights records in PG** under the signed-in brand/workspace boundary, with migration, exact owner session guard and true cross-tenant integration tests. Distinguish input provenance, approved destination and merchant special link; version evidence and policy acceptance; connect records to existing `CreativeSet` rather than duplicating the creative library.
2. **Owned/permissioned source ingestion** into the existing private asset store: signed upload, hash/length/MIME verification, source rights and permitted destinations. Do not assume YouTube URL conveys reuse permission.
3. **Queued paid-media reservation** before provider calls: tenant cap, idempotent command/attempt ledger, zero-default kill switch, uncertain-outcome handling and audited manual consent. Only then port Vizard/Shotstack adapters behind the existing worker/approval rails; never do chargeable provider calls in HTTP request handlers.
4. **Editor integration**: approved source asset -> editable timeline -> output asset with digest/version -> render receipt -> exact version approval. License-check Shotstack Studio SDK before embedding or reselling.
5. **Existing social calendar & outbound links** only after explicit owner approval, platform permission and merchant compliance checks. No auto-publish route in this branch.
6. **Standalone SKU** through existing portal billing/provisioning for a different tenant tier; the same engine and database, not a separate file store.
7. **Real analytics**: label click data as clicks only; actual Amazon orders/commission can only come from authorised merchant reporting.

## Acceptance before selling

All CI green on the exact SHA, disposable PG isolation passes, product eligibility and disclosures reviewed for intended geographies and platforms, confirmed direct-owner source rights, provider cap and reconciliation working, editor verified in browser, full render and approval proof, publisher permission checks and recorded real external receipts. A green unit test by itself does **not** demonstrate live AI video, publishing, or affiliate sales.
