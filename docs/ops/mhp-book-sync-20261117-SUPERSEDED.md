# Superseded: the 17 Nov 2026 hand-applied book sign-up trigger

`mhp-book-contact-sync-20261117.sql` and `mhp-book-pipeline-sync-20261117.sql` (the second replaces the function from
the first) record SQL that was run by hand on production outside the migration ledger. They are kept as the record of
what production has. **Do not run them again.**

They are superseded by migration `0159_mhp_book_crm.sql` together with the application code in
`orchestrator/src/mhp/book-leads-service.ts` (see `docs/mhp-book-leads.md`):

- 0159 drops the trigger `mhp_book_contact_after_signup`, the function `app_private.mhp_book_contact_after_signup()`,
  the ten `mhp_book_*` policies, and revokes exactly the grants these two files gave `r72_mhp_prospect_definer`. It keeps
  that role's SELECT on `app.contact_points` (granted by migration 0134). On a database that never had these files it
  changes nothing.
- No row is changed: every contact, enquiry and task the trigger made stays, and the application recognises them
  (source `mhp:book-before-you-buy`, custom field `mhpProspectId`, enquiry name `Before You Buy book enquiry…`) and
  only fills in what the trigger skipped (mobile, email permission, sign-up details).

Release order: the new code on every service first, then 0159 through the migration runner.
