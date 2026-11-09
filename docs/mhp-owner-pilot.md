# Martin Howard Property: owner pilot setup

This is the logged-in app at `app.martinhowardproperty.co.uk`. The public website remains at `martinhowardproperty.co.uk` on GitHub Pages. DNS configuration alone does not publish the app: the reviewed code, database migrations and MHP activation must also be deployed.

## Martin: connect the app domain

The public nameservers checked on 28 October 2026 are `dns1.registrar-servers.com` and `dns2.registrar-servers.com`; the `app` hostname did not yet exist.

1. Sign into Namecheap. Select **Domain List → Manage** beside `martinhowardproperty.co.uk`, then **Advanced DNS**.
2. In **Host Records**, choose **Add New Record** and save this entry:

| Field | Value |
| --- | --- |
| Type | CNAME Record |
| Host | `app` |
| Value | `property-predator-growth-hq.onrender.com` |
| TTL | Automatic |

Use the hostname without `https://`, a slash or a path. Keep the existing `@`, `www` and mail records. If a record has since been added for exactly `app`, inspect it before replacing it; a CNAME cannot coexist with another record for the same hostname.

3. Open [the existing Growth HQ Render service](https://dashboard.render.com/web/srv-da7fv1gn74is73d58hb0). Choose **Settings → Custom Domains → Add Custom Domain**. Enter `app.martinhowardproperty.co.uk`, save and click **Verify**. Render issues HTTPS automatically after verification. A pending certificate or a not-yet-deployed app is not a completed pilot.

References: [Namecheap host records](https://www.namecheap.com/support/knowledgebase/article.aspx/434/2237/how-do-i-set-up-host-records-for-a-domain/), [Render custom domains](https://render.com/docs/custom-domains).

## Martin: connect sign-in email

Growth HQ owns the account logic and sign-in/password email templates. Brevo can deliver these emails using the sender already prepared for MHP. This does not create a mailbox or replace the member's own SMTP/Gmail/Microsoft connection.

1. In the MHP Brevo account, confirm sender **ID 1** is the intended verified sender. The brief identifies `martin@propinvestuk.co.uk`; verify this in the account rather than assuming the ID still maps to that address. Authenticate the sender's domain using the DNS values Brevo displays if it is not already authenticated. Those values are account-specific and are not guessed here.
2. Open **SMTP & API → API keys → Generate a new API key**. Name it **MHP sign-in**. This integration uses a Brevo API key, not an SMTP password.
3. Open **Environment** in the same Growth HQ Render service. Add these three variables with their exact names:

```text
MHP_TRANSACTIONAL_PROVIDER=brevo
MHP_BREVO_SENDER_ID=1
MHP_BREVO_API_KEY=<paste the key directly into Render>
```

Choose **Save only** while the release is being prepared. Never paste a key in chat or source control. Do not replace the existing Property Predator email variables.

References: [Brevo API keys](https://developers.brevo.com/docs/api-key-authentication), [Brevo senders and domain authentication](https://developers.brevo.com/docs/getting-started-with-senders-and-domains), [Render environment save options](https://render.com/docs/configure-environment-variables).

## Release operator: activate the checked owner pilot

Use the exact-source cutover/recovery package. The compatible bridge must accept the production112 schema and the complete120 schema; final application readiness requires all120. Do not use the old118 recovery after migrations119/120. Keep `/ready`, manual deployment and working Property Predator journeys intact.

After Render verifies the custom hostname and certificate, mark only the MHP organization domain as verified in the canonical database as part of the recorded release procedure. Configure `MHP_ENABLED=true`, `MHP_BILLING_ENABLED=false` and `MHP_INVESTOR_MAIL_DELIVERY_ENABLED=false` for the owner pilot. The app also uses the existing role-specific database and shared session/abuse configuration. These secrets are not duplicated in this guide. Mail configuration readiness proves presence; a successful owner sign-in email is the delivery proof.

Deploy the ratified source, confirm the exact Render commit and both hosts' `/ready`, then test an owner login. Stripe links and paid acquisition stay inactive until the separate MHP Stripe account, prices, webhook and provider sandbox checks are complete. D4 handoffs are recorded but held; templates27–29 and their marketing delivery are not activated by this release.

## Martin: first test after activation

1. Open [MHP sign-in](https://app.martinhowardproperty.co.uk/portal/login), enter **martin.howard1984@gmail.com** and request a sign-in link. Use it within15minutes. You can set a password through the password-reset option. `office@propertypredator.com` is the second authorized owner identity.
2. Open **Your Desk / Investor CRM**. Your first login provisions your own member business. Use the programme view to open your existing test business and change its branding; your owner access requires no payment.
3. Open [Deal Desk](https://app.martinhowardproperty.co.uk/app/desk). Try BRRR, HMO, serviced accommodation, auction maximum bid and residual land. Enter explicit assumptions and cost allowances; no tax engine is included. Save a deal, reopen it and change a figure.
4. Complete **One Lane Verdict**. Open [HQ verdicts](https://app.martinhowardproperty.co.uk/hq/verdicts), publish your test response and return to the member view to read it.
5. Open [HQ](https://app.martinhowardproperty.co.uk/hq) to grant a separate test email **The Deal Desk**. A non-owner test member has three files in total and a30day write window; archiving never frees a slot. Your owner account has full access, so it will not demonstrate those restrictions. Manual grants do not create a paid purchase, a£47 credit, D4 buyer emails or revenue.

The five calculators remain available after the paid Desk's30day write period, alongside saved read-only records. Course access unlocks writes and additional files. A genuine paid Deal Desk purchase creates a£47 course credit; starting its checkout before the30day deadline permits30minutes to finish plus up to one minute for setup, with the exact checkout deadline shown. Financial behaviour needs the separate Stripe sandbox proof before paid activation.
