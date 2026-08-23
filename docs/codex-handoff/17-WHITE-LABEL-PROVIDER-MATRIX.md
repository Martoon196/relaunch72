# 17 — WHITE-LABEL PROVIDER MATRIX

**Status:** procurement and architecture decision record; no provider has been purchased, contracted or production-approved by this document.
**Verified:** **2026-08-23**, against current public material published by the vendors themselves. Prices are public list prices, normally before tax, and can change.
**Scope:** replaceable rails for social publishing, social listening, WhatsApp/shared inbox, webinars/video, email, SMS, booking and an optional automation backend.
**Product rule:** Relaunch72 owns the customer experience, canonical records, permissions, consent, reporting and operation history. A provider supplies a rail; it does not become the product.

---

## 1. Decision in one page

Do not buy one “all-in-one white-label platform.” Build one excellent Relaunch72 control plane and attach narrowly scoped providers through capability adapters. That preserves the fast, coherent UX specified in [16-MODULAR-PRODUCT-UX.md](./16-MODULAR-PRODUCT-UX.md) and prevents a social vendor, inbox vendor or automation canvas from becoming a second product hidden inside ours.

The lowest-risk starting stack is:

| Rail | First choice | Backup / destination | Decision now |
|---|---|---|---|
| Social publishing + connected-account engagement | **Zernio API technical pilot**, production only after the contract/security gates in §4. | **Mixpost Enterprise** self-hosted; **Ayrshare** when scale and risk justify its higher floor. | Zernio has the best public low-volume economics and deepest documented headless flow, but it is not yet procurement-approved. |
| Broad social listening | **Do not sell broad listening in v1.** Ship “Listening Lite” from the selected publishing provider’s connected-account comments, DMs, mentions and reviews. | **Brand24 API** first broad-listening vendor; **Mention API** second. | Real web-wide listening starts around $698/month on Brand24, so activate it only behind a paid add-on. |
| WhatsApp + shared inbox | **Twilio WhatsApp transport behind Relaunch72’s own inbox.** | **Direct Meta Cloud API** is the lower-markup destination after Tech Provider/app approval; **360dialog** is a later reseller route. | Twilio removes the minimum commitment while the product and compliance model are proven. Do not embed a second inbox UI. |
| Webinar/video | **Daily Video SDK.** | **Whereby Embedded**, but only after written confirmation that the intended customer-facing SaaS use and attribution treatment are permitted. | Daily has 10,000 free participant-minutes monthly and supports an embedded or fully custom interface. Relaunch72 still owns registration, reminder, attendance and follow-up. |
| Transactional/bulk email transport | **Amazon SES à la carte.** | **Postmark Platform** for easier operations and strong inbound/event tooling; **Resend** remains a developer-friendly alternative. | SES is the cheapest invisible rail. Relaunch72 must provide tenant domains, templates, suppression, consent and deliverability operations. |
| UK SMS | **Plivo subaccounts.** | **Twilio Messaging.** | Plivo exposes tenant-isolating subaccounts and lower published UK starting rates; route-specific prices and deliverability must be tested before committing. |
| Booking | **Nylas Calendar + Scheduler API/components.** | **Cal.com Platform/Atoms** if its commercial quote works; self-hosted **cal.diy** is the ownership fallback. | Nylas has a public $10/month production entry point with five connected accounts and a customisable embedded scheduler. |
| Durable automation backend | **No customer-visible third-party canvas in v1.** Use Relaunch72 recipes, jobs and outbox. | **Temporal** when durable workflow complexity warrants it; **Activepieces Embed** only after customers will fund a visual builder. | n8n is not a full white-label option: its OEM editor retains n8n branding and backend client use requires Enterprise terms. |

This is deliberately not a forever-vendor decision. Every “first choice” remains replaceable behind the capability and migration contracts in §3.

---

## 2. What “white label” actually means

Vendor pages use “white label” for materially different rights. Procurement must record the surface separately from the legal right:

| Marker | Meaning | What Relaunch72 customers see | Does it automatically permit resale? |
|---|---|---|---|
| **UI-WL** | The vendor’s own customer-facing UI can be branded or have branding removed. | A vendor-built interface wearing our brand. | **No.** Branding controls do not prove the right to sell access. |
| **API** | Relaunch72 builds the UI and the vendor is an invisible backend. | Only Relaunch72, except unavoidable native network OAuth/consent screens. | **No.** The API terms still need to permit the intended multi-customer SaaS use. |
| **RESELL** | Public terms or a commercial plan expressly contemplate selling customer access/subscriptions. | Either our UI or a permitted branded vendor UI. | **Yes, within the exact plan and contract limits.** It does not grant ownership of source code or trademarks. |
| **OSS** | Software can be self-hosted under its open-source licence. | Whatever we build and legally rebrand. | Depends on the licence. MIT is permissive; AGPL can require network-service source disclosure; vendor enterprise modules can have separate terms. |

Examples that matter here:

- Zernio and Ayrshare are principally **API** rails. Their own dashboards are not the Relaunch72 product.
- Mixpost Enterprise is **UI-WL + RESELL access**: it expressly targets launching a SaaS, but its terms still prohibit redistributing or extracting its source.
- Whereby sells custom branding, yet its standard Embedded terms restrict making the service available to third parties without written authorisation and require visible attribution. “Remove branding” on a pricing table is therefore not the same as clean reseller permission.
- Activepieces has a genuine branded embedded product, but the public floor is $36,000/year.
- n8n OEM is embedded, not fully white-labelled: n8n says its branding remains visible.

Fit labels used below:

- **NOW** — viable for an inexpensive pilot or launch, subject to the stated gates.
- **LATER** — credible once volume, revenue or a customer requirement justifies it.
- **NO** — not suitable for the proposed proprietary, customer-facing product in its currently documented form.

---

## 3. Provider boundary and exit contract

### 3.1 One provider must never define a module

Relaunch72 modules consume capabilities, not vendor names. The minimum split is:

| Product capability | Examples of provider-specific implementations |
|---|---|
| social.publish | Zernio, Mixpost, Ayrshare |
| social.analytics.read | Zernio, Mixpost, Ayrshare |
| social.inbox.read | Zernio, Ayrshare |
| social.inbox.reply | Zernio, Ayrshare, subject to network support |
| social.listen.public | Brand24, Mention, Bright Data experimental collector |
| messaging.whatsapp.send / receive / status | Twilio, Meta Cloud API, 360dialog |
| video.room / recording / attendance | Daily, Whereby, Zoom Video SDK |
| email.send / receive / status | SES, Postmark, Resend |
| sms.send / receive / status | Plivo, Twilio |
| booking.availability / create / cancel | Nylas, Cal.com |
| workflow.execute | Relaunch72 jobs, later Temporal |

A provider may implement several capabilities, but enabling one never silently selects it for the others. Zernio, for example, now advertises social, SMS, WhatsApp and telephony on one rate card; that is useful optionality, not permission to couple four modules to one account.

### 3.2 Connection and operation records

Each provider adapter should declare:

- capability IDs and per-network limitations;
- commercial surface: UI-WL, API, RESELL or OSS;
- connection ownership: organization, workspace, customer WABA, number, domain or social profile;
- encrypted credential reference, scopes and expiry/reconnect state;
- webhook signature scheme, delivery semantics and deduplication key;
- provider object-ID mapping to Relaunch72 canonical IDs;
- cost meter and hard/soft budget;
- data region and retention configuration;
- health, last successful reconciliation and provider incident state;
- export, disconnect, deletion and migration procedure.

Every outbound effect receives a Relaunch72 operation ID and idempotency key. Every inbound event is persisted before acknowledgement, signature-checked and deduplicated. The UI shows provider-confirmed target status; a successful HTTP request is not equivalent to “published,” “delivered” or “attended.”

### 3.3 Exit test required before production

A provider is production-ready only when a test workspace can:

1. export or reproduce all canonical customer data without the provider dashboard;
2. disconnect/revoke credentials and prove no further effects occur;
3. reconnect the same customer to a substitute adapter without changing Relaunch72 object IDs;
4. replay status/analytics reconciliation after missed webhooks;
5. identify which assets cannot migrate—social OAuth grants, phone numbers, WABAs, sender reputation, recordings, calendar grants or provider-native workflow definitions;
6. delete or contractually return tenant data and obtain the applicable DPA/subprocessor terms.

Network credentials commonly need re-authorisation on migration. “Replaceable” means the product and records survive; it does not promise that Meta, Google, Microsoft or a telecom carrier will transfer every token.

---

## 4. Social publishing and connected-account engagement

### Recommendation

Run a narrow **Zernio API** technical pilot first because two connected accounts are free and its public docs cover the multi-tenant, headless and webhook details that Relaunch72 needs. Do not make it the production default until legal entity, DPA/subprocessors, service history, support/SLA, platform-partner status and SaaS usage rights are checked in writing. Keep **Mixpost Enterprise** as the ownership-heavy backup; move to **Ayrshare** when a more established managed API is worth at least $599/month.

| Candidate | Surface and commercial right | Publishing, read/reply and onboarding depth | Public floor and usage | Security, exit and fit |
|---|---|---|---|---|
| **Zernio** | **API**. Its [multi-tenant guide](https://docs.zernio.com/multi-tenant) explicitly describes one profile per customer, profile-scoped keys and a fully headless connection mode. This is strong technical evidence for embedded SaaS use, but the public pages reviewed do not grant a separate reseller licence. | Unlimited publish/schedule, analytics, DMs, comments/reviews and webhooks are included according to the [rate card](https://zernio.com/pricing). [Webhooks](https://docs.zernio.com/webhooks) are HMAC-signable, at-least-once, use a stable event ID, retry up to seven times and cover per-target post outcomes plus messages/comments/account health. Customers complete native network OAuth; headless mode keeps intermediate selection in our UI. Important isolation caveat: account IDs are validated across the whole team and aggregate rate limits are shared, so Relaunch72 must enforce tenant mapping/fairness. | $0 for the first two connected social accounts; accounts 3–10 are $6 each/month, 11–100 $3, 101+ $1. X costs pass through at $0.005 reads, $0.010 selected user/article calls, $0.015 posts/DM sends and $0.200 posts with a URL. | The [pricing page](https://zernio.com/pricing) offers SOC 2/GDPR paperwork through a trust portal but only advertises 99.7% uptime, not a contractual SLA. Offboarding requires disconnecting accounts, then deleting the profile; detached resources may be moved rather than erased. **NOW for pilot; production conditional.** The unusually favourable/newer public offer deserves live failure, reconciliation, billing and security testing. |
| **Mixpost Enterprise** | **UI-WL + RESELL access + self-hosted commercial source.** The [Enterprise plan](https://mixpost.app/pricing) is expressly “for launching a SaaS” and includes white-label branding, customer/subscription management and billing. The $299 Pro plan may not be used for a SaaS. The [terms](https://mixpost.app/terms-of-use) bind a licence to one domain/business and prohibit redistributing, selling or extracting components/source; selling hosted customer access is different from distributing the software. | Supports major publishing networks, analytics, approvals, an API, webhooks and engagement. We operate our own network developer apps and app reviews; Meta review is a real implementation task, illustrated by Mixpost’s [Facebook app-review guide](https://docs.mixpost.app/services/social/facebook/app-review/). Public docs show an [onboarding configuration](https://docs.mixpost.app/enterprise/configuration/onboarding/) and [post API](https://docs.mixpost.app/api/posts/create/). Treat comments/mentions as network-specific engagement, not whole-web listening; confirm exact DM/read/reply coverage per network. | $1,199 one-time for one domain/subdomain, one year of updates and a perpetual fallback version; unlimited workspaces, users and social accounts are advertised. Infrastructure, storage, email, network developer fees and engineering operations are ours. | Best data control: application/database/tokens run in our environment. Best software-exit position: the last licensed version remains usable. Lock-in remains at the product/fork level, and custom changes cannot be extracted into other programs without written consent. **LATER / strong backup.** It is cheaper than Ayrshare over time but creates app-review, upgrade and on-call work and risks imposing Mixpost’s information architecture on Relaunch72. |
| **Ayrshare Business** | **API**, not UI-WL. Ayrshare’s own [dashboard policy](https://app.ayrshare.com/docs/help-center/product/can_i_give_my_users_the_dashboard) says the dashboard is internal-only and that no client-facing white-label GUI exists except account linking. Its [Business overview](https://www.ayrshare.com/docs/multiple-users/business-plan-overview) is explicitly designed for posting on behalf of users. | Managed customer profiles, secure social linking, publish/schedule, historical content, analytics, comments, DMs, reviews and webhooks. This is the most mature managed fallback in the matrix. Relaunch72 owns every product screen while Ayrshare handles social API/app maintenance. | [Current pricing](https://www.ayrshare.com/pricing/) is $149/month for one profile, $299 for up to 10, and Business $599/month for 30; profiles 31–100 are $8.99 each monthly, 101–500 $3.49 and 500+ $2.49. The Max Pack is $300/month on Business. | Ayrshare documents encryption and secret storage and provides a [GDPR DPA](https://www.ayrshare.com/data-processing-agreement/); that DPA says EU/EEA-origin data is stored in US data centres with transfer safeguards. Deleting a profile stops billing, but customers will normally need to re-link networks when changing provider. **LATER.** Higher minimum, lower platform-maintenance risk. |
| **Postiz cloud/self-hosted** | Cloud is a vendor product, not documented RESELL/UI-WL. Self-hosted is **OSS AGPL-3.0**; the current [package metadata](https://github.com/gitroomhq/postiz-app/blob/main/package.json) declares AGPL. A modified network service can therefore create source-offer obligations; obtain licence counsel before placing it inside a proprietary SaaS. | The [public API](https://docs.postiz.com/public-api/introduction) supports cloud and self-hosting, and its [OAuth flow](https://docs.postiz.com/public-api/oauth) acts for Postiz users. That is useful for prototypes but can expose Postiz as the account system. Public proof is strongest for publishing/analytics; do not promise full cross-network read/reply from it without an endpoint-by-endpoint acceptance test. | [Cloud pricing](https://postiz.com/pricing) publicly starts around $29/month for five channels and reaches $99 for 100 channels, but buying a normal cloud plan is not the right to resell it. Self-hosted software has infrastructure and maintenance cost. | Self-hosting improves data control, but AGPL and a customer-visible OAuth/product surface conflict with the intended proprietary polished shell. **NO for proprietary production until counsel and a full capability test; acceptable internal prototype.** |

#### Social publishing acceptance test

Before selecting production provider(s), prove the following on Facebook Pages, Instagram Business, LinkedIn organization, TikTok, YouTube and Google Business Profile:

- connect/reconnect/revoke under the correct workspace;
- per-format validation for text, image, carousel, short video, long video, first comment and network-specific metadata;
- draft, scheduled, queued, partial, rejected, published and provider-unknown states;
- idempotent retries and per-target provider IDs;
- inbound comment/DM/mention coverage, reply permissions and deletion/moderation limits;
- analytics freshness, backfill limits and posts created outside Relaunch72;
- shared team rate-limit fairness and cost metering;
- customer offboarding/deletion and missed-webhook reconciliation.

---

## 5. Social listening

“Comments and DMs on accounts a customer connected” is **engagement/inbox**, not broad social listening. Broad listening searches public social/web sources for names, competitors and topics. The APIs, platform rules, cost and redistribution rights are different.

### Recommendation

Launch **Listening Lite** from the social publishing rail at effectively no additional platform minimum. Add **Brand24 API** only when a plan can absorb roughly $698/month before margin. Keep **Mention** as the second commercial benchmark. Bright Data is a low-cost experimental collector, not a compliant substitute for a managed listening product without legal/platform review.

| Candidate | Surface/rights and depth | Public floor | Data/security/exit | Fit |
|---|---|---|---|---|
| **Brand24 API** | **API** for mention-level and aggregate data, sentiment, reach, topics and anomaly events. The [API product page](https://brand24.com/social-listening-api/) says it is intended for products, agents and warehouses, uses server-side REST/JSON, pages up to 500 rows and limits a date-range call to 31 days. It does not provide a reply action. Platform restrictions mean some Facebook, Instagram and X individual text cannot be returned, so the UI must show source/coverage truth. | The [Business plan](https://brand24.com/prices/) is $599/month when billed annually; the API is a $99/month Business add-on and is included on Enterprise, which starts at $1,499/month. Business includes 25 keywords and 100,000 mentions/month. | The reviewed public API/pricing pages do not establish UK/EU storage or a right to redistribute every source field to paying end users. Confirm DPA, subprocessors, retention/export, source-specific display/storage rights and quota behaviour. Export canonical mention IDs, source URLs, classifications and derived tasks before cancellation. | **LATER — first broad vendor.** Best documented product-embedding route, but too expensive for the base launch. |
| **Mention API** | **API** streaming social/web monitoring. The [API page](https://mention.com/en/media-monitoring-api/) explicitly supports adding results to a CRM, report or live site. White-label reporting is available, but that is not a white-label product UI or reseller right. Mention’s [current plan documentation](https://en.support.mention.com/en/articles/7988097-mention-plans-explained) says Publish/Respond is gone for new/inactive users; use this rail for listening only. | Company starts at $599/month on an annual contract; API and historical data are paid add-ons with no current public add-on price. | Storage region, redistribution terms, API quota, SLA and DPA need contract confirmation. Cancellation makes the account view-only and stops new collection, so export before exit. | **LATER — backup.** Commercially less predictable than Brand24 because API cost is quote-only. |
| **Bright Data Social Listening Scraper API** | **API** for on-demand public-web collection and webhook/API delivery, not authenticated network inbox access. It can return public posts, comments, profiles and metrics but has no reply action. This is scraping infrastructure; coverage and platform/legal risk differ from an official-network API. | The [current social-listening rate card](https://brightdata.com/products/web-scraper/social-listening) includes 5,000 records/month free, pay-as-you-go at $1.50/1,000 successful records, or $499/month for 384,000 records with $1.30/1,000 overage. | Easy technical exit because we store delivered JSON and source URLs, but scraper schemas, availability and source terms can change. Complete a UK GDPR lawful-basis, source-terms, retention and data-subject-rights review before processing profiles at scale. | **NO as a launch promise; experimental internal spike only.** Useful for testing demand cheaply, not proof of complete or durable listening coverage. |

No listening provider should be allowed to create CRM contacts automatically. A mention becomes a lead/contact only through a permissioned action or a configured, auditable recipe with source, lawful basis and deduplication.

---

## 6. WhatsApp and the shared inbox

### Recommendation

The customer-facing inbox should be native Relaunch72. Start with **Twilio WhatsApp** as a no-minimum transport. Apply in parallel for the **direct Meta Cloud API / Tech Provider** route, which is the destination if product volume justifies the onboarding and compliance work. Consider **360dialog** only when its €500/month partner floor is economic. Use Chatwoot as an internal/reference accelerator, not a customer-facing iframe.

| Candidate | Surface and commercial right | Webhook/read/reply/onboarding depth | Public floor and usage | Security, exit and fit |
|---|---|---|---|---|
| **Twilio WhatsApp + Conversations** | **API**. Relaunch72 owns the inbox UI; Twilio is message transport/conversation infrastructure, not a branded reseller portal. | Inbound/outbound WhatsApp, delivery statuses and webhooks; Conversations can unify WhatsApp, SMS and chat participant state. Customer/WABA onboarding and subaccount ownership must be designed explicitly rather than sharing one undifferentiated account. | [WhatsApp pricing](https://www.twilio.com/en-us/whatsapp/pricing?locale=en) is $0.005 per inbound or outbound message plus Meta template fees; free-form and qualifying utility messages within the 24-hour customer-service window have no Meta fee, but the Twilio fee remains. [Conversations pricing](https://www.twilio.com/en-us/messaging/pricing/conversations-api) includes the first 200 monthly active users, then starts at $0.05/active user/month; media storage is $0.25/GB/month. | No platform minimum and mature status tooling make this the quickest rail. Lock-in centres on WABA/number ownership and Conversations objects, so keep canonical threads/messages/statuses in Relaunch72 and confirm migration/portability, DPA, subprocessor and UK/EU data-location options before production. **NOW — first.** |
| **Meta WhatsApp Cloud API direct** | **API**, no intermediary UI or reseller licence. Relaunch72 becomes the customer-facing Tech Provider/platform. | Meta’s official [Embedded Signup documentation](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup) describes customer onboarding, WABA/number setup and required permissions. A production app needs business verification, App Review/advanced access, secure webhooks and ongoing policy/template/quality operations. Full send/receive/status depth is available, but Relaunch72 must build the entire inbox and support layer. | No extra BSP handling fee; Meta charges by template category, destination and volume under its [WhatsApp pricing](https://developers.facebook.com/docs/whatsapp/pricing). There is no meaningful “free implementation”: app review, customer support, policy operations and incident handling are ours. | Best long-term cost/control and clearest provider exit if the customer WABA and number ownership are structured correctly. Approval time and operational burden make it a destination rather than the shortest MVP path. **LATER / destination backup.** Confirm Tech Provider eligibility, line-of-credit/billing model, WABA ownership and migration rules. |
| **360dialog Partner Platform** | **API + genuine partner billing/resale relationship.** Under [Partner-Paid](https://docs.360dialog.com/partner/get-started/billing-and-invocing/partner-paid), the partner pays the provider, bills its own clients, sets pricing and owns the commercial relationship. It still does not supply Relaunch72’s inbox UX. | Partner API/Hub, embedded onboarding and per-WABA usage reports. This is a managed Meta partner route, not a general shared-inbox product. | Current [partner-plan documentation](https://docs.360dialog.com/partner/partner-account/360dialog-partnership-program) lists Growth at €500/month ($600) and Premium at €1,000 ($1,200). Partner-Paid regular channel hosting is documented at €25/$25 per month, premium €49/$49 and higher throughput €249/$249, plus Meta usage; direct client [standard pricing](https://docs.360dialog.com/docs/pricing) is €49/$59 per channel. Current pages are inconsistent in some USD/legacy figures, so the order form is authoritative. | Real reseller mechanics, but too high a floor for first customers. Confirm minimum channels, onboarding branding, support boundary, WABA/number migration, DPA, data region and termination notice. **LATER.** |
| **Chatwoot self-hosted** | **OSS MIT core** plus paid enterprise features. The official [licence](https://github.com/chatwoot/chatwoot/blob/develop/LICENSE.md) is permissive. The [FAQ](https://developers.chatwoot.com/self-hosted/faq/) says Community branding can be changed in source; paid plans expose supported custom branding. | Full shared-inbox application and APIs, including a [self-hosted Platform API](https://developers.chatwoot.com/contributing-guide/chatwoot-platform-apis) for accounts/users/roles. It can accelerate internal operations but embedding its full UI would create a second design system and data model. Channel depth still depends on the WhatsApp/SMS provider beneath it. | [Self-host pricing](https://www.chatwoot.com/pricing/self-hosted-plans) is free Community, $19/agent/month annually for Premium custom branding/roles/support, or $99/agent/month for Enterprise SSO/SLA features. It needs Linux, PostgreSQL, Redis, object storage and operational ownership. | Excellent data control and source exit; poor UX fit if exposed directly. A fork creates upgrade/security-maintenance lock-in. **LATER for internal agent console or reference implementation; NO as the customer shell.** |
| **Zernio messaging/WhatsApp** | **API** from the same provider as the social candidate. | Its [pricing and webhook docs](https://zernio.com/pricing) advertise WhatsApp, DMs, message received/sent/delivered/read/failed events, numbers, calls and SMS. | WhatsApp service-window messages are listed as free from Zernio, templates are billed by Meta; numbers start at $3/month. | Attractive as a spike, but using one young provider for social, WhatsApp, SMS and telephony creates concentrated failure/billing risk. **Pilot only; not default across rails.** |

#### Shared-inbox non-negotiables

- one canonical conversation and message model across WhatsApp, SMS, email and social;
- provider delivery/read/failure status is an event, not a mutable string with no history;
- explicit 24-hour service-window and template-category UX;
- consent, opt-out, quiet-hours and lawful-basis policy before every outbound send;
- message assignment, collision prevention, drafts, internal notes and audit;
- media malware scanning and retention controls;
- provider/WABA/number ownership visible to operations;
- reconciliation after missing/out-of-order webhooks;
- exportable threads even when the transport is disabled.

---

## 7. Webinars and embedded video

A video SDK is not a webinar product. Relaunch72 must own public registration pages, consent, CRM identity matching, reminder sequences, host roles, attendance events, replay access and follow-up. The rail provides rooms/media/recording/streaming.

| Candidate | Surface/rights and event depth | Public floor and usage | Security/exit | Fit |
|---|---|---|---|---|
| **Daily Video SDK / Prebuilt** | **API + embeddable UI.** [Daily Prebuilt](https://docs.daily.co/guides/products/prebuilt/customizing-daily-prebuilt) can be styled and embedded; the lower-level call object supports a fully custom UI. Rooms, participant events, recording and streaming are available, but Relaunch72 must derive webinar attendance and lifecycle in its own model. Public product wording clearly targets embedding in apps; confirm the precise SaaS/branding terms in the executed agreement. | [Pricing](https://www.daily.co/pricing/video-sdk/) includes 10,000 participant-minutes/month, then $0.004/min through 100,000 with graduated discounts. Cloud recording is $0.01349/recorded minute plus $0.003/min storage; RTMP is $0.015/min and HLS $0.03/min. There is no hard spend cap after the free allowance, so Relaunch72 needs budgets/alerts. | Daily documents AES-256/TLS, available E2EE, no media storage unless recording, GDPR policies and SOC 2 Type 2 on its [security page](https://www.daily.co/products/security-at-daily/). Store registration, attendance and recording metadata canonically; export recordings to controlled storage. **NOW — first.** Load-test host controls, reconnects, 200+ audience patterns and broadcast semantics. |
| **Whereby Embedded** | **API + UI-WL**, but not clean public RESELL rights. The [Build plan](https://whereby.com/information/embedded/pricing) removes Whereby branding and adds custom branding. However the standard [Embedded terms](https://whereby.com/information/tos/api/) prohibit making functionality available to third parties on a hosted/service basis without written authorisation and require visible attribution to Whereby. Obtain an order form that expressly resolves both clauses before customer use. | Explore is free for 2,000 participant-minutes/month with limited white labelling. Build is $9.99/month including 2,000 minutes, then $0.004/participant-minute; recording and live streaming are each $0.01/minute. Maximum listed room size is 200 participants. | [Security documentation](https://whereby.com/information/security/) and [GDPR material](https://whereby.com/information/gdpr/) describe ISO 27001, encryption and EU account-data hosting; confirm exact media/recording region and use customer-controlled storage where possible. **LATER / backup, conditional on written SaaS and attribution permission.** |
| **Zoom Meeting SDK / Video SDK** | Meeting SDK embeds the familiar Zoom meeting/webinar experience; it remains Zoom-shaped. Video SDK is **API + custom UI** media/session infrastructure, not Zoom Meetings/Webinars. Zoom's current [Video SDK fact sheet](https://developers.zoom.us/blog/video-sdk-fact-sheet/) documents REST APIs, webhooks, customer-defined user IDs, recordings exportable to our storage, up to 1,000 two-way participants and livestreaming to a larger audience. Do not market a Video SDK room as “Zoom Webinar.” | Video SDK includes 10,000 minutes/month, then $0.0035/minute according to that fact sheet. Embedding the full Zoom Meeting experience for SaaS customers follows its separate [ISV route](https://explore.zoom.us/docs/en-us/platform/isv.html), which starts at $2,000/month for 50,000 minutes and requires an ISV agreement/application. Add-ons, recording and support need confirmation. | Zoom documents selectable data centres, TLS/AES-GCM and recording deletion/export on the fact sheet. Strong large-session route, but product and contract paths differ sharply. Keep registration and attendance canonical. **LATER for enterprise/large-event demand.** |
| **LiveKit self-hosted/cloud** | **OSS API media infrastructure**, not webinar software. The core repository uses the [Apache-2.0 licence](https://github.com/livekit/livekit/blob/master/LICENSE), and its [self-hosting docs](https://docs.livekit.io/transport/self-hosting/) cover deployment, region control and scaling. LiveKit supports server webhooks and client SDK events; Relaunch72 still owns registration, attendance interpretation and host workflow. | Self-host has no licence fee but substantial infrastructure/on-call cost. The Cloud Build allowance currently includes 5,000 WebRTC participant-minutes, 50 GB downstream transfer and limited transcode/egress; it is a hard cap, while paid plans meter usage by time and data under the official [quota](https://docs.livekit.io/deploy/admin/quotas-and-limits/) and [billing](https://docs.livekit.io/deploy/admin/billing/) rules. Confirm the selected paid-plan floor/rates in the pricing portal before purchase. | Maximum source/data-region control and an unusually credible cloud-to-self-host exit because the API/SDK surface is shared. Maximum engineering burden; no supplied webinar product. **NO for MVP; LATER only when media becomes strategic enough to operate.** |

---

## 8. Email and SMS

### 8.1 Email transport

No email vendor is the customer-facing product. Relaunch72 owns tenant sending domains, DNS readiness, template versions, consent/suppression, campaign segmentation, reply routing, bounce/complaint handling, cost budgets and delivery truth.

| Candidate | Surface/depth | Public floor and usage | Security/exit | Fit |
|---|---|---|---|---|
| **Amazon SES** | **API/SMTP** invisible transport. Supports outbound, inbound, feedback events and regional identities; SES now exposes an optional tenant pricing primitive. It supplies infrastructure, not a marketing UI, preference centre or CRM. | [Current pricing](https://aws.amazon.com/ses/pricing/) offers à-la-carte outbound at $0.10/1,000 emails plus $0.12/GB attachments and optional tenants at $0.005/tenant/month plus $0.005/1,000 emails. New accounts may default to Essentials at $0.16/1,000; they can switch to à la carte. | SES is regional; domains, DKIM, suppression and feedback configuration are region-specific under the [region guide](https://docs.aws.amazon.com/ses/latest/dg/regions.html). Use a UK/EU AWS region where required and complete the AWS DPA/subprocessor review. Easy functional exit because templates/contacts/events remain ours; sender reputation and warmed IPs do not transfer. **NOW — first.** |
| **Postmark Platform** | **API/SMTP**, not a white-label customer GUI. Platform has unlimited domains/servers/message streams, inbound email and event webhooks, which maps cleanly to multi-workspace sending and reply capture. | [Pricing](https://postmarkapp.com/pricing/) is $18/month for 10,000 emails on Platform and $1.20/1,000 over; full message retention defaults to 45 days and dedicated IPs start at $50/month for eligible volume. | GDPR support is linked from the pricing/security material; confirm storage regions, DPA and subprocessor list for UK customers. Canonical templates, sends, inbound messages and suppression must remain in Relaunch72. **NOW-capable backup** when easier deliverability operations are worth the modest base price. |
| **Resend** | **API/SMTP** with send/receive and webhooks. No client white-label UI or public reseller plan is required if it remains an invisible rail, but multi-customer domain and SaaS terms still need confirmation. | [Pricing](https://resend.com/pricing) is free for 3,000 emails/month with a 100/day cap and three domains; Pro is $20/month for 50,000 with $0.90/1,000 over and 10 domains; Scale is $90 for 100,000 and 1,000 domains. Retention is 30 days on public tiers. | Very low-friction developer experience; less public multi-tenant operational detail than SES/Postmark. Confirm DPA, regions, tenant isolation and webhook limits. **LATER / alternative backup.** |

Recommendation: SES first, Postmark backup. Preserve the existing Postmark adapter as a valid fallback while introducing an email-provider interface; do not rewrite a functioning rail until the provider boundary, delivery webhooks and suppression model exist.

### 8.2 UK SMS

| Candidate | Surface/multitenancy/status | Public UK cost | Security/exit | Fit |
|---|---|---|---|---|
| **Plivo** | **API** with send/receive/delivery callbacks. [Subaccounts](https://www.plivo.com/docs/account/concepts/subaccounts) provide separate auth IDs/tokens, logs and applications while the parent controls billing—useful for workspace isolation and reseller-style metering without exposing a vendor UI. | [UK pricing](https://www.plivo.com/sms/pricing/gb/) starts at $0.0372/outbound segment and $0.003 inbound; listed carrier routes are commonly around $0.045–$0.056, so “starts at” is not a budget assumption. Local numbers are $0.85/month and mobile numbers $0.90/month. | Confirm UK sender registration, carrier filtering, DPA/subprocessors, number portability and exact route quality. Keep consent/opt-out and message status in Relaunch72. **NOW — first, after deliverability test.** |
| **Twilio Messaging** | **API**, subaccounts and rich delivery/error/status tooling. Twilio also supplies opt-out protection and can share infrastructure with the WhatsApp MVP, though adapters and cost meters remain separate. | [UK pricing](https://www.twilio.com/en-us/sms/pricing/gb) lists $0.056 outbound and $0.0075 inbound per segment for mobile numbers; clean local numbers are $1.15/month, mobile $2.50 and one-way alphanumeric sender IDs free. Failed messages can incur $0.001. | More expensive list price but operationally mature. Confirm UK number portability, data region/DPA and subaccount ownership. **NOW-capable backup.** |
| **Telnyx managed accounts** | **API** with managed child accounts and configurable pricing/billing through its [Managed Accounts API](https://developers.telnyx.com/api-reference/managed-accounts/retrieve-a-managed-account). | Public [messaging pricing](https://telnyx.com/pricing/messaging) shows a platform fee plus carrier costs, but the reviewed page did not yield a reliable all-in UK route total. | Potential scale alternative, not price-comparable until a UK route/number quote and delivery test exist. **LATER.** |

SMS and WhatsApp must not share consent merely because one provider can send both. Record channel, purpose, source, timestamp, policy version, jurisdiction and opt-out separately.

---

## 9. Booking

### Recommendation

Use **Nylas Calendar + Scheduler** first because it is a genuine embedded API/components product with a low public production floor. Keep **Cal.com Platform/Atoms** as the richer white-label scheduling-business option if its Platform commercial terms are affordable. The current self-hosted Cal.com repository has become **cal.diy under MIT**, which is a strong ownership fallback but transfers calendar app reviews and operations to us.

| Candidate | Surface/rights and onboarding/event depth | Public floor | Security/exit | Fit |
|---|---|---|---|---|
| **Nylas Scheduler** | **API + embeddable components.** The [Scheduler quickstart](https://developer.nylas.com/docs/v3/getting-started/scheduler/) supports Google, Microsoft and Exchange availability/bookings inside an app. Hosted OAuth or bring-your-own auth creates revocable grants; booking created/pending/rescheduled/cancelled/reminder events are documented in the [Scheduler API](https://developer.nylas.com/docs/v3/scheduler/). Styling and in-domain embedding are supported, while fully custom hosted-auth branding is an Enterprise feature—confirm the exact non-Enterprise customer experience. | [Pricing](https://www.nylas.com/pricing/) is $10/month for Calendar, including five connected accounts, then $1.50/connected account/month. Sandbox is free for five accounts. Billing counts a grant that existed at any time in the month, so churn cleanup does not retroactively prorate. | Nylas documents GDPR/DPA controls, encryption and US or Europe (London) isolated application regions on its [security](https://www.nylas.com/security) and [data-residency](https://developer.nylas.com/docs/dev-guide/platform/data-residency/) pages. London is UK, not EEA; match actual customer contracts. Exit requires users to re-authorise calendars with the new provider, but Relaunch72 appointments, availability policy and contact links remain canonical. **NOW — first, subject to SaaS terms and auth-branding review.** |
| **Cal.com Platform / Atoms** | **API + UI-WL**. Cal.com’s [Platform introduction](https://cal.com/docs/platform/introduction) says it is for starting a scheduling business and allows white-labelling the design or changing code; APIs, OAuth, Atoms and webhooks cover users, schedules, slots, event types, teams and bookings. This is stronger public white-label intent than a normal Teams subscription. | Normal hosted [pricing](https://cal.com/pricing) is free individual, Teams $12/user/month annually and Organizations $28; these prices do not automatically establish Platform resale economics. Platform/Enterprise commercial pricing must be confirmed. | Hosted Organizations advertise US/EU hosting and enterprise compliance controls. The current self-hosted [cal.diy licence](https://github.com/calcom/cal.diy/blob/main/LICENSE) is MIT, permitting use/modification/distribution subject to notice; Cal.com trademarks and any separately licensed hosted/enterprise services remain separate. **LATER / backup unless Platform quote is clearly low.** |

The booking abstraction must own event type, resource/host, availability policy, appointment, attendee, reminder and cancellation state. Provider grants and configuration IDs are mappings only. That allows Nylas to be replaced by Cal.com without rewriting CRM contacts or opportunity timelines.

---

## 10. Optional automation backend

The customer product should initially expose versioned, guardrailed recipes—not a general node canvas. That is both a UX decision and the cheapest licensing path.

| Candidate | Surface/licence | Public floor | Lock-in/exit and fit |
|---|---|---|---|
| **Relaunch72 recipes + PostgreSQL jobs/outbox** | Native product UI and domain events. No third-party white-label licence. Implement the durability rules in documents 15 and 16 before adding a canvas. | Infrastructure already required for the product; marginal provider floor $0. | Best UX and canonical audit trail for the first high-value automations. Keep recipe definitions provider-neutral and versioned. **NOW — first.** |
| **Temporal** | **API/invisible durable workflow backend**, not a customer builder. Temporal’s service/core is [MIT](https://github.com/temporalio/temporal/blob/main/LICENSE) and can be self-hosted; workflow code lives in our codebase. | [Temporal Cloud](https://temporal.io/pricing) Essentials starts at $100/month with 1 million actions, 1 GB active and 40 GB retained storage; further actions start at $50/million. Self-hosted is open source but adds operational cost. | Strong durability and a credible self-host/cloud exit. It does not solve recipe UX or connector breadth. Workflow histories and code semantics create some migration work, so keep domain events/commands stable around it. **LATER — first backend upgrade when job complexity justifies it.** |
| **Activepieces Embed** | **UI-WL + commercial embedded builder.** The [pricing page](https://www.activepieces.com/pricing) promises an embeddable builder, branding, JS SDK, user provisioning and piece/template management. Community Edition is open source for internal/self-host use, but branding, projects/admin and product embedding are not the free commercial shortcut. | Embed starts at **$36,000/year**, credit-based. Ordinary plans are $0, $16/month and $166/month, but their features/rights are not the embedded SaaS product. | Genuine branded canvas and broad connectors, but far above a low-cost MVP. Flow definitions and credentials are vendor-specific. Export templates plus a Relaunch72 recipe representation. **LATER only after paid customer demand funds it.** |
| **n8n Enterprise/OEM** | **API/invisible backend on Enterprise; embedded branded editor on OEM.** n8n’s [OEM page](https://n8n.io/oem/) is explicit: backend use where customers only trigger/consume workflows needs regular Enterprise; exposing a builder needs OEM; n8n branding remains visible and full white-labelling is not offered. Its [licensing FAQ](https://support.n8n.io/article/can-i-use-your-license-for-my-use-case) says hosting/managing client workflows and credentials requires a commercial licence. | Enterprise and OEM are quote-only for this use. Public standard [pricing](https://n8n.io/pricing/) is not permission to run customer workflows as Relaunch72. | Excellent internal tool, poor fit for a fully branded Hootsuite-class product. Node credentials and JSON workflows are a strong vendor schema. **NO for customer-visible Relaunch72 automation; LATER only as a contracted invisible backend.** |

Never expose a community-edition workflow editor to customers on the assumption that hiding the logo creates reseller rights. Licensing follows the use case, not the CSS.

---

## 11. Current-cost shape for an early pilot

This is not a forecast or purchasing authorisation. It shows why a modular launch can start cheaply while preserving production options.

| Rail | Low-volume public floor | What is not included |
|---|---:|---|
| Zernio social pilot | $0 for two connected accounts | Due diligence, engineering, X pass-through calls, production support/SLA |
| Listening Lite | $0 additional provider minimum | Only connected-account engagement, not web-wide monitoring |
| Twilio WhatsApp | $0 platform minimum; $0.005/message + Meta fees | WABA onboarding, templates, support, inbox engineering, Conversations usage beyond free MAUs |
| Daily video | $0 for first 10,000 participant-minutes/month | Recording/streaming, webinar product workflows, spend cap |
| SES email | $0 monthly minimum on à la carte; $0.10/1,000 sends | Attachments, domains/DNS, reputation, consent/suppression, AWS support |
| Plivo SMS | No public monthly platform minimum; usage + number | Route/carrier price, registration, deliverability operations |
| Nylas booking | $10/month for five production connected accounts | Relaunch72 booking UI/workflows, additional grants, enterprise auth branding |
| Native recipes/jobs | No third-party licence | Engineering, database/worker/observability infrastructure |

The first meaningful fixed SaaS jump should be deliberate:

- Mixpost Enterprise: $1,199 once plus self-host operations;
- Ayrshare Business: $599/month;
- Brand24 Business + API: about $698/month;
- 360dialog Growth partner: €500/month plus channels/Meta;
- Temporal Cloud: $100/month;
- Activepieces Embed: $36,000/year.

Those numbers should become entitlement and pricing-model inputs, not surprise infrastructure overhead.

---

## 12. Mandatory sales/legal/security confirmation queue

No “production-approved” flag should be set until the applicable answers and documents are stored in the vendor record.

### Every managed provider

- Exact legal entity and contracting jurisdiction.
- Explicit permission for a multi-tenant paid SaaS using the API; separate confirmation of UI white-label and reseller rights where relevant.
- DPA, controller/processor roles, subprocessors, international-transfer mechanism and breach notification.
- Storage, processing, backup and support-access regions; retention and verified deletion times.
- SOC 2/ISO reports actually covering the purchased service and plan, not merely the hosting provider.
- Availability SLA, support severity/response, incident history/status page and termination assistance.
- Rate limits, quota pooling, fair-use clauses, retry semantics and sudden-spend controls.
- Pricing currency, tax, minimum term, auto-renewal, overage, failed-action charges and price-change notice.
- Export format, API availability after cancellation and deletion certificate.
- IP, trademark and legally required provider/network attribution.

### Zernio-specific

- Written SaaS API right and any limitation on charging end customers.
- Company/service history, ownership and support coverage.
- SOC 2 report scope, DPA/subprocessor list, data regions, RPO/RTO and contractual SLA.
- Official network app/partner arrangements and what happens if one network revokes access.
- WhatsApp/SMS underlying carrier/BSP, WABA/number ownership and portability.
- Whether “unlimited” API features have unpublished fair-use or historical-retention limits.

### Mixpost-specific

- Enterprise licence permits the intended headless/API-backed Relaunch72 UX, not only operating the supplied customer dashboard.
- One-domain definition across white-label customer domains and future PropInvestUK brands.
- Upgrade/support pricing after year one, security-patch access and transfer on company sale.
- Exact DM/comment/review read/reply coverage and webhook semantics by network.

### WhatsApp-specific

- Who owns each Business Manager, WABA, number, display name and template.
- Embedded signup branding and business-verification support boundary.
- Meta fees, BSP markup, failed-message charges and customer-service-window calculation.
- Number/WABA migration out, coexistence limitations and termination process.
- Quality-rating/template-ban escalation and policy enforcement.

### Daily/Whereby-specific

- Express customer-facing SaaS/embedded right and any logo/attribution requirement.
- Maximum practical audience, active video/presenter limits, webinar/broadcast controls and concurrent sessions.
- Media routing/recording region, storage ownership, export and deletion.
- Spend caps, abuse controls and SLA.
- For Whereby, an order form overriding or expressly authorising the third-party hosted-service use in §4.9 of its standard terms and resolving §10 attribution.

### Nylas/Cal.com-specific

- Platform resale/API commercial terms at expected customer/grant counts.
- Hosted OAuth/consent branding on the chosen tier.
- Google/Microsoft app ownership, verification limits and token migration.
- Calendar-data fields retained, region, deletion and webhook history.
- Nylas billing treatment for short-lived grants; Cal.com Platform versus ordinary Teams/Organizations entitlement.

### Automation-specific

- Whether customers see/edit workflows or only trigger product features.
- Who owns and can export workflow definitions, secrets, logs and connector OAuth grants.
- Per-execution/credit definition and runaway-workflow protection.
- Self-host rights, patch access and responsibilities after termination.

---

## 13. Procurement scorecard

Score each production candidate 0–3 and attach evidence. Any red gate overrides the total.

| Dimension | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| Commercial right | Prohibited/unknown | Verbal/marketing only | Contract permits API SaaS | Express API SaaS plus needed reseller/UI-WL rights |
| Low-volume economics | Unaffordable floor | High fixed minimum | Modest base | Usage-only/free pilot with hard budgets |
| Capability depth | Core action missing | Polling/partial | Core + status webhooks | Core + read/reply + reconciliation/backfill |
| Tenant onboarding | Manual/vendor dashboard | Shared admin flow | Customer OAuth | Branded/headless OAuth with tenant isolation |
| Security/privacy | No DPA/region answer | Basic policy | DPA + controls | Audited controls, region choice, deletion evidence |
| Reliability | No status/SLA | Marketing uptime | Retry/status tooling | SLA, incident process, replay/reconciliation |
| Exit | No export/ownership unclear | Manual partial export | API export + reconnect | Tested migration with canonical data intact |
| UX fit | Vendor product leaks through | Heavy embed constraints | Mostly invisible | Fully controlled Relaunch72 experience |

**Red gates:**

- no written SaaS/commercial right;
- customer data or credentials cannot be isolated by workspace;
- no webhook authenticity or no safe reconciliation path;
- WABA/number/domain ownership is unclear;
- provider requires misleading attribution removal;
- no DPA for personal data;
- no export/deletion route;
- spend can run unbounded without our own enforceable limit.

---

## 14. Final recommendation

Relaunch72 can reach “GHL breadth with Hootsuite-class polish” without buying a £500/month monolith, but only by being strict about what it owns:

1. **Own the shell and canonical data.** Providers never become navigation, contacts, conversations, campaigns, appointments or automation definitions.
2. **Start with usage-priced invisible rails.** Zernio pilot, Twilio WhatsApp, Daily, SES, Plivo and Nylas keep the early fixed floor low.
3. **Delay expensive category promises.** Broad listening, a visual automation canvas and partner-resold WhatsApp are paid expansion modules, not launch checkboxes.
4. **Keep a tested backup per rail.** Mixpost/Ayrshare, Meta/360dialog, Whereby, Postmark/Twilio, Cal.com and Temporal are credible exits or scale paths.
5. **Treat “white label” as three questions.** Can we hide the vendor? Can we charge customers? Can we migrate away? A yes to one does not answer the other two.

The immediate build sequence should therefore be:

1. provider registry + connection health + secret references;
2. one social publish vertical slice with per-target status/reconciliation;
3. native unified inbox model with Twilio WhatsApp;
4. SES delivery/bounce/suppression and Plivo SMS status rails;
5. Nylas booking and Daily room/attendance adapters;
6. only then a paid listening adapter and later durable/visual automation upgrades.

That creates a genuine product with replaceable infrastructure—not a pile of white-labelled dashboards held together by navigation links.
