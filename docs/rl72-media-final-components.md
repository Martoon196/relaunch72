# Native media components after second audit

This is an unmounted native video extension to canonical RL72. Production's `src/affiliate/` owns products, programmes and reports. No independent signup, billing, paid-video provider rail or duplicate affiliate store remains.

## Source and render

Private sources use the existing workspace blob store or durable `PrivateMediaFiles` objects. Assembly/probe/render boundaries verify complete integrity; range/status calls do not rehash whole files. Accepted video is H.264 up to 1080p, subject to the source probe's codec, dimensions, frame-rate and process limits. Upload screens state this plainly.

FFmpeg encodes one clip at a time, then concatenates encoded segments with the demuxer. CPU/address-space/descriptor limits, RSS watchdogs, bounded diagnostics and timeouts remain. No network/provider request occurs. Outputs must remain below 20 MB.

Videos have one five-minute limit. Bitrate adjusts to fit 20 MB; the old fixed-rate ~4:13 refusal is removed. SQL checks source bounds, erased sources and one-second minimum clips; final size/probe enforcement remains.

A fixed `#ad` is drawn separately at 15% across and 22% down, after fades, on a black label. Owner caption text cannot move, overwrite or remove it. Captions wrap into at most six lines in the central area and shorten with an ellipsis. The previous combined unwrapped caption/disclosure renderer did not guarantee visibility; that claim has been corrected. Actual exported frames with a 240-character input caption are OCR-tested in portrait, square and landscape. These are excerpts of the caption, not a promise to display all 240 characters.

## Worker and retention

The supervised loop discovers native sources/object uploads/render jobs only. Its role/grants live in native drafts; no paid-provider draft or table is required. Claim tokens, ten-minute leases, heartbeat, retry caps, queue/storage caps and terminal source-change checks remain. One heartbeat transport failure is tolerated; a definitive lost lease returns reconciliation-required without falsely marking the source permanently changed. Settlement remains fenced.

Absent or NULL `creative_media_retention_settings.source_output_days` means indefinite library retention. An authenticated owner may explicitly select 1–3650 days or restore indefinite retention. Automatic expiry cannot silently delete an existing library by default. Manual source erasure also tombstones derived local outputs. Missing disk configuration leaves physical deletion pending without aborting the worker tick. Expired staging remains automatically cleaned in bounded batches. External copies and backup/WAL erasure remain integration/operations responsibilities.

## Canonical publication

Owner review binds exact local output evidence; canonical caption and video approvals control publication. Native source adapters use existing campaign/planner/enqueue/lease/calling functions without replacing them. JIT checks exact bytes, current source/edit/review/brand/rights/disclosure and current approvals near the scheduled slot; proof lasts 15 minutes. The three-day database-clock test reaches the actual calling trigger and verifies withdrawal/expiry/erasure blocks.

The calling trigger runs only on a state update entering `calling`, using column comparisons in WHEN. Classification inside its canonical-owner definer reads attachments without a caller classifier grant. A separate text-job isolation fixture reaches calling after the posting role’s classifier EXECUTE grant is revoked. It is not used as end-to-end planner proof.

## UI and parked affiliate pages

Visible render digests and the JSON fallback editor are removed. Hidden transport values and internal digests remain for exact evidence. Provider workbench/output/access, products/reports/commerce views and their tests are removed. Billing and paid provisioning stay canonical.

Public product-page templates and click-beacon logic remain dark and unmounted for later production affiliate articles. Their legacy SQL is parked outside the active native manifest. The owner publication entry explicitly refuses until the canonical adapter exists; it cannot load retired stores. No live page, click endpoint or merchant report was integrated here.

The historical memory JSON receipts remain labelled historical: they measured the earlier layout/CRF renderer. New CI repeats the real-footage benchmark for the current fixed-rate layout. See the PR's exact-head run for current measurements rather than treating old receipts as new evidence.


Third audit repair semantics supersede the earlier trigger/role/measurement descriptions. See “Third audit corrections” in rl72-native-media-integration.md: column-only trigger WHEN, durable probe backoff, bundled measured font and word wrapping, optional OCR dependency, explicit HEVC refusal, native-only role, workspace source caps and metadata erasure. Whole-command memory is approximately 330 MiB in Claude’s independent measurement; historical renderer-only ~212 MiB receipts are not whole-command memory. No full removal of supplier terminology is claimed for older revisions; the current visible-word regression bans the supplier names themselves.


Measured scope correction: exact-code CI run #255 recorded **484,340 KiB (~473 MiB)** for the whole preparation/render command (307.68 seconds), and **215,076 KiB (~210 MiB)** for the nested renderer tree (74.14 seconds). Both stayed under the 1.5 GiB aggregate RSS watchdog. Claude’s earlier ~330 MiB whole-command measurement was on a different environment/revision. Neither the ~212 MiB historical figure nor the ~210 MiB nested figure describes the whole documented command. Missing bundled font assets now fail explicitly rather than allowing machine font fallback.
