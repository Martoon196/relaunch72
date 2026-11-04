# RL72 Boosters integration

This is a review branch. `SEO_BLOG_METHOD_PACKS` defaults off. Nothing in this change assigns a production brand, enables a provider, creates a paid entitlement or authorises publication.

## What is connected

The portal and worker compose a principal-bound `MethodController` only when the flag is exactly `true`. Unassigned brands retain the original model calls and stage JSON formats.

- Planning selects `editorial-planning` and its core dependency.
- Article writing selects `blog-writing`, with `conversion-copy` for a buy-intent brief's CTA placement.
- Article/social image fields select `visual-briefing`. This is visual briefing, not a new image provider or a dedicated image-brief model call.
- Social selects `social-repurposing`; the existing two-post and six-post recipes remain intact.
- Section regeneration uses the original generation receipt's exact methods. A legacy section does not silently acquire a new method pack.
- Profile extraction continues to extract brand data and cannot install methods.

Email, offer design, brand-context building, journey review, audience resonance and advocacy/referral are registry-only. Assignment reports an unavailable capability until their actual runtime paths exist.

## Trusted instructions and private evidence

The server resolves an exact assignment, release approvals, dependencies and canonical hashes before making a model call. Only reviewed operational fields become trusted method instructions. Provenance, examples, catalogue proposals and owner decisions are not compiled.

Brand profiles, research, article text and uploaded documents remain data. Existing factual constraints and stage output fields take precedence over a method. An uploaded instruction cannot install or enable a pack.

The model returns the existing asset JSON plus an internal `_method_sidecar`. The sidecar is validated, removed before the public stage-schema validation and stored in a private receipt. It contains decisions and model-reported quality findings; these are not independent factual verification. The ordinary source-marker/link/schema checks and downstream article checks remain necessary.

A failed check gets at most the existing stage retry, further bounded by the selected pack. The six-post campaign remains single-attempt. Rejected output is retained privately as a held draft when bounded and parseable. Unknown transport outcomes are recorded separately, without claiming the asset succeeded or inventing usage.

Methods add explicit token headroom checks. Context is bounded; an oversized package fails before model submission. Existing budget checks and publication controls remain active.

## Storage and authorisation

Proposed migration: `0138_seo_blog_method_packs.sql`. No applied migration is edited.

The migration creates an immutable release registry, catalogue proposals, private-organization enrolment, assignment revisions, production receipts and exact asset-version bindings. New tables use forced RLS. The runtime login has function access and no direct access to these tables. The new NOLOGIN/NOBYPASSRLS definer cannot be assumed by the runtime.

Private-use and public-commercial decisions are separate registry fields. Martin approved private use of six supported packs after validation in the 4 November chat. The other six remain pending; public commercial approval is blocked for every pack.

An operator must separately enrol a verified founder-owned organization. The migration enrols none. A genuine managing owner session may then use the internal `PgMethodStore.assign` or engine `assignMethods` command with the expected assignment revision and exact pins. No public HTTP assignment endpoint or commerce path is added. An empty assignment revision revokes future method use while preserving saved evidence.

Worker execution uses the existing content-command identity scoped to the brand. Reads and writes re-check the scope. User operations re-check the exact active portal session.

## Immutable releases

The author's returned files remain in `docs/relaunch72-rule-packs/`. Runtime releases are retained under `orchestrator/method-packs/0.1.0/`. Their canonical LF-normalised bytes have identical hashes.

A future version must be added as a new version directory and registry entry. Keep prior versions. Assignment changes are explicit; updating a file under an existing release causes a hash failure. Original receipts and saved assets remain immutable. Section regeneration also checks that its original methods remain assigned and approved.

The proposed schema extension is accepted. It adds four pack IDs and three stages; its metadata also changes the schema title and identifier. The original eight continue to pass the original schema.

## Scope of the review

All twelve packs are validated using Draft 2020-12, with unique stable IDs, exact acyclic dependencies and recorded canonical hashes. No template markers or obvious brand-specific operational facts were found. Manual reading did not find obvious third-party excerpts. This is not a corpus-wide similarity or legal determination.

Claude did not receive the separately held Drive training or the newer operating manual. The earlier Drive scan establishes high-level overlap, but this integration does not claim full method equivalence. Keep any detailed source-comparison work and commercial-use review private.

Names, bundles, free/paid placement, pricing and per-brand versus workspace licensing remain proposals. The catalogue is data only and changes no subscription.

## Validation and delivery

The targeted method tests use deterministic fictional home-maintenance and B2B scheduling examples. They verify the mechanics, draft differences and evidence separation; they are not live model-quality or real-market performance tests.

The disposable PostgreSQL proof runs only against localhost `relaunch72_test`, with a normal CREATEROLE database owner matching the earlier release proof. No production URL, marketing provider credential or deployment secret is used. The full suite normally skips opt-in PostgreSQL cases; the new PostgreSQL proof is run separately.

Final counts, exact source SHA, migration checksum and acceptance evidence are recorded in the review ledger when the gate passes. This branch adds no pull request and performs no deployment.

