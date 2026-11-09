# Payments status — private test sandbox only

Relaunch72 is wired to exercise the funnel with Stripe **test mode**. It is not
ready for real money. A live or unknown Stripe key enters `LIVE LOCKED` mode and
cannot create checkout.

## Supported test flow

```text
checkout.html → backend /api/checkout → Stripe test Checkout
              → signed webhook records the paid test order
              → intake submits the returned Session
              → paid entitlement is claimed once → mock build
```

The public Render test service requires a private 24+ character
`SANDBOX_ACCESS_TOKEN`. The founder enters it in the checkout prompt; the browser
keeps it in `sessionStorage` and sends it to checkout and intake as a header. Never
put the code in this repository or frontend configuration.

The deployed test service forces mock builds and caps concurrency, so a public
test card cannot spend Anthropic credits. Public Brevo capture and recurring plan
checkout remain disabled.

Use [the Render sandbox guide](../docs/deploy-render.md) for setup and readiness
checks.

## Unsupported legacy path: Stripe Payment Links

Do not paste standalone Payment Links into the site. They do not create the
server-side checkout provenance and verified paid-order state required by
`/api/intake`; installment/subscription links also do not represent a one-off Core
entitlement. The frontend intentionally ignores the old Payment Link option.

## Live-money prerequisites

Going live is not a key swap. Before the lock can be reviewed, the product needs
the PostgreSQL commercial ledger, server-created checkout intents, exact price and
amount validation, transactional webhook/idempotency handling, durable job/outbox
workers, fulfilment tests, monitoring/backups and an explicit founder go-live
decision. See `docs/codex-handoff/15-POSTGRES-CRM-FOUNDATION.md`.
