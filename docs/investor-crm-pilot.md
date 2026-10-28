# Investor Desk pilot

INV-CRM-001 builds on Relaunch72's existing Growth HQ identity, CRM, inbox records and LeadRelay. Martin is the programme administrator. There is no second administrator or brother account. Start with **My test business**; add the two paying mentees from the programme dashboard later.

## Candidate capabilities

- A branded Investor Desk with investors, pipeline, follow-ups, requirements and a six-template playbook.
- Programme controls to create a business, open it as mentor, confirm an existing payment reference, activate access and suspend access. Activation produces a native account setup link. No automatic payment collection or invitation sending.
- Separate business workspaces, memberships, contacts, templates, websites and mailbox connections. Switching businesses rotates the login session.
- Gmail, Microsoft 365 and custom SMTP/IMAP connection paths. Credentials use workspace-bound authenticated encryption. SMTP uses TLS on 465/587; IMAP uses TLS on 993. The custom provider requires the full mailbox address as its username and a public IPv4 mail server.
- Canonical email drafts and review. Approving does not send. A separately confirmed send requires an existing approval, exact mailbox version, unchanged recipient/body, recorded investor request and no current suppression. A timeout is never retried automatically. Provider acceptance is not labelled delivery.
- Manual **Sync replies**, limited to known investors and this business's mailbox. Initial window: 30 days; IMAP batches up to 50, Gmail/Graph up to 25. Attachments stay in the mailbox; large/unsupported messages are counted as skipped. Long plain-text bodies are bounded. This is not continuous background sync or a complete mirror of personal mail/sent folders.
- A branded investor website with editable copy, preview, explicit publication and enquiries saved to the same CRM. Public route: `/investor-sites/<slug>`. Enquiries do not fabricate email verification or marketing consent.
- Existing LeadRelay entry point. Existing installation grants control access; creating a business does not automatically grant access to an existing chatbot/call agent.

## Martin's first-use journey after release

1. Open Growth HQ → Investor Desk → Mentee programme. Create **My test business** using your existing login email, then open it.
2. In Business setup, set the name, colour and signature. Add an investor address you control and their requirements.
3. Connect and check a mailbox. Custom SMTP/IMAP uses an existing mailbox from your chosen host; the CRM does not buy a domain or create a hosted email account. Google/Microsoft appear when their platform OAuth applications are configured.
4. Create a draft, inspect the full recipient/subject/body, record the actual email request and approve it. Delivery remains unavailable until the deployment switch is enabled. Use only the explicitly agreed owned test address for the first live test.
5. Reply from that address and select Sync replies. Confirm the right business/thread. Repeat with a second isolated test business before mentee onboarding.
6. Preview the website, supply your real privacy notice and publish after review. An entered custom domain is a request, not proof of DNS/TLS routing. The canonical route works after publication; custom host routing remains a separate integration step.
7. Add each mentee as awaiting payment, check their actual payment, then activate with the reference. Share the setup link through your chosen channel. No commercial terms are invented by the app.

## Deployment configuration and release gates

Use the hosting provider's protected secret controls, never shell arguments or tracked files:

- `INVESTOR_MAIL_ENCRYPTION_KEY`: canonical base64 encoding of a random 32-byte key. Preserve it with the existing secret backup process; replacing it makes stored connections unreadable until reconnected.
- `PORTAL_BASE_URL`: trusted HTTPS Growth HQ origin for setup links and OAuth callback.
- Optional Google `INVESTOR_GOOGLE_CLIENT_ID` / `INVESTOR_GOOGLE_CLIENT_SECRET`. Callback `/portal/investors/mail/callback`; Gmail send/read scopes and provider app consent requirements apply.
- Optional Microsoft `INVESTOR_MICROSOFT_CLIENT_ID` / `INVESTOR_MICROSOFT_CLIENT_SECRET`. Same callback; Mail.Read/Mail.Send and refresh access.
- `INVESTOR_MAIL_DELIVERY_ENABLED`: off by default; set `true` only for the reviewed pilot and owned-address transport test. Per-message approval and recipient permission remain required.

No live credentials were added and no real email was sent during this build. Branding alone does not verify a mailbox. Domain purchase, mailbox hosting and custom-domain DNS/TLS are not provisioned by this candidate.

Before production cutover, ratify the exact source and verify the authoritative branch/database base. Run the existing migration runner with protected migrator credentials on a fresh isolated copy and verify ledger/readiness. The final suffix has been exercised through Neon; that is not a direct migration-runner receipt. The explicit `test/db/investor-runner-proof.ts` harness is available for a protected test environment but has not passed against a real database in this session.

Prepare an exact compatible recovery artifact before changing production. The app rejects unknown migration versions, so simply rolling code back after applying 0107–0112 is not valid recovery. Keep the existing deployment until prerequisites and a tested forward/recovery procedure are ready. Do not disable checkout or another enabled journey for this pilot.

This is a source candidate with synthetic acceptance evidence, not a ratified or live release. See [checkpoint](investor-crm-pilot-checkpoint.md) and [visual checks](investor-preview/checks.json).
