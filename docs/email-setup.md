# Turning on email — Postmark (transactional) + Brevo (marketing)

Two providers, two jobs:

- **Postmark** sends **transactional** email — the one-to-one "your pack is ready"
  delivery, triggered by a specific action. Wired into `npm run deliver`.
- **Brevo** runs **marketing** sequences — the nurture drip (scorecard → autopsy)
  and the onboarding drip (after a purchase). The code syncs a contact into the
  right Brevo list; the drip itself is a Brevo automation you build once in their UI.

Like the payments work: the code is done and tested. What's below is the account
setup only you can do. Nothing sends until you add the keys — and even then, the
delivery send is opt-in (`--send`), never automatic.

---

## A · Postmark (the delivery email)

1. Create a Postmark account → a **Server** (call it `relaunch72`).
2. **Verify your sender**: Postmark → Sender Signatures / Domains → add
   `relaunch72.com` and complete the DKIM + Return-Path DNS records (Namecheap,
   same place you did the site DNS). Postmark won't send from an unverified domain.
3. Copy the server's **Server API Token**.
4. Add to the environment (locally in `.env`, and/or in Render if you want the
   backend to send):
   ```
   POSTMARK_SERVER_TOKEN=<the server token>
   EMAIL_FROM=Relaunch72 <hello@relaunch72.com>
   EMAIL_REPLY_TO=hello@relaunch72.com
   ```
5. Send a delivery pack (only ever runs on an **approved** run):
   ```bash
   npm run deliver -- --run runs/<id> --to customer@theirdomain.com --send
   ```
   Without `--send` it's a dry-run (writes `delivery/email.txt` + `.eml`, sends
   nothing). With `--send` it emails the customer via Postmark and attaches the
   branded PDFs (if they fit ~8MB). `--send` is your explicit "yes, email this
   real person."

## B · Brevo (the nurture + onboarding drips)

1. Create a Brevo account → **SMTP & API → API Keys → Generate** a key.
2. Make two **contact lists** and note each numeric **list ID**:
   - one for **leads** (scorecard signups) → the nurture sequence
   - one for **customers** (paid) → the onboarding sequence
3. Add to the environment (Render, since these fire from the backend):
   ```
   BREVO_API_KEY=<your key>
   BREVO_LIST_LEADS=<leads list id>
   BREVO_LIST_CUSTOMERS=<customers list id>
   ```
   Empty key = marketing simply off; `/api/subscribe` still returns 200, it just
   doesn't sync — nothing breaks.
4. Build the two **automations** in Brevo (Automations → new):
   - **Nurture**: trigger "contact added to *leads* list" → the 5 nurture emails
     from `docs/funnel/02-copy-pack.md` (spaced per the day-map in `01-offer-ecosystem.md`).
   - **Onboarding**: trigger "contact added to *customers* list" → the 5 onboarding
     emails from the same pack.
   All the copy is already in **USD** — paste it straight in.

### What triggers a sync (already wired)
- A **scorecard** email submit → `POST /api/subscribe` → contact added to the leads list.
- A **paid order** (Stripe webhook) → contact added to the customers list, tagged
  with the tier. Fire-and-forget, so a Brevo hiccup never breaks a payment.

---

## Where each email lives

| Email | Provider | Trigger | Source |
|---|---|---|---|
| Pack delivery ("your relaunch is ready") | Postmark | `deliver --send` on an approved run | `src/deliver/deliver.ts` |
| 5× nurture (scorecard → autopsy) | Brevo | added to leads list | `docs/funnel/02-copy-pack.md` |
| 5× onboarding (post-purchase) | Brevo | added to customers list | `docs/funnel/02-copy-pack.md` |

## Go-live checklist for email
- [ ] Postmark domain verified (DKIM/Return-Path in DNS)
- [ ] `POSTMARK_SERVER_TOKEN` set; a real `--send` test to your own inbox lands + looks right
- [ ] Brevo two lists created, IDs in env
- [ ] Both Brevo automations built from the pack copy and switched on
- [ ] One end-to-end dry run: scorecard signup lands in the leads list; a test purchase lands in customers
