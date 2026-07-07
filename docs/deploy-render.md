# Deploying the payments API to Render

The static funnel (landing, scorecard, autopsy, checkout, intake) is already live on
GitHub Pages at **relaunch72.com**. That's just HTML — it can't take a card. This guide
stands up the **payments API** (`orchestrator/src/server`) on Render so checkout creates
a real Stripe Checkout Session and auto-kicks the build on payment.

Everything below is **TEST MODE** (hard rule #2). No real money moves until you swap in
`sk_live_…` keys — see the last section.

Boundaries: the code + blueprint are done. The steps here are the dashboard/account
actions only you can do (Render account, Stripe account, DNS). None of them are code.

---

## What you're building

```
 relaunch72.com                    relaunch72-payments.onrender.com          Stripe
 (GitHub Pages, static)            (Render, this API)
 ───────────────────               ────────────────────────────             ──────
 checkout.html  ── POST /api/checkout ─────────────────────────►  create Checkout Session
                ◄──────────── { url } ──────────────────────────
        │  redirect to Stripe-hosted payment page ───────────────────────►  card entry
        ▼
 intake/ (after pay) ── POST /api/intake ──►  S0 gate ─► kick pipeline (S1–S10)
                                    ▲
 Stripe ── POST /api/stripe/webhook ┘  (checkout.session.completed → record order)
```

`PUBLIC_BASE_URL` is the **site** (`https://relaunch72.com`) — that's where Stripe sends
the customer back after payment, *not* the API's own URL.

---

## Step 1 — Create the service on Render

1. Render dashboard → **New +** → **Blueprint**.
2. Connect the GitHub repo `Martoon196/relaunch72`.
3. When it asks for a branch, pick **`claude/relaunch72-architecture-1fi7qd`** (that's where
   the code lives).
4. Render reads `render.yaml` and proposes a web service called **relaunch72-payments**.
   Approve it. It builds from the repo root (`npm install`) and starts with `npm run serve`.

Plan: the blueprint defaults to **free**. Free sleeps after 15 min idle — fine for
poking at test payments, but a build kicked while it's asleep can be interrupted, and
data resets on redeploy. For real orders, switch the service to **Starter** and add a
persistent disk (the commented block at the bottom of `render.yaml`).

The first deploy comes up **green before you've added any secrets** — the service starts
in "UNCONFIGURED" mode, `/health` returns `{"configured":false}`, and checkout returns a
polite 503 until step 3. That's expected: it deploys first, you add the key after.

## Step 2 — Paste the two keys into Render

Render service → **Environment** → **Add Environment Variable** for each:

| Key | Value | Where to get it |
|---|---|---|
| `STRIPE_SECRET_KEY` | your `sk_test_…` key | Stripe → flip **Test mode** on → Developers → API keys → reveal Secret key |
| `ANTHROPIC_API_KEY` | your Anthropic key | console.anthropic.com → API keys |

`PUBLIC_BASE_URL` (=`https://relaunch72.com`) and `NODE_VERSION` are already set by the
blueprint. **You do not set any price IDs** — the four prices auto-create from your key on
first boot (idempotent; safe on every restart). Save → Render redeploys.

Check **Logs** for:
```
Relaunch72 payments server on :10000 — TEST mode
  created autopsy → price_…  ($97.00)
  … (four lines)
Catalog ready — 4 created, 0 reused.
```
Then hit `https://<your-service>.onrender.com/health` → `{"ok":true,"mode":"test","configured":true}`.

(Prefer to pin exact prices instead? Set `STRIPE_PRICE_AUTOPSY/CORE/CORE_BUMP/PRO` — if any
is set, auto-provision steps aside and uses yours.)

## Step 4 — Register the Stripe webhook

1. Stripe (TEST mode) → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://<your-service>.onrender.com/api/stripe/webhook`
3. Events: `checkout.session.completed`.
4. Copy the **Signing secret** (`whsec_…`) → paste as `STRIPE_WEBHOOK_SECRET` in Render → redeploy.

## Step 5 — Point the site at the API

Edit `site/checkout-config.js`, set `apiBase` to your Render URL:

```js
apiBase: 'https://relaunch72-payments.onrender.com',
```

Commit + push → GitHub Pages redeploys the site. Checkout now POSTs to the live API.

## Step 6 — Test the whole loop

On relaunch72.com, go through checkout for any tier and pay with a Stripe **test card**:

```
4242 4242 4242 4242   ·   any future expiry   ·   any CVC   ·   any postcode
```

You should: land on the intake with `?session=cs_test_…`, see the order recorded (Render
logs / `data/orders.jsonl`), and — on a complete intake — see the pipeline kick.

---

## Going live (later — not now)

When you're ready to take real money (hard rule #2 + #3 — this is the "go live" switch):

1. **Rotate** the test keys you pasted in chat, then create fresh **live** keys.
2. Re-run `npm run stripe:setup` against the **live** key to make live prices.
3. Swap Render's env to the `sk_live_…` key + live price IDs + a **live** webhook secret.
4. The server logs `LIVE ⚠️` instead of `TEST` — that's your confirmation.
5. Upgrade to a paid plan + disk so orders persist.

Until every one of those is done, it stays test mode and no card is ever really charged.
