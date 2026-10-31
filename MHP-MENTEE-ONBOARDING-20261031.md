# MHP-MENTEE-ONBOARDING-20261031

Founder instruction: invite mentees automatically on manual access, improve the first login destination, remove incorrect MHP preview labels, offer an embeddable investor lead form, and explain magic-link sessions.

Base: `9ca2d59122d26829bec1eb56235c2ef3f25a522b` on `codex/mhp-phone-layers-20261031`. Implementation branch: `codex/mhp-mentee-onboarding-20261031`.

Allowed: MHP transactional invite, HQ grant response, auth landing, MHP navigation labels, and the existing public investor-site enquiry capture/view. Preserve grant audit, entitlement rules, site privacy and consent, rate controls, host-only sessions, and other brands.

Acceptance: a successful HQ grant attempts a branded invite without claiming delivery on failure; magic-link login opens the member workspace; active MHP Desk/AI navigation has no Preview label; a published site's embeddable form captures an enquiry in that site's business CRM, with explicit contact request and no cross-business access. Focused tests, affected neighbours, exact release gate before publish.

Excluded: changing paid products or entitlements, extending session lifetime, automated lead-magnet delivery, marketing opt-in or follow-up enrolment, WhatsApp/SMS campaign launch, and unrelated PP work.

Validation checkpoint: changed auth/HQ/site/navigation code -> focused unit and route checks -> approximately 3 minutes. Release gate follows only after patch stabilises.

Checkpoint 31 October: focused MHP auth/HQ/mount/embed/navigation tests 32 passed, 0 failed, 0 skipped; `git diff --check` passed. Direct TypeScript compiler check via `cmd.exe`, `node ..\node_modules\typescript\bin\tsc --noEmit --pretty false`, passed with exit 0. The PowerShell/npm wrapper did not return after repeated waits, so its interrupted runs are not counted as passes. No new schema or provider send was exercised. Exact-source CI remains required before publication. Authenticated `gh api` publishing is unavailable on this host (`gh auth status` reports invalid Martoon196 token); no network Git fallback is permitted by workspace rules. No live deployment or customer acceptance is claimed.
