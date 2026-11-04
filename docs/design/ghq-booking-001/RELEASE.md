# GHQ-BOOKING-001 — Growth HQ meetings and booking links

Founder-authorised scope: reusable meeting types, owner-created meetings, branded public booking, working hours/date exceptions, primary Google/Microsoft calendar conflicts and invitations, existing CRM records and navigation from Growth HQ. First type is Income Path Call,20minutes. Europe/London: Monday/Wednesday/Friday10:00–16:00; Tuesday/Thursday10:00–21:00; weekends closed. Hours, notice, horizon and buffers are editable.

Exact bases: Relaunch72 foundation `2bd32194a3a33d6e43cfa1b29d5b0769598fc137`; Group HQ main `44c2891e5045636751fc6c10bcd9888df62abe73`. Candidate branches are `codex/ghq-booking-20261104` in both repositories. Source publication does not establish ratification or live acceptance.

## Reuse and behaviour

The social planner and booking calendar share the extracted date/timezone/week/month helpers. Existing investor form fields render booking questions. Existing PKCE/state/session checks, provider app registrations, token refresh and authenticated encryption are reused. Calendar credentials use a separate `calendar` authenticated-encryption purpose and the booking calendar row: connecting Google or Microsoft never replaces the working investor mailbox. Calendar OAuth requests calendar and identity scopes, without requesting Gmail/Outlook message access. Existing mailbox consent remains unchanged. Current mailbox OAuth membership rules still apply to the reused consent-attempt boundary.

The runtime remains on Relaunch72; Group HQ adds an authenticated `/calendar` workspace front door, using the existing cross-brand links. Owner routes are `/portal/calendar`; public routes are `/book/{random-type-slug}`. Host profile, active session, workspace management and MHP entitlements remain authoritative. Bookings create CRM service activities, without verifying a visitor's email or granting marketing consent.

The app reserves a slot under the actual host's database lock before making a provider call. Concurrent requests cannot create two internal bookings. Identical command retries return the same receipt; changed evidence conflicts. Pending/uncertain operations retain their busy ranges. Rescheduling holds both old and new ranges until the provider accepts. Unknown outcomes are displayed as awaiting confirmation; no blind provider retry or automatic release occurs.

One primary calendar is supported per business. Reconsent to the same provider/address is allowed. Switching accounts requires cancelling uncancelled external bookings first, including past bookings still marked confirmed, so cancellation cannot be sent to a different provider/account. Owner-created private meetings need no provider and state explicitly that no invitation was sent; they can be exported as ICS. Published booking requires a calendar connection with actual granted scopes. Public views expose available times, not external event subjects or calendar credentials.

## Evidence and remaining acceptance

Focused core/provider/social/mail neighbours and booking journeys were run during implementation. The final SQL is separately rehearsed using real `r72_web` and `r72_identity_command` roles and synthetic identities on a new branch of production, with no provider calls. Two concurrent-client proofs establish one winner for a slot and one creation for an identical replay. This is an isolated schema/behaviour receipt, not live provider acceptance.

Final migration: `0138_growth_hq_bookings.sql`, canonical LF SHA256 `5ecc75d3f1f40915e06e20b9004d28bfa209bed52914a7cd04d60e4d10feede6`. Its exact checksum is pinned in runtime compatibility and migration discovery tests. Real-role/race receipt branch: `br-noisy-cell-b2orkzcm`, project `round-morning-64548835`. No production migration, provider token, message or calendar event was changed by those proofs.

The `Booking candidate` workflow runs Linux dependency integrity, TypeScript and the ordinary suite on the PR's exact source, with no database/provider secrets. Isolated proof is `orchestrator/test/db/booking-acceptance.proof.ts`; it requires the explicitly pinned disposable endpoint and refuses other targets. Root retains the exact-code test output and source SHA in its release receipts. Do not turn pending CI into a pass or infer product acceptance from unit counts.

Before live release: Astra reviews/ratifies the exact candidate and compatible bridge; Root completes the exact release gate and provider acceptance. The owner must consent to calendar access; old mail-only grants are insufficient. Google Calendar API must be enabled in the existing Google project. Microsoft uses the existing multi-account registration. No new client secrets or hosting services are needed.

## Executable cutover and recovery

1. Freeze and ratify the exact capable candidate, Group HQ front door, migration checksum and bridge SHA. Re-read authoritative GitHub refs through the API. Retain current deployment SHAs and verify the live schema is the exact137 prefix; stop if another migration occupies138.
2. Build the137-compatible bridge from the exact foundation base, carrying only the runtime readiness addition for this exact138 checksum. Prove it accepts the complete137 and exact138 ledgers, rejecting gaps, changed checksums, duplicates and unknown future rows. Deploy that exact bridge to every serving process that performs the shared ledger check. Keep queues and enabled checkout running. Confirm the actual `/ready` on both canonical Growth HQ hosts. Do not substitute `/health`.
3. Apply the frozen138 through the normal migrator: `npm run db:migrate`, using the existing migrator URL without printing it. The bridge remains compatible while this runs.
4. Deploy the exact capable SHA immediately on the existing service. Confirm `/ready`200 on `hq.propertypredator.com` and `app.martinhowardproperty.co.uk`; inspect the deployed SHA and logs. Reconcile every shared-ledger consumer before marking cutover complete.
5. As the real owner, open `/portal/calendar`, create the draft, check the founder's hours and connect Google or Microsoft through the existing callback. Confirm the investor mailbox is unchanged. Choose a meeting location/link, then publish the meeting type. Test a visitor booking, calendar conflict, CRM entry, receipt/ICS, reschedule and cancellation. A real invitation/test must be explicitly requested; do not send unsolicited messages to other people.
6. Deploy the Group HQ front door only after the capable routes are ready. Confirm navigation in both directions. Only then set `MHP_BOOKING_URL` to the real published booking link and smoke the existing application handoff. Keep its current blank/fallback value until acceptance.

If migration fails, the complete transaction rolls back and the137 bridge continues serving. If the capable application fails after migration, redeploy the exact137/138-compatible bridge, leaving138 and booking holds in place; do not downmigrate or resend uncertain events. Roll back the Group HQ front-door change with it. The older bridge does not serve new booking pages; existing provider invitations remain in the calendar, while Root restores the capable booking routes with a reviewed forward repair. Existing checkout, member CRM, webinar emails and SMS must remain running throughout. Never recover by weakening readiness or deleting appointments.

## Excluded

No checkout/pricing/tax/refund changes, round-robin, calendar marketplace, replacement CRM/auth, social publication changes, bulk campaign sends or new hosting products. Existing Meta approval monitoring is separate.
