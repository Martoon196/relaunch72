# Admin MFA rollout

The `/admin` control room stays disabled while `ADMIN_PASSWORD` is empty. No
admin MFA value is required in that state.

Before deploying a service that already has `ADMIN_PASSWORD` configured:

1. Create a unique RFC 4648 base32 setup key of at least 32 characters in a
   password manager or authenticator.
2. Add it to the founder's authenticator as a time-based, six-digit account
   named `Property Predator Growth HQ`.
3. Store that exact key as the Render secret `ADMIN_TOTP_SECRET`.
4. Set the operator-owned Render value `ADMIN_SESSION_EPOCH=1`, deploy, then
   verify password plus authenticator code on `/admin/login`. The Blueprint
   deliberately uses `sync: false`, so later code syncs cannot reset it.

To revoke every issued admin cookie, increment `ADMIN_SESSION_EPOCH` in Render
and deploy. Never reduce or reset that value during a routine rollout.
To disable admin safely, clear `ADMIN_PASSWORD`. If startup reports missing MFA
configuration, either complete the steps above or clear `ADMIN_PASSWORD`; never
weaken the production checks. Do not commit, message or log the password, TOTP
key, session secret or a live authenticator code.
