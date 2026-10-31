# MHP follow-up sequences

GHQ-FOLLOWUP-006A and006D1 implement the native MHP sequence builder at `/hq/marketing/sequences`, reached through the main Growth HQ MHP workspace. Release status and production verification belong to Root's release receipt; this source guide alone does not assert deployment.

## Owner workflow

1. Open the MHP marketing workspace. Open the email library, write each email, send an owner test and publish the exact wording. The sequence references those saved versions; it does not duplicate the email bodies.
2. Open **Sequence builder → Create a sequence**. Add emails and waits. Drag a step or use **Move up / Move down**; remove a step when needed. Use the email library link to write additional messages.
3. Preview the timeline. A wait before the first message starts at enrolment. Every later wait starts when the previous message is accepted by the email provider. Acceptance is not proof of inbox delivery; a failed or unknown attempt never advances the run.
4. **Save draft**, then **Publish this version**. These actions enrol nobody and send nothing. **Start remaining eligible sign-ups** explicitly starts up to500 current consented webinar registrations; the result reports remaining batches and blocked open runs. For automatic future entry, choose **Future opted-in webinar sign-ups**, publish that exact version, then separately **Enable future sign-ups** with an explicit UTC stop time.
5. Review each person's progress. Pause or stop one person, or pause/resume/cancel the sequence's open runs. An already verified handoff may still finish. Resume rechecks current permission, exact approval and brand details.

Unsubscribe and an audited manual Stop are executable stop controls. Reply, booking and purchase detection are shown as unconnected until their real event sources are connected; selecting an unavailable stop rule prevents Start. SMS/WhatsApp steps may be planned but cannot activate until the actual MHP sender, channel-specific permission and template connection is available. PP sequence sending and channel bridges remain subsequent integrations.

## Future webinar entry

The rule consumes actual new accepted MHP webinar captures for the trusted server-configured campaign, with their exact signup IDs and recorded consent. It does not infer campaign or permission from a label, link, CRM import or browser-supplied sequence ID. Historical and old-producer registrations remain manual. Empty old reminder schedules still preserve a genuine new capture's campaign identity.

Enabling starts from a future-only watermark. Re-enabling closes the previous activation and starts again from now; pending older events are not backfilled. Turning a rule off or reaching its stop time prevents new enrolments without recalling messages or stopping already accepted runs. Use separate person/run controls for those. A newer sequence draft holds its old entry rule and runs; no silent version retargeting occurs.

The rule card shows current status, expiry, last processed signup time, last check and enrolled/skipped/blocked counts. Processing uses at most100 events and5 fairly ordered rules per sweep; skipped and blocked outcomes advance their own exact cursor. A prospect cannot enter the same immutable sequence version twice through manual entry, repeated registrations or worker retries. Off mode pauses both entry and delivery; test mode can enrol metadata while actual transport remains restricted to configured test recipients.

## Edits, restarts and uncertain attempts

Saving a new sequence version holds old-version unsent runs. They retain their original version and history; they never silently switch to the new wording or schedule. A stale version cannot resume. Cancel its open run before explicitly starting the new published version. A fresh start begins with the first step and can repeat messages already accepted under an earlier version. There is no automatic completed-prefix migration.

A newer draft of a selected email inherits the existing email editor's hold rules. Publish the current wording and explicitly choose a new sequence version/start as needed; existing queue bytes are never substituted silently.

If a provider response or settlement response is lost after proof issuance, the run is held as **outcome unknown**. Check actual provider/inbox evidence first. An explicit retry acknowledges that exact proof/attempt and may send the message twice. The old proof remains; a later different uncertain attempt requires another decision. Retrying never clears an active lease early or extends an expired retry window.

The current screen shows up to50 latest sequences,50 saved email choices and100 latest runs, with total run count visible. The configured MHP off/test/live mode remains authoritative. Sequence publication/deployment does not enable another channel or enrol an audience.

## Implementation and recovery

Canonical definitions use the existing0021 company content version/approval path with kind `other`; message copy uses the existing005A owner email versions. Migration0127 adds private run state and run/step references to the existing MHP queue. Migration0128 adds canonicalv2 entry intent, exact capture linkage, activation/cursor metadata and immutable event-to-run receipts. Existingv1 definitions stay manual and byte-compatible. The same Postmark Broadcast sender and in-process interval execute the current message only. Old pollers and standalone email commands exclude sequence-owned deliveries; old127 sequence claim/prepare also exclude automatic-entry runs.

For128 recovery, invoke the restricted hold-entry capability first, then hold all sequence runs if needed. If both standalone and sequence owner mail need holding, the existing global owner hold is intentionally shared and may then be invoked. Enumerate already verified leases, account for their120-second duration plus the existing10-second Postmark timeout, and do not clear leases. Restore only the exact127/128-compatible artifact carrying thev2 reader and recovery guards. Keep the additive schema, receipts and exclusions; never downmigrate into av1-only reader.

The recovery artifact allowsv2 reading/status/pause/stop/cancel only, refusingv2 Save/Publish/Start/Resume and predecessor downgrades. Bulk Resume is unavailable. A visiblev1 person may resume only with exact immutablev1 review/version evidence, even before128 supplies per-run schema hints. Returning to capable code does not reactivate held entry; a genuine owner must enable a ready current version with a new future-only watermark. Missed message expiry remains visible and is not extended silently.

SQL migrations/rehearsal, exact-source Linux validation, publication/deployment and real provider effects are owned by Root. Sol's tests use synthetic services/provider references and do not claim live delivery or a genuine owner walkthrough.
