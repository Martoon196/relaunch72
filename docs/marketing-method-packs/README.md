# Relaunch72 draft marketing method packs — authoring return

Status: **draft authoring return, 3 November 2026**. Nothing here is approved, installed, assigned to a workspace or sold. The recorded live release still uses its existing generation path; no production configuration, subscription, migration or publishing approval changed.

## What is in this folder

| File | Pack | Stages | Dependency |
| --- | --- | --- | --- |
| `production-core.json` | Shared production discipline (audience, purpose, claim ledger, one next action, bounded revision, honest receipts) | all | none |
| `editorial-planning.json` | Topic selection inside the existing one-pillar-plus-six cluster contract | planning, revision | production-core 0.1.0 |
| `blog-writing.json` | Format selection, mechanisms, evidence discipline, skim structure, section revision | blog, revision | production-core 0.1.0 |
| `conversion-copy.json` | Awareness, angle, benefit order, permissioned proof, objections, structure, hooks, one action | copy, revision | production-core 0.1.0 |
| `social-repurposing.json` | Channel adaptation of one exact article; preserves the two-post default and the six-draft campaign recipe | social, revision | production-core 0.1.0 |
| `visual-briefing.json` | Visual job, composition, illustrative vs evidential, assets only if present, alt text, dimensions | visual-brief, revision | production-core 0.1.0 |
| `email-writing.json` | Authoring contract only (no sender, list or send capability implied) | email, revision | production-core 0.1.0 |
| `offer-design.json` | Authoring contract only (proposals, never facts; no selling copy) | offer, revision | production-core 0.1.0 |
| `rule-pack.schema.json` | The authoring schema these files validate against (copied from the handoff) | | |

All eight validate against `rule-pack.schema.json` (JSON Schema 2020-12), use semantic version `0.1.0`, `status: draft`, `intendedScope: private-owned-brands`, have unique ids, exact dependency versions and no cycles. Re-run the check with any 2020-12 validator; the packs contain no placeholders.

## How they were written

- Every rule is original authorship for this platform. No private training corpus, licensed manual, copied prompt, customer record, credential or brand price appears in any pack (`provenance.privateSourceReferences` is empty in each file by design).
- Stage compatibility was taken from the recorded prompts (`prompts/seo-blog-plan.md`, `seo-blog-article.md`, `seo-blog-section.md`, `seo-blog-social.md`): cluster shape, article field limits and citation markers, link restrictions, the two-post social default and the `six_angle_campaign` recipe, and the neutral `image_alt` rule. The packs narrow those contracts; they never widen them.
- Examples use two fictional brands with explicitly invented facts (a home-maintenance business and a B2B scheduling business) so the same method can be shown with separate facts, audience and voice and no cross-brand leakage.
- `email-writing` and `offer-design` are authoring contracts, as the architecture recommends, until a real drafting or offer-workflow path exists.

## What a reviewer still has to decide (not supplied by these files)

- Private-use approval for Martin-owned brands, and separately public commercial release approval, are recorded server-side decisions. A generated field cannot supply either; the server combines its registry record with the computed canonical SHA-256.
- Which packs are included versus upgrades, per-brand versus workspace-wide access, and pricing.
- Canonical hashing, registry/assignment storage and the trusted method-compilation boundary are Codex implementation work (see the handoff's implementation and acceptance plan); do not invent a migration number before inspecting the current repository.
