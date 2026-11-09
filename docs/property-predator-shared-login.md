# Property Predator shared login boundary

Status: implementation and migration prepared; production activation is a
dashboard-controlled Growth HQ web-service setting.

## Outcome

Growth HQ can use the existing Property Predator identity without becoming a
second Google OAuth application and without trusting a browser-supplied email.
The main site verifies the Google-linked account, issues one short-lived
authorization code, and Growth HQ exchanges it over a pinned HTTPS backchannel.
Growth HQ then creates its existing revocable opaque local session.

The native Growth HQ email/password form remains available as break-glass. No
part of this flow enables email, social, WhatsApp, webinar, payment or other
provider effects.

## Fixed contract

- Issuer: `https://propertypredator.com`
- Client id / audience: `growth-hq`
- Authorize page: `https://propertypredator.com/sso.html`
- Token endpoint: `https://propertypredator.com/api/auth/sso/token`
- Callback: `https://hq.propertypredator.com/portal/auth/property-predator/callback`

Authorization uses a one-time code, 256-bit state and PKCE S256. Growth HQ keeps
state/verifier/config hash only inside a ten-minute AES-GCM encrypted,
host-only, HttpOnly, Secure, SameSite=Lax cookie whose path is the exact callback.
State comparison is constant-time and every terminal callback clears the cookie.
Post-login navigation is fixed to `/portal`; there is no browser return URL.

The token request is JSON over the exact HTTPS token endpoint. Client credentials
use HTTP Basic. The JSON body contains only `grant_type`, `client_id`, `code`,
exact `redirect_uri` and `code_verifier`. Growth HQ rejects redirects, non-JSON,
oversized responses, the wrong issuer/audience/subject shape, unverified email,
expired/future assertions and inconsistent affiliate facts.

## Identity and access rules

`app.user_external_identities` stores only:

- immutable issuer + UUID subject;
- linked pre-existing HQ user UUID;
- latest verified asserted email;
- bounded affiliate member/id/code/status;
- nullable referrer affiliate UUID and attachment time;
- link and last-authenticated timestamps.

It stores no Google token, main-site JWT, refresh token, authorization code,
PKCE verifier or client secret. `app.user_sessions.external_identity_id` records
which federated link produced an opaque HQ session so it can later be audited or
revoked independently from password sessions.

Federated sessions expire after 24 hours during the pilot; password sessions
keep their existing lifetime. This bounds the lag if a main account is deleted
or disabled before HQ learns about it. Before broader rollout, add an
authenticated issuer lifecycle webhook or backchannel introspection/revocation
contract that revokes every live `external_identity_id` session promptly.

A first link requires both server-owned settings:

- `PROPERTY_PREDATOR_SSO_BOOTSTRAP_USER_ID` — UUID of the already-created HQ
  founder whose canonical email is `office@propertypredator.com`;
- `PROPERTY_PREDATOR_SSO_BOOTSTRAP_EMAILS` — exact verified main-site allowlist,
  initially `martin.howard1984@gmail.com` after manual confirmation.

The Node boundary passes the bootstrap UUID only when the verified assertion
email is allowlisted. The SQL boundary then requires that user to exist in
pending/active state with an active workspace, organisation and source
membership. It may activate that pending user and retire outstanding setup
tokens, but it never creates a user or membership and never changes canonical
contact email. After first link, the immutable issuer + subject is the authority;
bootstrap email is no longer consulted. Arbitrary affiliates therefore receive
no Growth HQ access.

## Environment settings

All are web-service-only. The worker must receive none.

| Setting | Rule |
|---|---|
| `PROPERTY_PREDATOR_SSO_ENABLED` | Exact `true` or `false`; dashboard-controlled (`sync: false`) so Blueprint syncs preserve the reviewed operator value |
| `PROPERTY_PREDATOR_SSO_ISSUER` | Exact canonical issuer |
| `PROPERTY_PREDATOR_SSO_AUTHORIZE_URL` | Exact issuer `/sso.html` |
| `PROPERTY_PREDATOR_SSO_TOKEN_URL` | Exact issuer `/api/auth/sso/token` |
| `PROPERTY_PREDATOR_SSO_CLIENT_ID` | Exact `growth-hq` |
| `PROPERTY_PREDATOR_SSO_CLIENT_SECRET` | Dedicated backchannel secret; cannot equal `SESSION_SECRET` |
| `PROPERTY_PREDATOR_SSO_REDIRECT_URI` | Exact Growth HQ callback |
| `PROPERTY_PREDATOR_SSO_BOOTSTRAP_USER_ID` | Existing founder UUID; pair with allowlist |
| `PROPERTY_PREDATOR_SSO_BOOTSTRAP_EMAILS` | Canonical comma-separated verified emails; pair with UUID |

An enabled but incomplete/inexact configuration is rejected as a whole: no SSO
client, routes or buttons are composed. The canonical PostgreSQL portal and its
native password break-glass login remain mounted. A disabled configuration also
does not expose the SSO routes/buttons.

## Release proof

Before production activation, require:

1. type-check and complete unit/SQL-contract suite;
2. disposable Neon reset/migration/integration suite including migration 0029;
3. main-site tests proving one-use atomic code consumption, PKCE, verified
   Google link, exact client/callback and no affiliate auto-authorisation;
4. Growth HQ browser tests proving both buttons, password fallback, callback
   clearing on success/error, fixed redirect and opaque local session;
5. exact schema-29 ledger/readiness on every runtime database role;
6. one owned founder seed sign-in followed by logout and returning sign-in;
7. negative proof for an unallowlisted affiliate and a suspended membership;
8. provider effects OFF, delivery OFF and emergency pause ON throughout.
