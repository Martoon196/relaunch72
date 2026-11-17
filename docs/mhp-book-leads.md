# Before You Buy: book sign-ups into Leads

Every sign-up from the book form (`/api/mhp/subscribe`, label `Before You Buy — book interest`, module
`book-before-you-buy`, kind `waitlist`) appears in the MHP brand CRM (workspace "Martin Howard Property · Marketing")
as a lead Martin can ring or message straight away. Code: `orchestrator/src/mhp/book-leads-service.ts`, shared
pieces with the webinar import in `orchestrator/src/mhp/signup-leads.ts`.

## What happens to a sign-up

1. The sign-up is saved first, exactly as before (`app_private.mhp_capture_signup_v3`). The visitor's answer, its
   timing and every other kind of sign-up (webinar, cheat sheet, course waitlist) are unchanged.
2. Then, without the visitor waiting, the lead is made through the CRM's own command `crm.createLead` (the same
   command and "New enquiry" lookup the webinar import uses), acting as the MHP lead owner:
   - a contact (source `mhp:book-before-you-buy`) with the email address, never marked verified;
   - the mobile, if given, as an unverified phone point (only if no other record in Leads already has that number,
     with 07… and +447… treated as the same UK number; a point belonging to another contact is never touched);
   - an enquiry `Before You Buy book enquiry · <name>` in the default enquiries pipeline's first open stage;
   - one open task `Follow up Before You Buy book enquiry`, due in one working day, saying what they asked for, their
     mobile ("Mobile: 07… (they asked for a call)" or "No mobile given"), marketing emails yes/no and texts/WhatsApp;
   - the sign-up details on the contact (custom fields `mhpSignup`, `mhpBookLatest`, `mhpProspectId`) and a timeline entry.
3. If that fails it is logged (`mhp book leads: …`, never an address), retried after 1 and 5 minutes in the same
   process, and otherwise brought in by the catch-up below. The sign-up itself is never lost, and neither is the
   mobile: right after the capture (same request, one statement) it is kept on that sign-up row by
   `app_private.mhp_book_signup_keep_phone` (0159). Every catch-up reads the stored book sign-ups
   (`app_private.mhp_book_signups`): exact consent and wording, the book mobile, never a webinar-given number.
   If two copies race, the one that loses still applies its own mobile and tick.

**Who owns the lead:** the existing rule for MHP enquiries made without a button press — the `ownerUserId` of the
`mhp` scope in `R72_GROUP_HQ_INBOX_SCOPES` (the same user the Group HQ inbox bridge and the LeadRelay feed use). The
start-up line `mhp.book-leads.readiness` says the mode: `automatic`, `no_owner` or `owner_cannot_manage`. In the last
two, sign-ups and mobiles are saved but nothing is copied on its own: one log line per process, Book interest says how
many are waiting, and one press of the button brings them in as the workspace's single active owner.

**Catch-up (durable):** there is no existing background job that can read sign-ups without an owner's session, so the
catch-up runs on each owner visit to Book interest (`/hq/registrants?audience=book`, up to 25 people, 3 seconds) and to
Growth CRM (`/hq/marketing`, in the background), and with the button **Bring book sign-ups into Leads** on the marketing
page (25 per press, continues where it stopped).

**Never twice:** one book enquiry per contact, ever. A repeat sign-up never resets, moves or re-opens an enquiry, never
adds a task, and never changes the owner; it only adds what is missing (a new mobile, sign-up details). An existing
contact with the same email is reused. If more than one record has the email, or it is archived, deleted or held for
review, the person is skipped and shown as "Needs you" on Book interest. Addresses ending `.invalid` are skipped.

## Permission, truthfully

- Email: the book form requires the tick, so the email point is "opted in" — unless the CRM already records an
  opt-out, which is never overridden. This is a CRM record only: nothing is verified and no permission to send is
  granted (sending still needs a verified address and the consent ledger).
- Phone points: the projection **never writes "opted out" on a phone point** (the owner's WhatsApp gate,
  `app_private.mhp_wa_owner_number_blocked`, reads that as a real opt-out for the number). Without the texts tick the
  mobile is "unknown", and "about the book only" is said in the task, the timeline and custom field `mhpBookPhones`.
- Texts/WhatsApp: the form may name the wording it showed (`CONSENT_FORM`) and send the optional second tick
  (`OPT_IN_MESSAGES`). Allowed wordings are listed in `MHP_CONSENT_WORDINGS` (`growth-service.ts`): `site-2026-10`
  (the default whenever a form names nothing), `book-2026-11` and `book-2026-11+messages`. The stored `consent_version`
  is the evidence; `+messages` is stored only with the second tick, the email tick and a usable mobile. Anything else is
  ignored, and the two fields count only on the book form (label and module). The mobile is "opted in" only for
  `+messages`, otherwise "unknown". A later sign-up with the tick upgrades only our own "unknown"; it never undoes a STOP
  or unsubscribe (any suppression recorded for the point) or anything anyone else set; not ticking again is never a
  withdrawal. An email unsubscribe reaches Leads at the next visit; ticking again lifts only that opt-out of ours.
- Book interest shows the book mobile (from the sign-up, even before the person is in Leads) and "Texts/WhatsApp
  offers" with the number beside it, from the latest book sign-up with a mobile ("Yes (ticked on an earlier sign-up)"
  when the lead already holds an earlier tick); the CSV includes both.

Nothing in this feature sends or queues any message.

## Migration 0159 and the 17 Nov 2026 quick fix

Production had a hand-applied trigger doing a reduced version of this inside the sign-up's own transaction
(`docs/ops/mhp-book-*-20261117.sql`, superseded: see `docs/ops/mhp-book-sync-20261117-SUPERSEDED.md`). Migration
`0159_mhp_book_crm.sql` removes the trigger, its function, its ten policies and exactly the grants it
added, touching no row; on a fresh database it changes nothing. The code recognises every lead the trigger made and
only fills in what it skipped (permission, sign-up details); stage, owner and tasks are left alone. The trigger stored
no mobile anywhere, so those earlier leads get one only if the person signs up again with it. 0159 also adds the
durable book mobile (the sign-up column and the two functions above); both starting states end identical.

**Release order:** this build on every service first (it is ready with 0159 pending or applied, and correct with the
trigger still live), then apply 0159 through the migration runner. Until 0159 is applied, a CRM fault inside the
trigger can still fail a book sign-up; apply it promptly after the deploy. Roll forward only.
