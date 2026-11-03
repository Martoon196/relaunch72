# Article campaigns and reviewed media (010)

This extends the existing brand SEO programme. It does not introduce a second sender or scheduler. The native article Campaign page combines the blog, private image crops and six accompanying drafts: launch, practical takeaway and follow-up for Instagram and LinkedIn.

## Configuration and default state

- Image generation starts **off for every brand**. The existing image allowance is unchanged; it counts admitted provider attempts, not crops. An uncertain provider result is not zero usage or permission for another attempt.
- The stored operator image policy independently controls model/quality, concurrency and conservative cost reservations. Its default policy is disabled with zero headroom. Reservations are not supplier invoices.
- Only `SEO_BLOG_IMAGE_API_KEY` supplies the image transport credential. There is no global-key fallback or key copying. The SEO worker needs this key for a real call; the portal can record genuine owner intents without possessing it.
- Existing `SEO_BLOG_ENABLED`, `R72_CONTENT_ENABLED`, model settings, writing/research ceilings, native authentication and CSRF remain in force. No feature or policy is activated by installing the source.
- The fixed approved image request remains `gpt-image-2`, one1536×1024 medium JPEG. The application uses the reviewed single-call transport, codec and durable coordinator; it does not call an interactive image tool or silently upgrade the model.

## Image intent, preparation and recovery

An explicit `write` job with `payload.stage='image'` captures the database source snapshot, current sponsor, policy and exact request digest. Its real worker principal commits admission, attempt nonce and allowance usage before any transport call. Raw candidate bytes and safe receipt are committed before decoding. A lost acknowledgement is recovered through the same nonce/receipt; an unresolved start never grants another call.

Image jobs do not count toward the article-writing backlog. Ordinary job DTOs and progress endpoints omit generator prompts, full private profile/article snapshots, aliases and raw receipts. Progress polling is read-only, bounded, resets on page lifecycle changes, and reveals an explicit result link without replacing unsaved owner edits.

Default image intent is once per immutable first article version, including terminal/unknown history. Active identical-source requests coalesce across command IDs. Exact command aliases are recovered before rebuilding a now-changed source. A distinctly new manual paid intent after any earlier start requires explicit acknowledgement and the authoritative previous intent ID. A generic Retry cannot clear that history.

Prepared variants are real JPEGs: blog1600×900, Instagram1080×1350 and LinkedIn1200×627. Owner focal adjustments and JPEG uploads use saved/private bytes and the same bounded codec. They do not call a generator or consume a generation allowance. The native screen displays actual private crops and exact alt text.

## Quality, use and public lifetime

Canonical `kind=image` review binds the asset's actual pixel SHA, profile, dimensions, crop recipe, provenance and exact alt text. Its generic quality manifest has presentation `{profile,alt}`; it is independent of a hero slot or a particular social use. Previously approved exact pixels may be selected again only through a new genuine owner-use command. A newer rejected quality version is not a blanket licence to use arbitrary old media.

Hero flow:

1. Review the real private crop and description.
2. Reserve a prospective release UUID/URL before inserting that URL into the immutable article body and website-target digest. The prospective URL is still private/404.
3. Review the final article/target version and separately authorise its exact image use. A later body or target version needs a new exact authorisation.
4. Inside the existing publication-begin transaction, pin `Publication.mediaRelease`, assert **current** image-effect eligibility, then release the same preallocated URL on the **same PostgreSQL client**. A publication rollback rolls back the release.

The current-effect assertion is mandatory on every fresh begin/resend. A historical release receipt is recovery evidence, not fresh effect permission after withdrawal, changed quality or owner removal. Read-only reconciliation does not run a new-send assertion or republish pixels. A scoped current-image hold does not overwrite a newer draft, schedule, hold or open/unknown operation.

Public pixels are served only at `/api/public/seo-blog/media/<releaseUUID>/<pixelSHA>.jpg` on the exact central host. The least-privilege `r72_web` reader consults committed releases and explicit withdrawals, not current membership, a newer draft or the content UI flag. The media-only central fallback remains available when `R72_CONTENT_ENABLED` is off; every other central path remains unavailable. Unknown/withdrawn IDs are404/no-store/nosniff. Private or mismatched bytes are never returned.

Explicit asset withdrawal stops its public URLs and new social uses. It preserves review/history and does not claim to delete an already sent provider post. A release is not implicitly withdrawn by editing a profile, draft or membership.

## Exact social revisions

The initial six-angle proposal replaces the existing initial `SEO_BLOG_SOCIAL` completion. It uses the same model, preflight and output ceiling with one call and no automatic format-correction call. Incomplete/invalid copy is not described as six model-written posts; the native fallback is labelled as article-excerpt copy.

The initial-only copy boundary saves the validated article body, its generation receipt, a planned immutable version identity, exact profile/current-knowledge digests, genuine authority and original worker epoch before the social completion. A known accepted or rejected response, actual tokens and nonce receipt commit together under the brand/article lock. Known malformed output remains labelled `excerpt_fallback`; accounted usage never makes it model-written. Persistence retries use only the same known result. Restart reads the saved body/receipt before either article or social model; started work without a receipt holds instead of paying again. Cancellation, changed sources or an obsolete worker epoch may retain late receipt/usage but cannot apply an obsolete article version. Pending started/no-receipt initial-copy work reserves the unchanged6,000-token estimate under the same brand lock, separately from actual recorded usage. Concurrent copy calls cannot spend the same headroom. Unknown prior-month starts retain that conservative reservation; a real nonce receipt atomically replaces it with actual known usage. Copy authority follows the genuine immutable write requester, independently of the owner who planned the topic. A system write uses the current explicitly authorised programme owner or eligible profile confirmer under the existing policy. Captured copy authority never switches mid-attempt. The earlier article-model call before this captured boundary is not redesigned by this slice.

An unresolved initial-copy request currently has an explicit safe hold and its saved body/attempt history, with generic paid retry denied. There is no owner-facing new-paid-copy or zero-call template-completion recovery action in this packet. That remains a product acceptance follow-up; the hold must not be described as a completed campaign or silently reset.

Each channel/angle has its own stable variant UUID. Every text, media, recipe, alt or parent change creates a new immutable revision UUID/digest and a new prospective social media-use identity. Social-only edits leave the blog body, other variants and owner date/omission controls unchanged. A parent edit retains earlier revisions; an explicit rebase preserves owner copy/pins/omissions while requiring new exact review. A null canonical URL is an unbound private draft, never approval/queue/effect authority.

Canonical post identity is genuine `relaunch72.seo-blog`, with source item including the stable variant UUID and source version `campaign:v1:<articleVersion>:<variantRevision>:<revisionSHA>`. The existing combined-social envelope/MIME is format reuse; it does not impersonate a Property Predator source. Full canonical bytes remain the approval digest. The actual provider receives only the exact approved post text and verified inline JPEG, not the JSON or art direction.

Social image use is distinct from hero use. It binds the exact parent, revision/digest, network, selected canonical image approval, real asset/profile/alt and new use UUID. A hero release cannot authorise a social post. Native approval and eligible batch actions report a result for each item; an unsupported/uncertain item cannot approve another. Uncertain queue responses preserve a retry action for the same command identity.

## Deferred delivery and diary

A genuine owner can record an immutable delivery instruction while the blog is a draft. It binds the exact reviewed post/media/target, registered account and cap snapshot. **No canonical posting job exists while the parent is unpublished.** The mutable native campaign pointer is only display metadata; the owner command ledger is authority.

The true content worker materialises the instruction only after independent verification of the same article version and URL, and rechecks current owner membership, latest uncancelled instruction, approvals, use, pause, account receipts and limits. It never installs an owner GUC or relaxes the generic user validator. Mature planning/enqueue and their receipt remain atomic and idempotent. Reconciliation never uploads or resends.

Owner instruction and initial existing-kind `publish` wakeup commit together. Exact publication verification wakes pending instructions on the same transaction. Bounded recovery discovery during the existing SEO tick lists only genuine pending instructions whose exact parent is already live and programme unpaused. It invokes the idempotent materialiser directly with UUID continuation; it does not create timestamped wakeups, poll drafts indefinitely or create a second scheduler. Expected cap/serialization holds remain per-instruction held outcomes and cannot stop other brands. Existing social proof checks run independently before recovery. Unexpected or database-authority failures stay visible as sanitized blocked/failure outcomes, with the same durable instruction identity; they are not successful materialisation receipts.

Relative rules are captured as `{kind:'relative_verified',days:0|3|7,afterMinutes:60,timezone}`. They use the earliest trustworthy stable `Publication.firstVerifiedAt` for the exact version/URL. Latest `verifiedAt` may advance on reobservation; the first anchor never does. Missing/mixed legacy first-anchor history holds relative delivery; an exact future owner pin is the remedy. Existing materialisation receipts keep their own captured anchor and slot.

Days0 preserves the known UTC anchor. Days3/7 add local calendar days only when the resulting wall time resolves uniquely, then add60 elapsed minutes while preserving seconds/milliseconds. DST gaps/overlaps hold for an exact pin. Passed slots never rebase to now or burst out late. Existing5-second admission rules remain unchanged. Proposal dates are visibly separate from actual connected-calendar jobs. The existing editorial month/week/agenda projects the six current revisions, keeps blog entries first and retains exact owner pins. Before publication, a brief or blog date produces an explicitly proposed offset; missing dates and ambiguous clocks stay in an undated waiting tray. These cards have no drag/drop scheduling payload. The separate connected social diary calls the existing `list_zernio_calendar_jobs` capability through the genuine original-home session and selected-brand membership, at most100 rows over366 days. A Campaign link requires an exact stored canonical job receipt, never matching text.

Date changes create a distinct owner instruction and supersede/cancel the old target. The existing0133 exact-slot/one-active canonical-version/network protection stays in force. Only explicitly cancelled/superseded, provably never-called `needs_attention` work may be retired by the narrow separate worker cleanup transaction. Calling/unknown/reconciliation work is never freed for a duplicate send.

## Accounts and existing rails

The provider picker reveals only the current brand binding and server-returned profiles with exact external ID equal to the brand UUID. It excludes other-brand bindings, unclaimed global inventory and reserved legacy profiles from new selection. Names and raw guessed IDs confer no authority. Account options also require current signed ownership/connection receipts and matching hashes. No eligible profile or failed inventory fetch is shown as connected.

New brand limits remain explicit owner configuration, default zero/off. Dispatch uses the lower of captured and current limits under the existing serialised cap machinery. Property Predator's environment-bound profile/account path and1/day3/month pilot caps remain unchanged. Instagram requires one real reviewed image; LinkedIn text-only eligibility is independent. Facebook, X and TikTok delivery are not supported by this slice.

The registered-brand media branch reuses the existing restricted uploader/sender with current account targets. It accepts only exact SEO campaign provenance and real planning/job/proof media rows. Manifest evidence remains JSON; delivery MIME is actual JPEG. No virtual duplicate media row is appended. JIT refresh derives fresh short-lived post/media evidence from the real immutable instruction and current source; it does not extend an expired founder observation or require the founder to return solely because time passed.

## Native Authority review

The central-only Authority tab is read-only. It reuses the frozen evidence/proposal modules and the genuine selected brand's profile, knowledge, inventory and delivery reads. Missing/unconfirmed context is labelled with Setup actions. It starts no paid search, generation, queue or outreach and makes no measured AI-visibility claim.

## Release and verification

Migration0137 is additive;0131–0136 are unchanged. The release owner first deploys the exact-checksum compatibility bridge to every active strict schema consumer, migrates/checks137, then deploys and verifies capable SEO and social workers before exposing the producer UI. Capability logs are `campaign-media-v1` and `seo-campaign-media-v1`. Old optional-target/publish handlers are not a safe downrev consumer of these intents: retain capable workers while such work exists. Older article writers also do not honour the initial-copy start/receipt marker. Keep the capable SEO worker while captured copy work exists; rolling the portal back does not authorise downgrading that consumer.

Relevant checks include the campaign revision/generation/service/native/queue/image-status tests, exact media delivery/host/picker neighbours, media-effect race holds and stable verification-anchor regressions. The disposable actual-role adapter test is `orchestrator/test/db/seo-blog-media-engine.integration.test.ts`; the storage/ledger matrix is separate. Run DB files serially with the existing disposable confirmation/lease harness. Both use synthetic data and stub providers; neither authorises a real image call, operator policy, brand opt-in, public article or social post.

Final acceptance is bound to the frozen combined source, actual-role PostgreSQL journey, normal Linux gate and final native desktop/narrow renderer checks. An earlier component or WIP screenshot is partial evidence, not a claim that the complete programme is enabled.
