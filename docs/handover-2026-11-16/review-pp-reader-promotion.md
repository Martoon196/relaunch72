# Independent review: reader promotion change 438c5a9..862e690 (live on propertypredator.com)

## Verdict

**Leave live, do not roll back, and fix one thing now. Until that fix ships, pause the reader offer link on the partner page.**

- **Nobody can complete the reader offer on the live site today.** Every signed-in path ends at "We couldn't load your account. Please try again." No code check and no checkout request is ever sent.
- **It fails closed on money.** Nobody is charged full price, no code use is consumed, no checkout is created.
- **Rolling back does not help.** 438c5a9 has the same root cause and shows a silent dead button instead of an error message.
- **The root cause is older than this change and wider than the promotion.** The page reads the account id from `_currentUser.id`, but the server's token carries the id as `sub`. Every checkout started from `/app` (pricing buttons and `?plan=` links) is silently dead for real sessions. The guard arrived in commit 05468e5e on 27 Oct 2026.
- **With a one-line identity fix applied locally, the new flow works end to end** and the money semantics hold.

Confidence: I ran this against the real backend at 862e690 issuing real tokens, and the live static files are byte-identical to the commit. I did not sign in on production, so the live token shape is inferred from the deployed commit's backend code. The maintainer can confirm in a minute: sign in on the live site, open `/app?pricing=1`, press a plan button, and see that nothing happens.

## Findings

### MUST-FIX now

**M1. The page never learns the account id, so the promotion flow and all `/app` checkout are dead.**
- **Cause (read):**
  - `backend/services/auth_service.py:563-570` issues `{sub, email, tier, amr, aep, exp}`; there is no `id`.
  - `frontend/propertypredator.html:580-585` (`_decodeJwtPayload`) returns that payload unchanged, and lines 634 and 889 store it as `_currentUser`.
  - Lines 604, 632, 1120, 1137-1138, 1201-1202 read `_currentUser.id`, which is always undefined.
- **Ran, real tokens, 862e690** (`s01_new_visitor.js`, `s07_stale_and_repro.js B` and `C`):
  - New visitor at 390 and 1280: register returns 201, the box reopens with "We couldn't load your account. Please try again." Three more presses give the same message.
  - Requests after register: none to `/api/promo/redeem`, none to `create-checkout-session`.
  - Same result for the sign-in path and for an already-signed-in visitor.
  - A Hunter member sees "View my account", presses, and gets the same error.
- **Ran, real tokens, both commits** (`s02_plain_plan.js`): plain `?plan=pro_buyer` and `?plan=pro_investor`, logged out then register, and logged in: zero checkout requests, no dialog. Pricing "Choose £39/mo" was checked on the old commit only (the new-commit run stopped at the local signup cap): one config GET and nothing else.
- **History (read-only GitHub lookup):** `_currentUser.id` appears 0 times at 5729fba1 and 6 times at 05468e5e ("Add verified plan-scoped promotion signup links", 27 Oct 2026). The token already used `sub` at 99986e42.
- **Why 960 frontend tests pass:** the fixtures hand the page `_currentUser:{id:'account-a'}` and `_decodeJwtPayload:()=>({id:'account-a',...})`, a shape the server never issues.
- **Smallest fix:** in `_decodeJwtPayload`, set `id` from `sub` when `id` is missing (dashboard.html:264-267 already reads `.sub`). Add one test that feeds a server-shaped token through `_onAuthSuccess`, `applyPublicPromotion` and `startUpgrade`.
- **Proof the fix is sufficient (ran, `s03_shim_new_visitor.js`):** with that one line patched in the served page, register → redeem 200 → `create-checkout-session?ui=embedded&plan=pro_buyer&promotion_code=READ75` 200. The stubbed Stripe request carried:
  - `mode: subscription`, `unit_amount: 3900`, `interval: month`
  - `discounts: [{coupon: "PPP75ONCE"}]` (75%, duration once)
  - `metadata.plan: pro_buyer`, `metadata.promo_code: READ75`, and the same in `subscription_data.metadata`

### SHOULD-FIX soon (all become reachable the moment M1 is fixed)

**S1. Three server refusals now show a generic, misleading message and loop.** `startUpgrade` replaces the server's sentence with "We couldn't start secure payment with this discount. Check your code again or choose another plan." (propertypredator.html:1232). The old page showed the server's sentence. Ran with the fix applied (`s08_conflicts.js`, `s04_states.js E`):
- A reader who earlier opened a full-price Hunter checkout: 409 "Your existing checkout uses a different discount…". The second press gives the same result; one Stripe session exists, with no discount. This is the most likely real case.
- A reader who earlier opened an Apex checkout: 409 "another checkout is already active for this account".
- A Deal Report credit holder: 409 "Your unused Deal Report credit replaces other checkout discounts… Contact support".
- A Hunter subscriber using an Apex code: 409 "This account already has an active subscription. Use Manage billing…".
- In each case the code use is consumed first. Fix: map these 409s to specific plain messages.

**S2. The visitor's own plan choice is overridden by the pending offer.**
- Ran (`s05_states.js L`): an anonymous visitor closes the box, picks "Choose £99/mo" (Apex), registers. `_onAuthSuccess` (lines 867-872, 904) deletes `pp_pending_plan`, verifies READ75 and opens "Upgrade to Hunter" at 75% off.
- Ran (`s07_stale_and_repro.js A`): after the reader link, a later `/app?plan=pro_investor` or `/app?plan=report` in the same tab shows the Hunter reader box; the deep link's plan is ignored (line 1325 runs before the plan handling). The old page showed a mismatch message.
- Nobody is overcharged, and the checkout title says Hunter. Fix: resume the promotion after auth only when no different plan was chosen; let an explicit different `plan` win.

**S3. Wording that is not true at the moment it is shown.**
- Anonymous arrival says "Your reader discount is saved." for any well-formed code, including unknown, expired and exhausted ones, before any server check (line 1106). Ran with `NOPE123`, `OLD75`, `ONEUSE`. The old text was "Your code is ready to check. No discount has been applied yet."
- The title "Your reader discount" shows for every promotion link, including the ones admin.html:1025 generates for other campaigns.
- A signed-in visitor who picks Apex or Deal Report while the Hunter offer is pending is told "This promotion link is not valid. Choose another plan below." The link is valid; the old text said it did not match the selected plan.
- In that state the primary button is disabled but still fully teal, so it looks pressable and gives no response (screenshot `shots/s05-L-apex-mismatch.png`).

**S4. With localStorage unavailable, the flow cannot be completed.** Ran (`s05_states.js I2`, `I3`, `I4`):
- The primary button loops on "We couldn't confirm your code or open secure payment. Please try again." because `rehydrateSession` (639-649) rejects and line 1122 awaits it on every press.
- Via "I already have an account" → Create account: register returns 201, then `setTokens` (561-565) throws and the form says "Account created — reload the page to continue." Reload is anonymous again.
- Blocked sessionStorage alone works, as the author claims.
- Fix: try/catch around the storage calls in `setTokens`, `clearTokens` and `rehydrateSession`, and tolerate a rejected `_promotionSessionPromise`.

**S5. With sessionStorage blocked, a successful payment is reported as unconfirmed.** Ran (`s08_conflicts.js` case 4, real token, confirm endpoint stubbed to `applied:true`): the visitor gets the alert "We could not confirm the payment yet. Reload this page to retry the same checkout safely." and stays on the return URL. Cause: unguarded `sessionStorage.setItem` at line 1279. This is older code, but it contradicts the blocked-storage claim.

**S6. Keyboard focus never enters the box when it opens.** Ran (`s06_a11y.js`, `s06b_focus.js`, `s06c_focus.js`):
- After every open from closed, the active element is BODY.
- Cause: the new `#promotion-overlay:not(.open){visibility:hidden}` rule plus `.pc-btn{transition:all .15s}` (line 225) leaves the button hidden at the instant `focus()` runs. With the button's transition disabled, focus lands correctly.
- While the cookie bar is showing (every first-time visitor), Tab walks the page behind the box and Escape does nothing, because the document handler is skipped when `#pp-consent` exists (line 1031).
- Targets: close button 30×30, "I already have an account" 44 px high, primary 49 px.
- Present and working: role, aria-modal, label, description, polite live region, 3 px focus ring, and the Tab loop once focus is inside.

**S7. On a 390×844 phone the cookie bar covers "Create Account".** Ran (`shots/s01-390-auth-with-consent.png`): the bar spans y 622-832, the button sits at 686-732, and the form does not scroll. A first-time reader must answer the cookie bar before they can submit. Older layout, but on this journey.

**S8. Tests mirror the implementation in two places that matter.**
- The `{id}` fixtures (see M1).
- "used, expired and wrong-plan responses" feeds sentences the server never sends. The server returns only "That code isn't valid." and "You've already used that code." (services/promo.py:207, 252), so three branches of `PPPromotion.reason` are unreachable.

### NOTES

- **Code uses are consumed at verification, not payment.** `promo.redeem` increments `used_count` before any checkout. Verification is now automatic after sign-up, so every account created through the link uses one, including when checkout is closed or the payment script is blocked (ran). A repeat by the same account does not count twice. Check READ75's `max_uses` in production is sized for sign-ups.
- **Once verified, the discount follows the account.** payments.py:566 attaches it to any later Hunter-monthly checkout even without the code. "Choose another plan without this code" then Hunter is still discounted if verification already happened; if not, it is full price with no code (ran). Server behaviour, unchanged.
- **Signup cap** defaults to 5 per hour and 15 per day per IP (signup_guard.py:26-27). A campaign burst from a shared IP shows "A lot of accounts have been created from your connection today…".
- **After payment** the confirmation is a native alert saying "You're Predator Pro now — everything's unlocked." for a Hunter purchase. Older code.
- **`?pricing=1` with a promotion** opens both boxes; a signed-in visitor sees the stale label "Create my free account".
- **Closing the box mid-check** leaves "Checking your code…" as the stored message until it is next opened.

## Area 1: safety semantics

All "held" results below are with the identity fix applied locally; on live today none of these paths is reachable.

| Question | Result | Evidence |
|---|---|---|
| Checkout without the verified promotion while expecting the discount | Held | Ran: bad receipts (wrong code, wrong plan, wrong kind, non-JSON), 401, 429, 500, 502, network error → 0 checkout calls. Server 409s refuse rather than fall back to full price. |
| Promotion applied to a different plan than verified | Held for the discount | Ran: `pro_buyer_annual` + READ75 → rejected. But S2: the visitor's own plan pick is replaced by the offer's plan. |
| Promotion applied to a different account | Held | Read: `_apiFetch(…, account)` guards, `ours()` checks, server binds the redemption to the token's account. The file's account-switch unit tests pass. Not run in a browser. |
| Code use consumed with no checkout following | Broken by design | Ran: close mid-check, payment script blocked, and every S1 conflict each consume one use. Per account, not repeatable. |
| Two checkouts or two redemptions | Held | Ran: duplicate presses during a slow check → 1 redeem, 1 checkout, 1 Stripe session. Reload then press → `already_applied`, same session retrieved, 1 create in total. Press during slow session restore → 1 each. |
| "Applied" wording before the server says so | Partly broken | "Your reader discount is saved" before any check (S3). The "% off" line and "Your discount is verified" appear only after a verified receipt (ran). |
| Bypass of the receipt check or the checkout's expected-promotion check | Held | Ran and read: `promotion_code=READ75` is always sent after verification; the server requires a matching unconsumed redemption (payments.py:459-467, 626). |
| Stale stored promotion attaching to a later purchase of a different plan | Held for attachment; hijacks deep links | Ran: never sent with another plan. A later `?plan=` link in the same tab is swallowed (S2). |
| Applied after "Choose another plan without this code" | Held if never verified; discount still applies to Hunter if already verified | Ran. Abandon also removes `promo` and `plan` from the URL and storage. |
| Malicious link auto-starting a checkout for a signed-in user | Held | Ran: signed-in arrival, 3 s, no press → only the session refresh call. Malformed, duplicate-parameter and script-injection links show a disabled box. A signed-out visitor who then signs in does auto-verify and open checkout; card entry is still required. |

## Area 2: visitor states

"Live today" is the real token shape. "After fix" is with the one-line identity fix applied locally. Run at 390 px; the new-visitor and signed-in rows also at 1280 px with the same result.

| State | Live today | After fix |
|---|---|---|
| New visitor → register | "We couldn't load your account", no requests | Redeem 200, discounted Hunter checkout opens |
| Existing user via "I already have an account" | Same error | Wrong password shows "Invalid email or password"; then checkout opens |
| Stale refresh token in storage | Anonymous box; press opens register | Same |
| Press during slow session restore | Not run with real tokens | Button shows "Checking your code…", then one redeem, one checkout |
| Token present, account object missing | Not reachable normally | `/api/auth/me` → redeem → checkout |
| Signed-in free account | Error on press | No auto-apply; press → checkout |
| Already Hunter or Apex | "View my account" → error | Press goes to the dashboard |
| Code already verified, not yet paid | n/a | Recovered, same checkout session |
| Code already used and paid | n/a | "You've already used this code." |
| Exhausted, expired, inactive, other plan, comp code, unknown | n/a | All: "This code can't be used. It may be invalid, expired or for another plan." No checkout, tier unchanged |
| Admin email | Register refused: "This identity requires verified provider sign-in" | Same |
| sessionStorage blocked | Error after register | Works; survives reload via the URL. Payment return shows a false alert (S5) |
| localStorage blocked | Loop and dead end (S4) | Same (S4) |
| Redeem slow or failing | n/a | Visible message each time, 0 checkouts |
| Payment script blocked | n/a | "We couldn't load secure payment. Please reload and try again." |
| Register fails then succeeds | Errors shown in the form; then the M1 error | Weak password and "That email is already registered" shown; then checkout |
| Email verification step | None required for purchase (read) | Same |
| Closes box, picks a plan | Dead | Anonymous: gets Hunter instead of the pick (S2). Signed in: "not valid" box with a dead-looking button (S3) |
| `?promo=` with no plan, unknown plan, malformed code, two `promo` or two `plan` | Disabled box: "This promotion link is not valid. Choose another plan below." | Same |
| Lower-case code | Upper-cased and accepted | Works |

## Area 3: the in-app-browser case

Ran with real tokens (`s07b_old_dead_button.js`, `s07_stale_and_repro.js B`; screenshots `shots/s07*`).

- **Old, storage working:** after register the "Review your promotion" box opens; three presses of "Apply code and continue" change nothing and send no request. That is the original dead button.
- **Old, sessionStorage blocked and a stale token:** nothing at all appears after register, because the blocked storage threw before the offer was captured.
- **New, same state:** the box opens on arrival; after register it shows "We couldn't load your account. Please try again." on every press. It is visible now, but still a dead end, for the same cause (M1).

## Area 4: what the live site is serving

Six anonymous GETs. All three files are byte-identical to 862e690.

| File | sha256 |
|---|---|
| `/app` and `/propertypredator.html` | `331b20aee2f5269bc097d64f08f0e1bd69d19702418e7b5fdafa3299b0e23eb2` |
| `/pp-promotion.js?v=reader-20261117` | `f0a13f2260fae533b5f4ab1d21788b1b003ccc2031a1527d9faf4f56760b1c9c` |
| `/sw.js` | `e42ba4790dad26a16dc2d546afaab24fe09da0287fdde72ce7b9ad33c1951216` |

- The live page references `pp-promotion.js?v=reader-20261117` (the full string, not `?v=reader`).
- The helper returns the same new content with `?v=1` and with no query.
- Headers: the page and `sw.js` are `no-cache, must-revalidate`; the helper is `public, max-age=300`; Cloudflare reports `DYNAMIC` for all.
- Service worker (read): pages and same-origin scripts are network-first, scripts fetched with `cache: no-cache`, cache matched by full URL. It cannot serve an old page or helper while online. Its version was not bumped, and did not need to be.
- Old page with new helper (ran): works exactly as the old page.
- New page with old helper (ran, forced locally): redeem succeeds, then `PPPromotion.description is not a function` and the box sticks on "Checking your code…". This is not reachable in practice, because the new page asks for a URL no browser had cached.

## Area 5: honesty and conventions

- **Escaping:** every dynamic value in the box is set with `textContent`. Server error text is never shown directly. The code is limited to `A-Z0-9-` by the helper; an injected `<img onerror>` value produced the disabled box and no dialog (ran).
- **Dialogs:** no `alert()` or `confirm()` fired in any promotion path (ran). The payment-return alerts are older code.
- **Brand-safe:** messages say "secure payment" only.
- **Price statement:** "You'll see the exact price and renewal on the secure payment page before you pay. Discounts can't be combined." matches the server.
- **Analytics:** the diff adds no events. `checkout_started {plan}` and `pricing_viewed {surface}` are in `funnel_events.py:31-32` and carry no code or personal data (read).

## Area 6: tests

- `frontend/tests/promotion-link.test.mjs`: 29 passed, 0 failed.
- `checkout-lifecycle.test.js` and `login-continuation.test.js`: 11 passed.
- Backend, 8 files (`test_promotion_offer`, `test_commerce_safety`, `test_checkout_clarity`, `test_checkout_active_reservation`, `test_checkout_credit_claims`, `test_checkout_recovery`, `test_payment_application_atomicity`, `test_payments_webhook`): 155 passed.
- **Existing assertions loosened or removed: none.** The only edits to old lines are the harness (`module(s)` and `surface()` gained `loggedIn`, `user` and more stubs).
- 12 tests were added. They exercise real behaviour (slow restore, duplicate press, close mid-check, 401, account change, blocked storage getter) except for the two weaknesses in S8.

## Area 7: scope

- The diff touches only three frontend files; the server is unchanged, as claimed.
- Outside the box itself, the page diff edits `submitRegister`, `_onAuthSuccess`, the document keydown handler, `startUpgrade` notices, `handleUpgradeReturn` ordering and the load handler.
- With the identity fix applied to both commits (`s09_scope_shim.js`), plain `?plan=pro_buyer` and `?plan=pro_investor` (logged out then register, and logged in), `?pricing=1` and `?upgrade=cancelled` behave identically on old and new: correct plan, full price, no code.
- Without the fix both commits are equally dead (M1).

## What I could not verify

- The production token shape and production data: READ75's `max_uses`, expiry and plan scope, and whether any `/app` checkout has succeeded since 27 Oct. No sign-in was made on production.
- Real in-app browsers. Storage restrictions were simulated in headless Chromium; back-button and view-closing behaviour were not exercised.
- Google sign-in (not configured locally) and the real Stripe embedded form. Stripe's page script was replaced by a local stub, so "the price shown before paying" was checked only through the request the backend would send.
- Sign-out and sign-in as someone else mid-flow in a browser; covered by reading and the file's unit tests only.
- The full backend and frontend suites were not run, as instructed.

## How this was run

- **Stripe:** no key in the environment. A fake value was set on the module after import, the SDK base pointed at a closed local port, and every SDK call checkout uses was replaced by a recorder. No request to Stripe's API was made.
- **One isolation gap:** in one early scenario a page reload ran with the page's service worker active, before I blocked service workers in all test contexts. Playwright routing does not cover service-worker fetches, so on that one reload public script requests (Stripe's page script, Google fonts and sign-in script) may have left the machine. No credentials and nothing to propertypredator.com.
- **GitHub:** I used the `gh` CLI read-only to date the bug from commit history.
- **Local only:** I sent `x-forwarded-for` headers to avoid the local signup cap, and edited rows in my own scratch databases.
- **Repo:** left as found, on `master` at 438c5a9, clean; my two worktrees are removed. To rerun, recreate them with `git worktree add --detach <dir>/new 862e690` and `<dir>/old 438c5a9`, then start `serve.py` on 8811 and 8812, then run `seed.py` and `migrate_local.py` against each scratch database. Until both have run, every redeem returns 500 ("commerce safety migration is not installed") and the seeded codes do not exist.

Everything is in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-pp-promo/`:
- Scripts: `lib.js`, `serve.py`, `seed.py`, `migrate_local.py`, `s01_new_visitor.js` through `s09_scope_shim.js`
- Screenshots: `shots/`
- Live copies and headers: `live/`
- Stub logs and scratch databases: `run/`
