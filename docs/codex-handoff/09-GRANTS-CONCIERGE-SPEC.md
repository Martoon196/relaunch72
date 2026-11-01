# Relaunch72 Grants — Codex Build Specification
Version: 1.0 | Date: 2026-11-01 | Status: PROPOSED / NOT DEPLOYED
Repo: Martoon196/relaunch72 | Owner review required before implementation and launch

## 1. Mission
Add a paid, multi-tenant **grant discovery, eligibility, application drafting, application management and award support** service to Relaunch72. Customers can obtain a free funding fit check, purchase application support, upload evidence, approve drafts, track funder correspondence, and manage awards. Relaunch72 must never promise that funding will be awarded. A grant is not necessarily unrestricted cash and may require match funding.

Codex: READ the repository README.md, docs/platform-architecture.md, docs/roadmap.md, docs/decisions.md and docs/codex-handoff/00–08. Audit the actual code and identify gaps before editing. Implement on a new feature branch, add tests and submit a draft PR. Do NOT deploy, charge, email external parties, submit grants or alter existing production behaviour without explicit founder approval. Preserve the existing marketing intake (A1–H4), S0–S10 pipeline, QA, portal and billing.

## 2. Existing code reality
The current Relaunch72 monorepo uses TypeScript/Node ESM, npm workspaces, node:http, Stripe, Anthropic, AJV, Postmark/Brevo, server-rendered admin/client portal and a static public funnel. Its marketing engine produces nine deliverables with human QA. A thin CRM exists, but persistence is flat JSON/JSONL, not a relational DB; tenant isolation and billing joins need hardening; no durable job scheduler or full roles/permissions; live integrations are largely unverified. See docs/codex-handoff/08-HONEST-GAP-REPORT.md. The grant service MUST NOT inherit these weaknesses for sensitive client files. The founder's current architecture preference is the owned portal, not GoHighLevel.

## 3. Offer and commercial workflow
Working name: Relaunch72 Grants (brand, copy and pricing subject to approval).
1. Free Funding Fit Check: short separate intake; deterministic hard-gate eligibility screening; clearly labelled uncertain answers.
2. Paid Grant Readiness Audit: verified shortlist, ranked fit, eligibility gaps, cash match, required partners, evidence checklist and deadlines.
3. Paid Application Service: research, evidence gathering, project narrative, scored answers, impact case, budget, QA, client review and export.
4. Managed Applications: deadline calendar, tasks, correspondence, revision and outcome tracking.
5. Award Support: award agreement obligations, milestone reports, claims evidence and audit calendar.
6. Optional subscription: recurring grant radar with verified new opportunities and alerts.

Configurable SKUs, no invented pricing. Optional success fees only after scheme rules, contract and legal review. Distinguish grants from loans, tax relief, equity, prizes, rebates and cloud credits in every UI.

## 4. Customer journeys
Public page: explanation -> Funding Fit Check -> match preview -> consent -> account -> paid service -> secure evidence vault -> application workspace -> client approval -> applicant submission -> tracking -> outcome -> post-award support.
The grant intake must NOT overwrite the existing 45-question marketing intake. Allow a business to have several funding projects and several applications, with each legal applicant verified separately.
Portal: company profile; project profile; verified opportunity list; hard eligibility blockers; source links and verification dates; evidence requests; section-by-section draft review; budget and match-funding calculator; tasks; correspondence; approval and audit log; awards.
Admin: source verification queue, application QA queue, deadlines, client tasks, redaction, access control, consent, invoicing, award compliance.
Default to manual email forwarding/upload; optional OAuth only after explicit granular consent and security review.

## 5. Data model (adapt to current architecture; add migrations)
Every client-owned record must carry tenant_id and auditable timestamps. Use relational storage and encrypted private object storage before accepting real sensitive documents.
- ApplicantCompany: exact legal name, company number, jurisdiction, trading date, UK work location, sector, FTE, turnover, group structure, ownership/control, IP ownership, accounts evidence, verification state.
- FundingProject: product, problem, R&D novelty, TRL evidence, team, work packages, outcomes, costs, cash contribution, applicant entity, stage.
- FundingOpportunity: funder, programme, round, official URL, type, opening/closing with timezone, actual grant amount vs project cost, funding rate, sector, region, company-age/FTE/TRL gates, mandatory partners, eligible costs, source snapshot, last verified.
- EligibilityRule and EligibilityAnswer: hard criterion, yes/no/unknown, evidence, reviewer, blocker reason and date.
- Match: project/opportunity, gate status, fit score with explanation, cash-match estimate, urgency and confidence.
- Application: applicant, round, portal URL, state, owner, deadline, versions, approval, external submission reference.
- ApplicationQuestion: official question, word limit, evidence-linked answer, revision history, review comments.
- EvidenceFile: encrypted storage ref, category, owner, provenance, checksum, access policy, retention, malware scan status, permitted use.
- BudgetLine: cost category, basis, eligible amount, VAT treatment, grant rate, funder share, applicant share, version.
- Partner: independent/linked status, size evidence, contribution, role, IP and data rights, authorised contact.
- Task, Correspondence, Approval, AuditEvent, Award, Claim, Report, SubscriptionEntitlement.
Explicit application states: discovered -> screening -> qualified -> evidence_needed -> drafting -> internal_review -> client_review -> approved -> submitted -> clarification -> awarded/rejected/withdrawn/expired. No invalid state transitions.

## 6. Discovery and matching
Implement FundingSource adapter interface with fixture/mock adapter and independently verified live adapters only where an official API, feed or permitted retrieval exists. Candidate official sources: Find a Grant, Innovate UK Innovation Funding Service, UKRI, local authorities/growth hubs, EU Funding & Tenders, EIC, Eureka and scheme owners. DO NOT invent endpoints or bypass terms. If no supported API, use curated records with manual verification.
Ingest -> normalise -> deduplicate round -> extract cited eligibility -> human verify -> publish. Preserve official URL, snapshot hash, last_checked, original timezone, closing time and changes. Expire stale 'open' statuses automatically.
Hard gates are deterministic and precede ranking: legal entity, geography, age, FTE, sector, TRL, company size, ownership, match-funding, eligible spending, partner requirement and deadline. Unknown is NOT pass. Fit score then weighs project fit, evidence readiness, effort, cash burden and deadline. Show exactly why each result matches or fails.
Never treat '£250k eligible project costs' as '£250k grant'. Show formula and assumptions. Never infer eligibility for overseas grants from global customers.

## 7. Grant-specific AI pipeline (separate from marketing S0–S10)
G0 consent/identity -> G1 applicant/project facts -> G2 official eligibility hard gates -> G3 evidence checklist -> G4 official application question capture -> G5 evidence-grounded draft -> G6 budget -> G7 technical/impact/commercial case -> G8 adversarial QA -> G9 customer approval -> G10 submission handoff/receipt -> G11 outcome and award obligations.
No LLM may make the final eligibility decision or invent company numbers, funding amounts, customer results, TRL, employees, match funding, patents, partnerships, signatories or technical performance.
Every material claim links to a verified customer document/declaration, official source or independently verified evidence. Unverified content must display [CONFIRM: field] and BLOCK final submission. Separate achieved results from proposed targets. Log prompt/model version, source IDs, QA findings and approvals. Human review mandatory.
Deliverables: verified shortlist, eligibility report, project brief, all question drafts, budget, partner brief, risk register, Gantt/work packages, impact model, technical-evidence request, compliance checklist, final approved export. Export != submission.

## 8. Consent, security, legality and trust
- Never impersonate applicants, forge signatures, submit declarations or send funder emails without recorded applicant approval. Follow each funder's rules on intermediaries and authorised submitters.
- UK GDPR: lawful basis, privacy notice, data minimisation, encrypted files, tenant RBAC, audit log, retention, export/deletion, DPA as needed, breach handling. Never put bank statements, identity documents, shareholder records or credentials in Git or LLM prompts without minimisation and permission.
- Secure uploads: quarantine until malware scanned; private signed downloads; encrypted secrets; no public URLs.
- Detect duplicate/double funding, conflicts, connected-company ownership, subsidy-control issues, IP disputes, misrepresented partners and unsupported evidence. Escalate legal/tax/accounting questions.
- Treat grant success fee and consultant fees as service fees, not assumed eligible grant costs.
- No fake success rate, 'guaranteed grant', fake deadlines or unsupported public claims. Customer-facing copy needs founder/legal review.
- Record approval with applicant legal entity, scheme, exact application version, approver, timestamp and scope. External submissions should initially be manual only.

## 9. Billing and operations
Integrate new grant SKUs into existing Stripe adapter, but fix tenant_id-based entitlement mapping, webhook idempotency and lifecycle gating; do not rely solely on matching email. Do not change existing marketing products/prices. Build task scheduler with durable queue, retries, locks, alert deduplication and source freshness checks. Notifications are opt-in. Client remains responsible for truthful declarations and final approval. Delivery SLAs depend on funder requirements, not a blanket 72-hour promise.

## 10. Research seed catalogue — 1 November 2026, reverify every round
These are leads, not eligibility approvals. Seed only with explicit 'research lead / needs refresh' status.
| Programme | Deadline | Funding semantics / key gate | Official source |
|---|---|---|---|
| Frontier AI SME Champions | 11 Nov 2026 | £150k–£250k PROJECT COST; up to 70% small/micro; solo UK SME; genuinely novel AI | https://apply-for-innovation-funding.service.gov.uk/competition/2584/overview/4c7afb5d-4572-4ef2-9507-73ef2dec8ec8 |
| Efficient, Structured and Controllable AI | 18 Nov 2026 | £50k–£150k PROJECT COST; up to 70% small/micro; solo; core AI novelty | https://apply-for-innovation-funding.service.gov.uk/competition/2582/overview/9fdb47a5-011c-4c47-ac5e-c426e295fe89 |
| KTP Round 4 | 27 Jan 2027 | Up to 67% eligible costs for SME; university/research lead; business >=2 FTE | https://apply-for-innovation-funding.service.gov.uk/competition/2605/overview/4b82d27a-2794-457c-8dc7-7ec4f6911c84 |
| North Northamptonshire Start Your Business | 7 Dec 2026 | £500–£1k, no match; local residence/trading, pre-start or under six months, 3 BIPC sessions | https://www.northnorthants.gov.uk/grants/start-your-business-north-northamptonshire |
| BridgeAI Decision Critical | 8 Dec 2026 | £100k–£200k grant request; TRL 5–6; compulsory medium/large deployer and consortium | https://apply-for-innovation-funding.service.gov.uk/competition/2598/overview/cfb35198-55fc-4aad-afa1-86a260bfaddf |
| Women TechEU | 14 Jan 2027 full proposal | €75k; genuinely women-led deep-tech company, strict age/TRL/equity criteria | https://womentecheurope.eu/active-calls/ |
| European Prize for Women Innovators | 1 Dec 2026 | Prize, not reimbursed project grant; qualifying woman founder and incorporation date | https://eic.ec.europa.eu/eic-prizes/european-prize-women-innovators-powered-eic-eit_en |
| CoSTAR Creative Intelligence | 17 Dec 2026 | £50k creative tech award; original demonstrator, not routine marketplace | https://www.costarnetwork.co.uk/calls/the-creative-intelligence-award |
| EIC Accelerator | 4 Nov 2026 | Single-company deep-tech, >=TRL 5; up to 70% grant component, UK grant-only route | https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/HORIZON-EIC-2026-ACCELERATOR-01 |
| UK–Germany R&D | 1 Dec 2026 | Independent German SME, clean-energy R&D | https://apply-for-innovation-funding.service.gov.uk/competition/2583/overview/852abf67-ada4-49d3-b512-cf7c5ec6ac71 |
| UK–Singapore R&D | 16 Dec 2026 | Independent Singapore business, genuine joint R&D | https://apply-for-innovation-funding.service.gov.uk/competition/2526/overview/4a4b67b9-9b73-4816-8e21-bdfab83f5909 |
| Eureka Globalstars Japan | 19–20 Jan 2027 | Independent Japanese SME, joint R&D and dual submission | https://apply-for-innovation-funding.service.gov.uk/competition/2586/overview/d9e61ae4-6e56-4f38-9206-5d91ef98c916 |

## 11. Test and release acceptance criteria
- Cross-tenant users cannot read, edit, export or retrieve another tenant's company, documents, applications or tasks, including guessed IDs.
- No opportunity marked 'eligible' with unknown hard gates; no stale source marked 'open'; deadlines handle timezones and DST.
- £ amount tests distinguish eligible cost, grant request, funding rate, applicant contribution and currency.
- AI fabricated citation/number/TRL/partner/award claim fails QA and blocks submission.
- No external email, portal submission or signing occurs without explicit approval; idempotent retries cannot duplicate communications.
- Upload malware quarantine and access checks; deletion/export; audit trace; privacy controls.
- Stripe duplicate webhooks cannot duplicate entitlements or charges.
- Regression suite for existing marketing pipeline, intake, billing and portal remains green.
- Fixture-based end-to-end grant journey works with mock source/model; test labels make clear no real application was sent.
- Deliver API route inventory, schema/migrations, test results, threat model, screenshots, deployment runbook, and known limitations before production.

## 12. Phased implementation
P0: repo audit; founder product/pricing approval; security/storage/tenant plan; source data contract.
P1: grant-specific intake, applicant/project model, official-source curated catalogue, hard-gate matcher, admin verification.
P2: evidence vault, drafting/QA, budgets, client approval and export.
P3: task/deadline/correspondence tracking, notifications, Stripe entitlements and admin queues.
P4: permitted live source adapters, optional mailbox integrations, post-award support and monitored rollout.
No auto-submission in MVP. Feature-flag each phase. Report honestly what is live, mock, partial or not built.

## 13. First pilot data (internal only; NOT public case study)
Potential pilot projects: Property Predator (AI property appraisal/underwriting, novelty unverified); Ordris (property management/compliance and AI document parsing); Heatward (pre-launch heating controls, no live hardware proof); Stock & Key (pre-launch property supply); Sabrina's global Podcast Recruitment Agency (PRA, incorporation/trading date and location unverified).
Vernon Property Group is a possible real-world validation environment: user-supplied ~£15m portfolio, ~£60k/month current rent with ~£70k/month projected, four staff, Freddie 80%, MH196 Ltd 20%. Do NOT infer medium/large status from portfolio value; group accounts, company control and sector eligibility remain to be verified. These are user-supplied facts for a private pilot, not verified marketing claims.
No Sabrina application may be submitted in her name without explicit authorisation, correct legal entity and her approval of each final declaration.

## 14. Codex handback
Before coding, return: (a) concise repo reality audit, (b) proposed schema/API/routes/UI, (c) blockers requiring founder decision, (d) phased estimate and tests. Then implement P1 on a branch with a draft PR. Keep this spec and actual implementation status separate. Do not claim grant wins, submission or live APIs until evidenced.
