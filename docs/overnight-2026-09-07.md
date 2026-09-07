# Property Predator Growth HQ — overnight release handover

## Authority and current baseline

On 7 September 2026 the founder authorised implementation, testing, documentation and verified GitHub, Render, Neon and Zernio release work. Existing tenant isolation, exact-account binding, version-specific approval, consent, suppression, idempotency and unknown-outcome protections remain mandatory.

The verified baseline is:

- live Render revision observed: `016f102104c6727bba80b74a7ad352c41435938a`;
- authoritative GitHub tip: `11adb48a347568ed0406e642315e78569f721ae0`, a direct descendant of the observed live revision;
- Neon migration ledger: **97/97 contiguous entries with matching checksums**; and
- current implementation checkout: `worktrees/astra-overnight-hq-current`.

The 2 September `0090` Neon role-membership failure and `0093`-not-deployed statements are historical incident evidence. They do not describe the verified 7 September database state.

## Current release work

The HQ usability package provides a persisted Light/Dark/System appearance control, work-first Today page, ordered `Today / People / Inbox / Content / Results` navigation, simpler Content workspace, and clearer connection/permission/outcome wording. Quick navigation keeps specialist routes available under the existing capability checks. Results opens the existing authenticated overview reporting section. Drafts, Campaigns, Calendar and Library inherit the shared theme; social post previews preserve their channel appearance. It preserves the newer Zernio calendar, channel-pack and provider work on the authoritative source line.

## Candidate verification

- Complete local regression: **2,949 passed, 0 failed, 38 database cases skipped** (2,987 cases). Those database cases were not executed by this interface-only verification. No database schema or role changes are in this release.
- TypeScript typecheck passed. Supply-chain gate passed for 67 external packages with current SBOM.
- Final fixture-preview regression: 4/4 passed after adding the existing overview reporting capability to the preview fixture.
- Independent browser checks: actual fixture-rendered Today page, persisted appearance selection across routes, light/dark Drafts, ordered primary navigation, and expanded Results anchor. These are fixture visual checks, not live customer workflow or outbound-provider proof.
- Root review corrected light-theme navigation/button contrast and restored Actions, Journeys and Affiliates in quick navigation after the primary-menu simplification.
- Evidence outside the repository: `overnight-build-2026-09-07/_verification/hq-full-tests-final.log`, `hq-preview-final.log`, and `HQ-INTERFACE-RESULT.md`.

This is a first interface release. Deeper specialist pages still contain existing preview controls and technical wording. Theme preference is remembered separately on the HQ and main-product origins. This package does not claim the full CRM, social sending or entire nine-phase plan complete.

Release verification must record the exact committed SHA, authoritative remote SHA, Render deployed SHA and Neon ledger separately. A successful build or push is not a deployment claim. No outbound communication should be replayed merely to recreate proof.
