# Property Predator Brand Brain foundation

**Status:** fixture-only foundation. No model, retrieval, upload, provider or
network execution exists in this strike.

This foundation makes Growth HQ aware of the AI and brand assets Property
Predator already owns without copying the underlying instructions, knowledge
text, images or private platform state. The source repository remains the
full-text authority. Growth HQ stores only one trusted, hash-addressed metadata
manifest plus independently recorded HQ evidence.

## Trusted source release

The accepted v1 source is
`property-predator.ai-inventory/v1`. Its canonical package SHA-256 is:

`d55afac02ac995f6157749181cf230ea8acc23b7b129dd6f92f63bcd04b57300`

The exact offline fixture bytes are also pinned at:

`e34b0ca9ac8ab4afdb1e8cd44ca0f3fc1f8362836332eca8a1f02cf71fa366e2`

The manifest contains 11 source references, six specialist profiles, ten
artwork references and one unresolved visual-policy quarantine. It contains
paths, identities, byte counts, ownership/privacy states and SHA-256 digests;
it contains no prompt body, knowledge text, image bytes, credential or customer
record.

The six source-owned specialists are social, content, image, email, video and
paid media. Every profile references the same runtime brand digest and exact
role, policy, instruction and knowledge source digests. Reference-only and
quarantine-only sources cannot be linked into a runtime specialist.

The founder-named Content Marketer, Image Maker and Social Media Manager are
registered only as `awaiting_founder_export` placeholders. They are explicitly
non-callable. A ChatGPT consumer-product GPT or share link is not treated as an
application API.

## Database boundary

Migration `0031_property_predator_brand_brain_foundation.sql` creates 11 tables
under `app_private`. They cover:

- the immutable source release and exact source/artwork/profile hash references;
- exact specialist-to-source and quarantine-to-source relationships;
- short-lived source freshness attestations;
- a pinned offline evaluation result;
- independent ownership/licence, privacy/security and brand/readiness decisions;
- a final activation receipt whose `provider_effects` value is forced to false.

Every relationship uses workspace-scoped composite foreign keys. Every table
has forced row-level security, is registered in the workspace-table registry
and rejects update/delete mutations. `r72_content_adapter` may stage the source
inventory and evaluation evidence. `r72_content_command` may record manager
decisions and the effects-off activation receipt. The web role has no direct
table access. Neither Brand Brain role has provider-operation insertion or
worker-role membership.

The database does not trust aggregate counts alone. Child rows must match the
trusted canonical manifest. Capability and rule arrays use exact JSON equality.
Each specialist must have exactly one role, policy, instruction and knowledge
link, and every link must name the source allowed for that relationship in the
canonical profile. The quarantine must retain its exact two source links.

## Independent gates

Source approval is provenance evidence, not HQ approval. Activation requires:

1. a complete exact-manifest projection;
2. a fresh source attestation, no more than 15 minutes old;
3. the exact offline v1 evaluation suite, with all four positive and all five
   held-out negative cases passing;
4. an HQ approval for ownership/licence;
5. an HQ approval for privacy/security;
6. an HQ approval for brand/readiness.

The offline suite SHA-256 is
`88ca474133d36bbc4345f180e9045feb31d9ddec6b2bb0a5eb810c894f22de51`
and the pinned runner is
`property-predator-brand-brain-offline-eval/v1`. The fixture stores case IDs and
assertion codes only. Held-out negative cases are not source knowledge and can
never enter a runtime source selection.

Any changed source digest creates a different package and therefore a new
release. Prior reviews, evaluations and activation receipts do not transfer.

## Effects-off planner

The planner accepts only an activated, fresh, evaluation-passed snapshot and
the exact verified source inventory. It compares every stored source digest and
status to the manifest, selects only the chosen specialist's exact
runtime-authority hashes and returns a deterministic metadata plan.

Every plan has:

- `providerEffects: false`;
- `callable: false`;
- `sourceReviewRequired: true`;
- a deterministic plan SHA-256;
- the three external-GPT placeholders marked non-callable.

There is deliberately no executor. Plans do not contain a prompt, do not call a
model, do not create a provider operation and do not enter an outbound queue.

## Panther conflict

The legacy admin image style permits a photoreal black panther while the current
production kit forbids animal mascots. The exact conflict remains quarantined
as `legacy-black-panther-vs-current-no-animal/v1`. It must not be silently
merged. Non-image specialists may be effects-off ready after all gates pass;
image readiness remains blocked until a later founder decision creates a new
reviewed source release.

## Privacy and future live gates

Append-only evidence does not justify retaining raw personal data forever.
This foundation avoids raw source bodies and replaces free-text review notes
with bounded reason codes. Before any future full-text/file import, production
retrieval or model execution, a separately reviewed lifecycle must define raw
blob erasure/tombstoning, ownership/licensing evidence, privacy review,
retention, access audit and deletion behavior.

Live model/API credentials, vector/file stores, customer data, network fetching,
outbound messages, social publishing and provider effects all remain separate
authorisations and are not enabled by this foundation.

## Verification

Local tests pin the source fixture bytes and canonical hash, attack self-signed
replacement packages, prove held-out/quarantine exclusion, prove the panther
image block, and inspect the SQL role/row-level-security/immutability contract.
An opt-in disposable-Postgres integration test additionally attempts direct-role
capability subsets, quarantine-rule subsets, wrong semantic links, an arbitrary
evaluation suite and incomplete activation. It runs only through the explicit
guarded disposable-database command.
