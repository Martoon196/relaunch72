# Marketing funnel pack (from the Chat-skills ecosystem pack)

Source copy for the Relaunch72 funnel, **all in USD ($)** — matches the live
pages and the Stripe catalog (autopsy $97, Core $997, +$147 bump, Pro $2,497;
autopsy credit → $900). Load-ready for the ESP.

- `01-offer-ecosystem.md` — funnel strategy + ascension architecture
- `02-copy-pack.md` — scorecard result page, 5 nurture emails, 5 onboarding emails, the $97 autopsy sales page
- `04-autopsy-to-core-upgrade.md` — the $97→$997 upgrade page

Built live: scorecard (`/scorecard/`), autopsy sales page (`/autopsy/`), upgrade page (`/upgrade/`).
Wired: Postmark (transactional delivery) + Brevo (marketing sync) — see `docs/email-setup.md`.
Pending (founder ESP setup): load the 10 sequences as Brevo automations on the two lists.
