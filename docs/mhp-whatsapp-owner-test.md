# MHP WhatsApp owner test (009C source build)

Status: **source-complete candidate, not ratified, not integrated, not live.**
Branch `claude/009c-mhp-whatsapp`, stacked on the 009B SMS candidate. Migration
`0132_mhp_owned_whatsapp_pilot.sql`.

## What it does

Owner page `/hq/marketing/whatsapp` (behind `MHP_WHATSAPP_PILOT_ENABLED=true`):

1. **Connect the MHP sender.** The owner pastes a sealed connection text produced
   by `npm run --workspace orchestrator mhp:whatsapp:seal` where the WhatsApp
   worker's credential key lives. The Meta access token goes into that tool on
   stdin and never reaches the web app or this page. One owner action creates the
   Meta provider connection, the sender endpoint, the live inbox and the
   unchanged 0053 binding.
2. **Pin the approved template.** The owner picks the saved WhatsApp draft
   (`mhp_webinar_20261104_reminder_v1`, en_GB, no parameters), enters the Meta
   template ID and approval reference, and confirms Meta shows it Approved. The
   exact draft is approved in Growth HQ if needed and pinned through the 0053
   template record.
3. **One owned test.** One template message to the owner's own number. Possession
   is the owner's existing SMS verification receipt on that number; the consent is
   the owner's own one-test permission. Enqueued through the unchanged 0053
   enqueue, with its caps of 1 a day and 3 a month.

## Two latent 0053 defects found and repaired

Neither path had ever run against PostgreSQL. Both are exact repairs with
compatibility tests proving nothing else changed.

1. **Templates could never be recorded.** 0053 bounds the template name with
   `{0,511}`; PostgreSQL caps regex repetition at 255, so the table CHECK and
   `record_whatsapp_live_template` raise `2201B` whenever they run. Repaired to
   the same meaning: the same character class plus `char_length <= 512`.
2. **Jobs could never be claimed.** `claim_whatsapp_live_job` has three references
   that collide with its own OUT columns (`job_id`, `binding_id`) and raise
   `42702`. This is the same defect 0130 R8 fixed for SMS. Repaired with exact
   constraint names and a table alias.

These affect Property Predator's WhatsApp rail too, which is still dark.

## Hard limits

- **No public WhatsApp.** The unchanged 0055 inbound projection never records a
  STOP as a suppression. Until that rail changes, nobody but the owner can be
  messaged; the page says so.
- **Caps:** 1 message a day and 3 a month per binding (0053).
- **Inbound** is projected only from a number with a verified WhatsApp point,
  which the owned test creates for the owner's own number.
- Binding rotation is not offered here; a second connect is refused.

## What only the founder can do (Meta)

These are the steps we walk through together:

1. **Template approval.** WhatsApp Manager must show
   `mhp_webinar_20261104_reminder_v1` (ID 1441099094827445) as Approved.
2. **Number registration.** The MHP Cloud API phone (1412753418582729) must leave
   Pending: complete display-name approval and registration in WhatsApp Manager.
3. **System user access.** The existing system user (61596303590446) is
   Property-Predator-only. Grant it the MHP WABA (1874194210608511) with Manage
   permission, or create an MHP system user, in Business Settings. This is a
   security change made by you in the browser.
4. **Token.** Generate a system user token with `whatsapp_business_messaging`
   and `whatsapp_business_management` for the MHP app (1451249570430398). Paste
   it only into the seal tool's stdin, never into chat or a file.
5. **Webhook.** In the Meta app, subscribe the MHP WABA's `messages` field to the
   MHP webhook service URL `/webhooks/meta/whatsapp` with the verify token set on
   that service.

## Render (two Starter services, inside the approved hosting ceiling)

| Service | Start command | Key settings |
|---|---|---|
| MHP WhatsApp worker | `npm run --workspace orchestrator serve:meta-whatsapp-live-worker` | `DATABASE_WHATSAPP_LIVE_WORKER_URL`, `PROPERTY_PREDATOR_WHATSAPP_LIVE_WORKSPACE_ID=2789228d-55a6-4688-b1e8-2f70abca990b`, `PROPERTY_PREDATOR_WHATSAPP_LIVE_CONNECTION_ID` (from the sealed text), credential key and version, mode `disabled` until the founder's test |
| MHP WhatsApp webhook | `npm run --workspace orchestrator serve:meta-whatsapp-live-webhook` | `DATABASE_WHATSAPP_LIVE_WEBHOOK_URL`, the same workspace and connection, `PROPERTY_PREDATOR_WHATSAPP_LIVE_BINDING_ID`, Meta app/WABA/phone ids, app secret, verify token |

The web service needs `DATABASE_WHATSAPP_LIVE_COMMAND_URL` and
`MHP_WHATSAPP_PILOT_ENABLED=true`. Both worker and webhook stay dark until the
founder approves the one owner test.
