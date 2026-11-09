# Source-grounded authority programme review (011B)

This isolated preparatory component creates private owner-review candidates and useful resource briefs from supplied evidence. It makes no fetch, supplier, model, email or community calls, writes no storage and schedules or publishes nothing. It is not yet an integrated programme queue or live AI visibility feature.

## Input and provenance

The input uses the actual BrandProfile, KnowledgeRef, WebsiteInventory and WebsiteDeliveryEvidence contracts, plus optional unchanged641 supplier-indexed mention observations. Brand UUIDs and exact HTTPS origin must match. The profile must be confirmed and its knowledge references must exactly match the supplied current references; duplicates, unconfirmed guidance, cross-brand records and foreign scanned/delivery URLs reject. Only one current publication observation per article is admitted, so arbitrary historical UUID ordering cannot replace newer evidence. External canonical addresses may be recorded as review evidence rather than silently discarded.

The function captures a bounded JSON snapshot and hashes exact profile, ordered current references, inventory, delivery and optional supplier evidence. Stable rule-versioned finding IDs bind brand, rule and target separately from observation dates; a new observation changes the snapshot fingerprint without duplicating an unchanged prompt. A future queue adapter must lock and recheck current profile, knowledge, inventory and publication hashes before persisting or applying a proposal. A pure function cannot establish database currency or spend authority.

The explicit freshness window is a computational review policy,1–365days, not a spending limit. Inputs are limited to1MiB,250pages,30current deliveries and25supplier observations; results contain at most40findings with honest truncation and8briefs. The supplied snapshot is bounded evidence, never a complete domain audit. Source references include source kind/ID, actual source URL when available, observation timestamp and hash. Private profiles and supplier records have no fabricated public source URL.

## Meaning of a finding

Fresh scan metadata may prompt canonical/title/heading review. Duplicate titles count distinct URLs. These prompts do not diagnose a Google penalty, ranking position or page-wide H1 structure. Failed page reads and stale, unknown or incomplete delivery observations remain unknown; they never establish absence. The inventory does not measure robots permissions, meta/header noindex, structured data, backlinks, traffic or consumer AI placement. Those dimensions remain explicitly not measured, with no readiness/ranking score.

Optional DataForSEO observations retain platform, reported model, market/language, requested date range, supplier record dates, retrieval dates and truncation fields. An empty or partial supplier index sample is not absence from live consumer answers. Consumer result placement and referral traffic are never claimed by this component. Existing641 providers/types/qualification modules are imported byte-for-byte without new supplier access.

## Asset briefs and presentation

Checklist, resource and comparison briefs use exact confirmed audience/offer names, approved profile claims, successful current scanned pages and optionally a supplier-indexed question. Facts retain private profile/document references; open conflicts qualify them for renewed review rather than silently settling them. Every brief lists missing inputs and requests dated primary evidence for factual steps. It does not invent a study, original dataset, statistic, backlink, traffic gain or ROI. Missing audiences produce no brief; stale scans cannot produce current scan-grounded asset ideas. A changed source fingerprint rejects an earlier review/brief combination.

The pure card renderer shows the brand origin/profile, owner-review state, source dates, unmeasured dimensions and useful missing inputs. Only HTTPS source links are clickable, and source text is escaped. Section navigation and expanding evidence/briefs are the only interactions; there are no fake approval/publish controls. The standalone native fixtures are synthetic desktop and496CSSpixel iframe previews, not production brand changes.

## Evidence and remaining work

Focused tests cover source identity, current knowledge/confirmation, cross-brand/origin denial, stable deduplication, stale/incomplete evidence, exact supplier-index context, missing measurements, bounds, grounded briefs and HTML/link handling. Narrow TypeScript is the component gate; the combined exact release gate belongs to later integration. Actual durable jobs, budgets, provider admission/receipts, source-locked persistence, owner commands, native navigation and authority/outreach scheduling remain separate work. No shared engine/router/store/settings/SQL/package file is modified here.
