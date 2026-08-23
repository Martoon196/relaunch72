# 16 — MODULAR PRODUCT + UX ARCHITECTURE

**Status:** implementation architecture, not a claim that the described modules already exist.
**Scope:** the customer and agency product surface for Relaunch72 as a modular CRM, content, social, inbox/WhatsApp, webinar and automation platform.
**Depends on:** the workspace, authorization, PostgreSQL, jobs/outbox and provider boundaries in [`15-POSTGRES-CRM-FOUNDATION.md`](./15-POSTGRES-CRM-FOUNDATION.md).
**Product bar:** social operations with the confidence and clarity expected of a mature social suite, but with fewer navigation layers and less duplicated configuration than a general-purpose all-in-one CRM.

---

## 1. Decision in one page

Relaunch72 should become **one workspace product with independently enabled modules**, not a collection of mini-apps and not one enormous dashboard. The stable shell owns identity, workspace selection, navigation, search, quick-create, background-operation status and help. Modules own their routes and domain workflows, but share canonical contacts, opportunities, conversations, content, events and activity.

The non-negotiable product rules are:

1. **One selected workspace per operational request.** An organisation/agency overview may show safe workspace aggregates, but opening contacts, messages or content always enters one explicitly selected workspace. This matches the tenancy and RLS model in document 15 (§3 and §7).
2. **A module appears because it is usable, not because marketing named it.** Lifecycle, entitlement, actor permission, provider readiness and environment safety are resolved separately on the server. A planned module is never presented as ready.
3. **One object, one canonical home.** A contact is a CRM object referenced from Inbox, Webinars and Social; those modules do not create competing contact stores. A conversation has one thread even when viewed from a contact timeline.
4. **One action, one durable command.** Send, publish, schedule, import, generate and sync actions return a stable operation ID. The interface renders queued/running/retrying/failed/unknown/succeeded from durable state; it never treats a button click as completion.
5. **Truth is part of the design system.** Draft, mock, test, scheduled, published, stale, partially synced and provider-unknown states have distinct labels and behaviours. “Published” means the target provider confirmed it.
6. **Progressive enhancement, not a big-bang SPA rewrite.** The current portal is dependency-free server-rendered HTML. Keep fast HTML navigation and forms; add small route-specific scripts for command palette, composer, board and inbox interactions.
7. **Controlled workflows before a blank canvas.** Ship useful automation recipes with versioned configuration and run logs before exposing a general graph editor.
8. **White label changes presentation and customer-facing identity, not security, provider truth, legal attribution or accessibility.**

This makes “cleaner than GHL” measurable:

- no more than two navigation levels;
- one global Create control;
- one Connections area and one Settings area;
- planned modules absent from the day-to-day navigation;
- no duplicate contacts, calendars, templates or conversations per module;
- every async action has one status trail and recovery route;
- the default Home screen is a work queue, not a wall of decorative charts.

---

## 2. Current state — repository evidence

The following describes the repository now. Everything after this section is the proposed product contract unless labelled otherwise.

| Surface | What is present now | Product implication |
|---|---|---|
| Customer routes | The portal has setup, login/logout, dashboard, billing/subscribe/manage and one `POST /portal/run` action (`orchestrator/src/portal/router.ts:92-214`). | Preserve these URLs through redirects/adapters, but introduce real module routes incrementally. |
| Customer rendering | The current working tree has extracted a dependency-free server-rendered `appShell` with native HTML controls, one tokenised stylesheet, a skip link and desktop/mobile breakpoints (`orchestrator/src/portal/ui.ts:1-5,55-107,127-183`). | Keep this progressive-rendering seam. Split it into tested primitives/modules as interaction complexity grows; there is no reason to buy a heavy client framework before a route needs it. |
| Dashboard | The page shows pipeline counts, contacts, activity, billing, brand brain and generated artifact previews (`orchestrator/src/portal/views.ts:68-81,113-188`). Mock keywords, draft content and paused ads are explicitly labelled (`orchestrator/src/portal/views.ts:123-140,167-181`). | Keep the hard-won truth labels. Recompose these real pieces into Home, CRM and Content rather than enlarging the single page forever. |
| Dashboard data | The portal reads CRM state from `CrmStore` and opens `s3.json`, `cc.json`, `keyword-report.json`, `ad.json` and `s8.json` from a tenant run directory (`orchestrator/src/portal/data.ts:28-110`). | The new UI must consume workspace read models and artifact metadata from PostgreSQL/object storage, as specified in document 15; modules must not read each other's files. |
| CRM | A contact currently carries the only pipeline stage; the fixed stages are lead/contacted/qualified/won/lost, with one typed activity timeline (`orchestrator/src/crm/types.ts:9-14,24-50`). The file store supports tenant/contact/activity operations but no opportunities or tasks (`orchestrator/src/crm/store.ts:19-27`). | The first sellable module must split Contact from Opportunity and add tasks, consent, attribution and real CRUD before adding broad channel UI. |
| Social | A thin adapter can connect, schedule, publish and query one post status; it deliberately supports mock/live implementations (`orchestrator/src/social/types.ts:1-9,24-55`). The schedule builder turns S8 output into deterministic dated posts (`orchestrator/src/social/schedule.ts:42-61`). | Reuse the adapter seam, but build account connections, per-target state, approvals, reconciliation and a planner read model around it. |
| Admin | `/admin` is a separate password-protected control room for runs/orders, stage output and sign-off (`orchestrator/src/server/admin/router.ts:84-163`; `orchestrator/src/server/admin/views.ts:75-157`). | Keep platform operations separate from the customer's workspace navigation. Later replace the shared password with platform memberships; do not expose platform controls as a customer “module.” |
| Missing platform work | The repository gap report records no SMS/WhatsApp adapter, OAuth/connect flow, durable scheduler/jobs, opportunities/tasks/appointments/conversations/consent/attribution, multi-workspace membership or real analytics (`docs/codex-handoff/08-HONEST-GAP-REPORT.md:32-40`). | Screens for these capabilities must stay planned/hidden until their vertical slices are complete. |
| Manager | Current cadence is deterministic calendar logic with no persisted last-run state (`orchestrator/src/manager/schedule.ts:1-7,26-37`). The repository assessment correctly calls the manager a planner/dispatcher rather than a production job system (`docs/codex-handoff/04-MANAGER-AND-RAILS.md:18-33`). | The Operations centre must be backed by document 15's durable jobs/outbox; UI polling cannot manufacture durability. |
| Early modular contracts | The current working tree contains a typed capability list, versioned workspace event envelope and a module registry with lifecycle/dependency validation (`orchestrator/src/platform/capabilities.ts:6-29`; `orchestrator/src/platform/events.ts:1-59`; `orchestrator/src/platform/modules.ts:15-49,52-85,88-153`). Tests prove stable ordering, planned-state truth and workspace/correlation context (`orchestrator/test/platform-modules.test.ts:9-58,60-93`). | Keep these as the seed. The design below extends them with actor permissions, setup/readiness, commands, search and object contributions rather than replacing them. |

The current portal's honest copy—“Mock workspace,” “not published,” “simulated,” and “paused”—is a product asset, not temporary embarrassment (`orchestrator/src/portal/ui.ts:163-181`; `orchestrator/src/portal/views.ts:123-140,167-181`). The product shell should generalise that honesty with the environment and status contracts below.

One current transitional choice should not become the final IA: `appShell` renders planned expansion modules as disabled primary-navigation and quick-jump items (`orchestrator/src/portal/ui.ts:123-150,157-179`). That is useful for a private founder demo, but §4.2 makes the customer-product rule explicit: planned modules move to one product-discovery surface and stay out of daily work navigation.

---

## 3. Product hierarchy and scope

The hierarchy is the same as document 15:

```text
Relaunch72 platform
└── Organization (commercial account / agency / white-label owner)
    ├── Branding, verified domains, billing ownership, organization members
    └── Workspace (one operating business / client sub-account)
        ├── Members + permissions + entitlements
        ├── CRM objects
        ├── Content + social accounts + inboxes + webinars
        ├── Automations + jobs + provider operations
        └── Workspace settings
```

### Scope transitions

| Context | URL family | Permitted data | Persistent visual cue |
|---|---|---|---|
| Platform operations | `/admin/...` initially; later `/ops/...` | Cross-tenant operational records available only to platform roles. | “Platform operations” header, no customer white-label shell. |
| Organisation overview | `/portal/o/:organizationSlug/workspaces` | Safe aggregate status/counts only for explicitly granted workspaces. | Organisation name plus “Agency overview.” |
| Workspace product | `/portal/w/:workspaceSlug/...` | Exactly one selected workspace under RLS. | Workspace switcher visible in header on every route. |
| Public/customer acquisition | Verified custom domain routes outside the authenticated shell. | Published form/webinar/checkout identified by a verified host/token, never a posted workspace ID. | Customer brand plus required provider/legal attribution. |

The slug is a human-friendly route locator, not authority. The server resolves it against the authenticated user's active membership, updates or confirms the opaque session's selected workspace, then installs the database request context. A switch is a CSRF-protected command; changing the URL alone cannot select an inaccessible workspace.

An organisation overview never reuses a workspace CRUD repository with a broader credential. It consumes the organisation aggregate read model described in document 15 §7. Opening a count switches into that exact workspace before retrieving any underlying contacts or messages.

### Top-level modules

The stable module IDs already introduced in `orchestrator/src/platform/modules.ts` are the correct product vocabulary:

| Module ID | Customer label | Primary job |
|---|---|---|
| `overview` | Home | Know what needs attention and what is running. |
| `crm` | CRM | Manage people, companies, opportunities and tasks. |
| `content` | Content | Create, review and approve on-brand material. |
| `social` | Social | Plan, target, approve, schedule and reconcile posts. |
| `inbox` | Inbox | Triage and reply to customer conversations, including WhatsApp. |
| `listening` | Listening | Monitor configured social sources and turn mentions into work. |
| `webinars` | Webinars | Run registration, attendance and follow-up. |
| `automations` | Automations | Configure guardrailed cross-module recipes and inspect runs. |
| `analytics` | Analytics | Report only measured, source-labelled performance. |
| `settings` | Settings | Manage people, connections, workspace, brand, billing and data. |

“Connections” is a Settings subsection and a global setup destination, not an eleventh product silo. “Operations” is a global drawer/page for jobs and provider effects, not a marketing module.

---

## 4. Information architecture and navigation

### 4.1 Persistent workspace shell

Desktop shell:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Brand / workspace ▾      Search or run a command…     + Create   ◷   ?   Me │
├──────────────────┬───────────────────────────────────────────────────────────┤
│ Home             │ Breadcrumb / module tabs                    Page actions │
│ CRM              ├───────────────────────────────────────────────────────────┤
│ Inbox            │                                                           │
│                  │                     Route content                         │
│ CREATE & PUBLISH │                                                           │
│ Content          │                                                           │
│ Social           │                                                           │
│ Webinars         │                                                           │
│                  │                                                           │
│ Automations      │                                                           │
│ Listening        │                                                           │
│ Analytics        │                                                           │
│                  │                                                           │
│ Settings         │                                                           │
└──────────────────┴───────────────────────────────────────────────────────────┘
```

Shell responsibilities:

- brand mark and product name from resolved organisation branding;
- organisation/workspace switcher with search, recent workspaces and status;
- primary navigation generated from resolved module manifests;
- global Search/command palette;
- permission-filtered `+ Create` menu;
- Operations indicator for queued, failed or ambiguous work;
- help and user menu;
- environment truth badge: `Live`, `Sandbox`, `Mock data` or `Read-only`;
- workspace suspension/payment/readiness banner where applicable;
- one skip link and predictable focus target after navigation.

Keep at most eight ready/setup-required destinations visible at a normal 900px-tall desktop viewport. Put infrequent Analytics and Settings at the bottom; if more entitled modules arrive later, use a labelled “More” group rather than scrolling through dozens of features. There are at most two levels: primary module and module tabs. A third nested sidebar is prohibited.

### 4.2 Navigation by state

| Resolved module state | Primary navigation behaviour | Direct-route behaviour |
|---|---|---|
| `ready` | Normal destination. | Render normal module. |
| `read_only` | Visible with subtle lock/read-only indicator. | Render data; mutation controls absent/disabled with exact reason. |
| `setup_required` | Visible only when entitlement exists; show setup dot. | Render a module-specific setup page, not an empty product imitation. |
| `degraded` | Visible with warning dot. | Render cached/partial state with provider incident and last-success time. |
| `suspended` | Visible if data/export remains permitted. | Render suspension reason and permitted recovery/export actions. |
| `preview` | Visible only when there is honest preview data; labelled Preview. | No live actions; explain provenance and unavailable operations. |
| `planned` | Hidden from daily navigation. | 404 or a deliberate product-discovery page outside the work surface. |
| `unavailable` | Hidden. | 404 for undiscoverable capability; 403 for an authenticated actor who knows a permitted module URL but lacks action permission. |

This is stricter than putting disabled teaser links throughout the application. Commercial discovery belongs on Billing/Plans or a single “What’s available” page.

### 4.3 Module tabs and routes

| Module | Tabs / canonical routes |
|---|---|
| Home | `/portal/w/:ws/home` |
| CRM | `/crm/contacts`, `/crm/companies`, `/crm/opportunities`, `/crm/tasks`; detail routes `/crm/contacts/:id`, `/crm/opportunities/:id` |
| Content | `/content/library`, `/content/approvals`, `/content/calendar` |
| Social | `/social/planner`, `/social/queue`, `/social/accounts`; composer at `/social/compose` or a route-backed drawer |
| Inbox | `/inbox`, with saved views encoded in query parameters; conversation detail `/inbox/:conversationId` |
| Listening | `/listening/streams`, `/listening/saved-searches`; item state in query/detail drawer |
| Webinars | `/webinars`, `/webinars/:id`, `/webinars/:id/registrations`, `/webinars/:id/follow-up` |
| Automations | `/automations/recipes`, `/automations/runs`, `/automations/:id` |
| Analytics | `/analytics/overview`, then source-labelled funnel/channel reports only when real |
| Settings | `/settings/workspace`, `/settings/people`, `/settings/connections`, `/settings/branding`, `/settings/billing`, `/settings/data` |
| Operations | `/operations`, reachable from the global Operations indicator |

Prefix every module route with `/portal/w/:workspaceSlug`. The abbreviated paths above show only the module-relative portion.

### 4.4 Global Create

The Create menu contains only actions the actor may perform and the workspace can currently execute:

- Contact
- Opportunity
- Task
- Content draft
- Social post
- Webinar
- Automation from recipe

If a required provider is missing, the item either routes to setup with an explicit label (“Connect a social account to create a post”) or is absent. It must not open a form that can never complete.

### 4.5 Search and command palette

`Ctrl+K` / `⌘K` opens one palette with two result groups:

1. **Objects:** contacts, companies, opportunities, conversations, content, webinars and automations the actor may read in the selected workspace.
2. **Commands:** navigate, create, switch workspace, assign, open setup, retry an authorised failed operation.

Rules:

- server search remains RLS- and permission-scoped;
- results never cross workspaces unless the user explicitly invokes “Switch workspace” first;
- a result shows type, primary label, secondary context and last activity—never an unexplained ID;
- commands are registered by module manifest and removed when their permission/readiness predicate fails;
- keyboard navigation uses a true combobox/listbox pattern, with visible focus and Escape restoring focus;
- recent items are stored per user/workspace and cleared on membership revocation;
- destructive, billing, connection and live-send actions are not one-keystroke commands; the palette routes to their confirmation surface.

---

## 5. Module manifest and capability resolution

### 5.1 Separate five questions

The current registry usefully distinguishes module lifecycle and missing capabilities (`orchestrator/src/platform/modules.ts:88-110`). Production resolution must keep these independent:

1. **Lifecycle:** has Relaunch72 built and released the module (`planned`, `preview`, `beta`, `available`, `retired`)?
2. **Entitlement:** did this workspace receive the product capability and any limit through `workspace_entitlements`?
3. **Permission:** may this actor perform this action in this workspace?
4. **Readiness:** are required connections/configuration/worker services healthy enough for the action?
5. **Environment safety:** is this a live, sandbox, mock or read-only environment, and are outbound effects allowed?

Do not overload one `capabilities` set to answer all five. A social provider may support publishing, the workspace may own publishing, and the user may still lack `social.posts.publish`.

### 5.2 Normative manifest contract

Extend the existing `PlatformModuleManifest`; retain stable IDs and routes:

```ts
interface ProductModuleManifest {
  id: PlatformModuleId;
  contractVersion: 1;
  labelKey: string;
  shortLabelKey: string;
  descriptionKey: string;
  icon: IconToken;
  group: 'work' | 'channels' | 'intelligence' | 'system';
  order: number;
  route?: RouteTemplate;
  lifecycle: 'planned' | 'preview' | 'beta' | 'available' | 'retired';

  requiredEntitlements: readonly CapabilityKey[];
  readPermissions: readonly PermissionKey[];
  setupRequirements?: readonly SetupRequirementKey[];
  dependsOn?: readonly PlatformModuleId[];

  objectTypes?: readonly ObjectType[];
  commands?: readonly CommandContribution[];
  searchProviders?: readonly SearchContribution[];
  eventSubscriptions?: readonly PlatformEventType[];
  eventPublications?: readonly PlatformEventType[];
  tabs?: readonly NavContribution[];

  whiteLabel: 'inherit' | 'platform_only';
  dataClassification: 'standard' | 'personal' | 'sensitive';
}
```

The checked-in manifest is build-time product configuration. Database rows may enable entitlements, limits, flags or kill switches, but customers cannot upload executable module code or arbitrary manifest JSON in the first release.

### 5.3 Resolved product contract

For each request, the server produces a `ResolvedProductContract`:

```ts
interface ResolvedProductContract {
  organization: SafeOrganizationBrand;
  workspace: SafeWorkspaceSummary;
  actor: SafeActorSummary;
  environment: 'live' | 'sandbox' | 'mock' | 'read_only';
  modules: readonly ResolvedModule[];
  globalCommands: readonly ResolvedCommand[];
  operationsSummary: { queued: number; failed: number; ambiguous: number };
  generatedAt: string;
  contractEtag: string;
}
```

Resolution order is fail-closed:

```text
known manifest
  ∩ released lifecycle
  ∩ active workspace entitlement
  ∩ active membership + actor read permission
  ∩ module dependencies
  ∩ workspace/account status
  → visible module

visible module
  ∩ action permission
  ∩ provider/config readiness
  ∩ environment outbound policy
  ∩ usage limit
  → executable command
```

The contract helps rendering; it is not a bearer authorization token. Every route and command re-runs the authoritative permission/readiness check server-side in the transaction that performs or enqueues work.

### 5.4 Setup requirements

Use typed requirements rather than module-specific booleans:

- `workspace.profile.complete`
- `crm.default_pipeline.ready`
- `brand.brain.ready`
- `social.account.connected`
- `messaging.inbox.connected`
- `whatsapp.sender.approved`
- `webinar.provider.connected` or `webinar.external_mode.allowed`
- `worker.healthy`
- `outbound.live_allowed`

A requirement returns `ready | pending | failed | blocked`, a safe reason, last checked time and one authorised resolution URL. OAuth secrets, provider payloads and internal stack traces never enter the contract.

### 5.5 Provider capabilities

Provider registration should continue using the same stable capability vocabulary, as the current provider/module test already expects for social and WhatsApp (`orchestrator/test/platform-modules.test.ts:112-122`). Provider capability means “this adapter can perform the operation,” not “this user is entitled or authorised.”

The connection screen resolves:

```text
workspace entitlement × provider adapter support × granted OAuth scopes ×
connection health × actor permission × environment policy
```

This permits a later Ayrshare, direct network, Postiz/Mixpost or other adapter to replace another without changing the Social screens.

### 5.6 Provider capability matrix and build/buy boundary

**External-provider snapshot checked 2026-08-23. Re-check pricing, licences, scopes, review programmes and SDK limits before procurement or implementation.**

The mature-suite pattern worth copying is not a specific Hootsuite screen. It is one product surface joining publishing, engagement/inbox, listening and analytics while integrations remain extensible; Hootsuite itself describes those as connected but distinct capabilities and maintains an app directory ([Hootsuite platform](https://www.hootsuite.com/platform), [Hootsuite App Directory](https://apps.hootsuite.com/)). Relaunch72 should copy that **capability architecture**, then keep its own cleaner shell and canonical CRM.

Never define a provider as merely `social`. Register granular capabilities:

```text
social.account.onboard
social.post.validate
social.post.publish
social.post.status
social.post.analytics
social.engagement.read
social.engagement.reply
social.listening.account_mentions
social.listening.keyword_search
messaging.whatsapp.onboard
messaging.whatsapp.receive
messaging.whatsapp.send
messaging.whatsapp.templates
webinar.session.create
webinar.session.embed
webinar.session.attendance
```

One provider connection can implement several, but no implementation may infer one capability from another. In particular, **posting/scheduling does not prove comment read/reply, broad listening, inbox delivery or webinar attendance**.

| Candidate/path | Architectural use | Boundary and release rule |
|---|---|---|
| Existing `SocialPublisher` / direct network adapters | Small native publishing contracts and one-network proof. | Extend behind workspace-scoped connections and per-target operations. Add each capability only after real integration tests/app approval. |
| Mixpost Enterprise | Potential self-hosted **publishing rail** behind Relaunch72's API/provider adapter. | Keep Relaunch72 as CRM, UX, auth, jobs and source of canonical post status. The current official offer is $1,199 one-time, includes Enterprise white-label/SaaS features, API/MCP inherited from Pro, unlimited workspaces/social accounts and one year of updates with perpetual fallback; Pro explicitly cannot be used to build a SaaS. Its terms prohibit redistributing/selling its source or modifications, so do not copy its code into this repository; complete procurement/legal review before depending on it ([Mixpost pricing/licence FAQ](https://mixpost.app/pricing)). Treat any engagement feature as a separately tested provider capability, not an assumed scheduler feature. |
| Postiz | Potential self-hosted/public-API publishing rail or experimental adapter. | The upstream application declares AGPL-3.0, so hosted/product use needs explicit licence review ([Postiz package metadata](https://github.com/gitroomhq/postiz-app/blob/main/package.json)). Its official MCP supports integration discovery and post/media writes but explicitly cannot read or reply to comments; API/OAuth existence therefore does not make it an Inbox adapter ([Postiz MCP documentation](https://docs.postiz.com/mcp/introduction)). Keep it replaceable and do not let its schema/UI become the product contract. |
| Meta WhatsApp Cloud | Dedicated Inbox/WhatsApp onboarding, receive/send and template capabilities. | Multi-customer onboarding should use Meta's Embedded Signup. Meta's official collection states release requires App Review and Advanced Access for `business_management` and `whatsapp_business_management`; model review/permission state as setup readiness, not an engineering toggle ([Meta Embedded Signup](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup?entity=request-13382743-a0ad59ca-6258-48fa-8662-98ecd381fec9)). Publishing integrations do not satisfy this path. |
| LinkedIn Community Management | Network-specific publishing/engagement/listening capabilities. | Access is vetted: build under Development tier, then request Standard with a working integration, screencast and reviewer credentials. Development disables/restricts some production behaviours, and member-social read access is constrained; represent unavailable scopes/tier as capability state, never fake it with scraping or a generic “connected” badge ([LinkedIn app review](https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review), [Community Management overview](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview)). |
| Zoom Meeting SDK / Video SDK | Webinar delivery adapter selected per event mode. | Meeting SDK embeds Zoom-shaped meeting/webinar functionality; Video SDK is the route for custom UI/branding and creates Video SDK sessions rather than ordinary Zoom meetings/webinars ([Zoom platform comparison](https://developers.zoom.us/docs/platform/)). Session lifecycle/attendance comes through separately registered Video SDK events/webhooks, not from the UI being embedded ([Zoom Video SDK events](https://developers.zoom.us/docs/api/video-sdk/events/)). |

Provider selection is therefore an implementation detail beneath Relaunch72's capability interfaces:

```text
Relaunch72 UX + CRM + permissions + canonical state + jobs/outbox
    ├── SocialPublishProvider     (Ayrshare | Mixpost | Postiz | direct)
    ├── SocialEngagementProvider  (separately proven per network/provider)
    ├── SocialListeningProvider   (coverage-specific; may be another vendor)
    ├── MessagingProvider         (WhatsApp/SMS/email endpoints + webhooks)
    └── WebinarProvider           (external | Meeting SDK | Video SDK | other)
```

The module manifest resolves each capability independently. If Mixpost/Postiz publishes while another service supplies listening, the customer still sees one Relaunch72 Social/Inbox experience and one canonical operation trail. Replacing a rail must not require migrating CRM identities, workspace memberships, permissions or automation definitions.

---

## 6. Canonical cross-module objects

Modules share IDs and links; they do not copy records into module-private shadow tables.

| Canonical object | Owning module | Referenced by | Canonical route / presentation |
|---|---|---|---|
| Contact | CRM | Inbox, Webinars, Automations, Social/listening attribution | `/crm/contacts/:id`; compact identity card in drawers |
| Company | CRM | Opportunities, contacts, tasks | `/crm/companies/:id` |
| Opportunity | CRM | Inbox context, webinar attribution, automation | `/crm/opportunities/:id` |
| Task | CRM | Home work queue, Inbox follow-up, webinar/automation outcome | `/crm/tasks/:id` or route-backed drawer |
| Conversation | Inbox | Contact timeline, automation trigger | `/inbox/:id` |
| Message | Inbox | Conversation and immutable contact activity reference | Inside conversation; stable deep-link anchor |
| Content item/version | Content | Social, campaigns, webinar follow-up | `/content/library/:id` |
| Social post/target | Social | Content calendar, contact/activity attribution | `/social/posts/:id`; per-target results visible |
| Social mention | Listening | Inbox, CRM contact candidate, task | `/listening/mentions/:id` or drawer |
| Webinar/session | Webinars | Content promotion, CRM, automation | `/webinars/:id` and session subsection |
| Registration/attendance | Webinars | Contact timeline, segments, automation | Webinar/contact subresource; not a duplicate contact |
| Pipeline run/artifact | Content/evidence engine | Home, Admin sign-off, Social | `/content/runs/:id` / artifact preview |
| Automation definition/version | Automations | Event subscriptions and run history | `/automations/:id` |
| Job/provider operation | Global Operations | Every async module | `/operations/:id` |

### Shared context drawer

Selecting a contact, opportunity or content item from another module opens the same route-backed context drawer on desktop and a full page on mobile. It provides:

- primary identity/status and owner;
- permitted quick actions;
- linked objects;
- recent source-labelled timeline;
- “Open full record” link.

The drawer requests its own small read model. It does not make every Inbox or Social response include the full CRM record.

### Timeline semantics

One contact timeline may display CRM activities, messages, webinar facts, automation outcomes and social interactions, but the entries remain different typed facts. Each row shows:

- source/module icon and plain label;
- occurred time and, if different, received/synced time;
- actor or provider;
- environment/mode for mock/test effects;
- correlation link to the operation/run;
- expandable evidence or failure state where authorised.

A generated draft is not a message. A scheduled post is not a published post. A webhook-received attendance fact is not silently rewritten as a salesperson note.

---

## 7. Cross-module event contract

The current `PlatformEvent` already carries event ID, numeric version, workspace, actor, occurrence time, correlation and causation (`orchestrator/src/platform/events.ts:37-47`). Preserve that envelope and persist product events through document 15's transactional outbox.

### Initial event catalogue

Use the checked-in names as canonical; the numeric envelope version evolves payloads:

| Event | Producer | Initial consumers |
|---|---|---|
| `crm.contact.created` | CRM capture/create command | activity, dedupe review, automation enrollment |
| `crm.opportunity.stage_changed` | CRM stage command | activity, Home, automations, analytics projection |
| `content.draft.created` | Content generation/import | approvals, Home |
| `content.approval.requested` | Content command | reviewer work queue/notification |
| `social.publish.requested` | Social command | publish job and Operations |
| `social.mention.received` | Provider webhook/import | Listening stream, optional Inbox/task automation |
| `conversation.message.received` | Messaging webhook | Inbox unread/assignment, activity, automations |
| `conversation.message.sent` | Send finalisation | thread/activity/delivery projection |
| `webinar.registration.created` | Registration command | CRM timeline, provider sync, reminder recipe |
| `webinar.attendance.recorded` | Provider webhook | CRM timeline, attended/no-show recipes |
| `automation.execution.requested` | Event router/manual command | automation enrollment job |

Add the next events only with a real producer and consumer:

- `crm.task.created|completed`
- `content.approved|rejected`
- `social.target.scheduled|published|failed|reconciliation_required`
- `conversation.assigned|closed`
- `webinar.registration.cancelled`
- `automation.run.completed|failed`
- `provider.connection.degraded|restored`

Event payloads contain stable IDs and the minimum immutable facts needed for a consumer. Consumers query their own authorised data rather than receiving full contact profiles, message bodies or tokens in every event. Sensitive outbox payloads follow document 15's encryption/redaction rule.

### Event rules

- The domain state change and outbox event commit together.
- The browser may request a command; it never publishes authoritative platform events directly.
- Every event type has a schema/version test and owner.
- Consumers are idempotent by `(event_id, consumer_key)`.
- Correlation and causation depth are preserved; automation recursion is capped.
- Replaying an event may rebuild a projection but must not duplicate a provider effect.
- UI notifications are projections/consumer deliveries, not the source of truth.

---

## 8. Authorization and permissions

Document 15 defines platform, organisation and workspace roles and correctly keeps fine-grained actions in application authorization (`15-POSTGRES-CRM-FOUNDATION.md:108-125`). The UI consumes those decisions but never substitutes for them.

### 8.1 Permission vocabulary

Use action permissions, not scattered role comparisons:

```text
workspace.read, workspace.manage, workspace.export
members.read, members.invite, members.manage
connections.read, connections.manage
crm.contacts.read, crm.contacts.write, crm.contacts.delete, crm.contacts.export
crm.opportunities.read, crm.opportunities.write
crm.tasks.read, crm.tasks.write
content.read, content.generate, content.write, content.approve
social.read, social.schedule, social.publish, social.manage_accounts
inbox.read, inbox.assign, inbox.reply, inbox.export
webinars.read, webinars.write, webinars.launch, webinars.export_attendees
automations.read, automations.edit, automations.publish, automations.replay
analytics.read, analytics.export
operations.read, operations.retry, operations.cancel
billing.read, billing.manage
branding.read, branding.manage
```

Entitlement keys may resemble capability names but answer a different question. `social.publish` as an entitlement can gate product access; `social.publish` as an actor permission should be namespaced or typed separately in code so the two cannot be passed interchangeably.

### 8.2 Default role profile

This is the initial default, not a reason to hard-code role names in every route:

| Action family | Workspace owner | Admin | Marketer | Sales | Viewer |
|---|:---:|:---:|:---:|:---:|:---:|
| Read workspace modules | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manage workspace/members/connections | ✓ | ✓ | — | — | — |
| Create/edit contacts, opportunities, tasks | ✓ | ✓ | ✓ | ✓ | — |
| Delete/export CRM personal data | ✓ | Configurable | — | — | — |
| Generate/edit content | ✓ | ✓ | ✓ | — | — |
| Approve content | ✓ | ✓ | Configurable | — | — |
| Schedule social | ✓ | ✓ | ✓ | — | — |
| Publish live social | ✓ | ✓ | Configurable | — | — |
| Read/assign/reply in Inbox | ✓ | ✓ | ✓ | ✓ | — / configurable read |
| Manage/launch webinars | ✓ | ✓ | ✓ | — | — |
| Edit automation draft | ✓ | ✓ | ✓ | — | — |
| Publish/replay automation | ✓ | ✓ | Configurable | — | — |
| Retry/cancel operations | ✓ | ✓ | Limited own actions | Limited own actions | — |

Organisation `billing` manages commercial billing without receiving CRM/message access. Organisation owner/admin access to a client workspace still requires the explicit active workspace membership from document 15; the organisation role alone is not a hidden master key.

### 8.3 UI and command enforcement

- Read permission determines whether a module/tab/object can appear.
- Action permission determines whether its control appears; a disabled control is used only when explaining a recoverable setup/state condition, not to advertise forbidden actions.
- Every mutation checks membership, permission, entitlement, object workspace, expected version and readiness server-side.
- Bulk actions re-authorise each selected object inside the scoped command and report partial validation before effects begin.
- Live publish, bulk send, data export, connection replacement, automation publish and destructive actions use a review/confirmation step showing scope and consequence.
- Approval and execution can be separated: a user may edit a post but require another actor to approve/publish it.
- Platform support access is just-in-time, time-limited, reasoned and audited. PII stays masked until explicitly authorised; support activity is visually and durably attributed.

---

## 9. Exact first screens

These are the first production screen contracts. “First” means initial route and initial useful state, not every future feature.

### 9.1 Home — `/portal/w/:ws/home`

Home answers “what needs me now?” in this order:

1. **Environment/status strip:** Live/Sandbox/Mock, workspace health, last data refresh; absent when everything is healthy and live except the compact environment badge.
2. **Needs attention:** failed/ambiguous operations, unassigned conversations, overdue tasks, approvals waiting, provider reconnects. Maximum six, ordered by consequence and age.
3. **Today:** tasks due, scheduled social posts, webinar sessions, follow-ups and automation exceptions. This is a shared work queue, not duplicated cards.
4. **Pipeline pulse:** open opportunity count/value and stage movement from real opportunities. Before opportunities exist, show setup/empty guidance—not counts of contact stages presented as revenue.
5. **Content and campaign queue:** drafts awaiting review, scheduled targets and latest generated run.
6. **Recent activity:** typed, source-labelled events with a route to the underlying object/operation.
7. **Setup checklist:** only while incomplete; collapsible after the first meaningful outcome.

The current `Generate draft set` action (`orchestrator/src/portal/views.ts:172-179`) becomes `Create content plan`. It submits a durable command, returns an operation ID and shows progress in Home/Operations; it never holds the HTTP request open for generation.

### 9.2 CRM Contacts — `/portal/w/:ws/crm/contacts`

Header:

- title and real result count;
- saved view/filter control;
- search;
- `Import` and `Create contact` according to permission;
- column/view configuration per user.

Default columns: Contact, Company, primary reachable point, Owner, Lifecycle, Open opportunities, Next task, Last activity. Pipeline stage is not a Contact column unless shown as a derived “latest/open opportunity” field.

Row selection opens the shared contact drawer. Bulk actions initially support assign owner, add task, export (privileged) and archive—not bulk message until consent/suppression and a durable send review exist.

### 9.3 CRM Pipeline — `/portal/w/:ws/crm/opportunities`

Default board shows pipeline/stages with count and amount in workspace currency. A list toggle provides an accessible and high-density alternative. Cards show opportunity, contact/company, value, owner, expected close and overdue next task.

Dragging a card sends `moveOpportunity(opportunityId, targetStageId, expectedRowVersion)`. The card renders `Updating…` until the database command succeeds. A conflict restores authoritative position and explains that another change won; it never silently overwrites. Won/lost transitions open a small required detail step for close date/loss reason as configured.

### 9.4 Contact record — `/portal/w/:ws/crm/contacts/:id`

Header: identity, lifecycle, owner, contactability/consent summary and quick actions. Tabs:

- Overview: fields, company, open opportunities, next tasks;
- Timeline: typed cross-module facts;
- Conversations: linked threads, not copied messages;
- Opportunities;
- Tasks;
- Webinars;
- Attribution/Consent (permission-sensitive).

PII values have explicit reveal/copy controls where policy requires, and every outbound quick action routes through the same channel readiness and suppression checks as its owning module.

### 9.5 Content Library — `/portal/w/:ws/content/library`

First screen shows drafts and approved assets with type, campaign/topic, owner, last revision, approval and downstream use. The current brand brain and generated cluster/ad/social artifacts can move here once they are database-backed artifacts. Mock/test provenance remains visible at card and detail level.

The detail route has editable draft, revision history, evidence/provenance, QA issues, approval history and “Use in…” actions. Approval is an immutable decision over an exact version.

### 9.6 Social Planner — `/portal/w/:ws/social/planner`

This is the social quality bar:

- week/month calendar with timezone clearly shown;
- account/network filters and per-target status filter;
- cards sized by scheduled time, with content preview and target icons;
- unscheduled tray for approved content ready to place;
- list/queue alternative for keyboard, screen-reader and high-volume use;
- status legend based on provider-confirmed target states;
- provider health/last sync in a compact header, not repeated on every card.

One logical social post may have multiple `social_post_targets`. The card summary can say “2 published · 1 failed”; opening it shows each account, provider ID, scheduled/published time, last check and recovery action. Never collapse partial failure into one green “Published” badge.

### 9.7 Social Composer — `/portal/w/:ws/social/compose`

Use a full route with a desktop preview pane; it may present as a route-backed drawer when opened from the planner.

Steps:

1. choose one or more connected account targets;
2. write shared copy or customise by target/network;
3. attach media from the content library/upload flow;
4. inspect network-specific validation and previews;
5. choose publish now or workspace-timezone schedule;
6. submit for approval or confirm live publish according to permission/policy.

Validation shows character/media/provider limits from adapter capability data with “checked at” provenance. A preview is labelled as an approximation unless the provider supplies an exact renderer. Saving a draft is local product state; scheduling/publishing creates per-target durable jobs.

### 9.8 Social Listening — `/portal/w/:ws/listening/streams`

Left: saved streams (account mentions, keywords, configured sources). Centre: mention list. Right: selected item/context on wide screens. Each mention shows provider/source, original occurrence time, received time, author identity as supplied, content/media preview, sentiment only if a measured model is enabled and clearly labelled, assignment and triage state.

Actions: reply/open in Inbox when supported, create/link contact candidate, create task, assign, mark handled, open original. The screen shows exact coverage and last successful sync. It must never imply whole-web listening when the provider connection covers only selected networks/accounts.

### 9.9 Shared Inbox + WhatsApp — `/portal/w/:ws/inbox`

Desktop uses a three-pane pattern:

```text
Saved queues / inboxes | Conversation list | Thread + contact context
```

Core queues: Mine, Unassigned, All open, Mentions, Snoozed, Closed. Filters: channel, inbox, assignee, unread, contactability, date. Conversation rows show contact/handle, channel, last-message preview/time, unread count, assignee and state.

The thread composer evaluates before send:

- active endpoint/connection and granted provider scopes;
- channel policy state returned by the adapter;
- contact endpoint and consent evidence;
- active suppression;
- actor reply/send permission;
- workspace/environment outbound policy;
- usage/credit limit.

For WhatsApp, do not hard-code a policy-window duration in presentation code. Render provider-normalised states such as `freeform_allowed`, `approved_template_required`, `recipient_or_policy_blocked` with the provider's current explanatory copy and permitted templates. The UI may show the provider-reported deadline/time, but the adapter remains authoritative because policies change.

After Send, append a local `queued` message and operation link. It progresses through `sent`, `delivered`, `read` or `failed` only from provider-confirmed operations/webhooks. If the provider call result is ambiguous, label `Checking delivery` and reconcile; do not encourage a duplicate send.

Mobile shows one pane at a time: queues → list → thread, with browser back preserving filters/scroll. Contact context becomes a sheet/full page.

### 9.10 Webinars — `/portal/w/:ws/webinars`

List screen groups Upcoming, Draft, Past and Needs attention. Each row/card shows title, next session in workspace timezone, provider mode, registration count, sync health and follow-up state.

Create flow:

1. basics and host;
2. one or more sessions/timezone;
3. delivery mode: external URL, embedded provider or future native mode;
4. registration fields, consent copy/version and capacity;
5. confirmation/reminder recipe;
6. review and publish.

Webinar detail tabs:

- Overview: session/status and operational checklist;
- Registrations: contacts, source/UTM, consent, provider sync;
- Attendance: attended/no-show/unknown with provider receipt time;
- Communications: approved reminder/follow-up content and operations;
- Settings: versioned event configuration.

Launching opens the provider/native host route with a clear external/embedded label. Relaunch72 does not call an event “Live” merely because its scheduled start has passed. Attendance arrives through idempotent provider events and retains unknown/unmatched states for review.

### 9.11 Automations — `/portal/w/:ws/automations/recipes`

First release is a recipe catalogue plus configured automations, not a blank node canvas. Initial recipes mirror document 15:

- New lead → assign owner + create task + approved email;
- Opportunity stage changed → notify owner/team;
- Webinar registration → confirmation + reminders;
- Webinar attended/no-show → segment + follow-up task/message;
- Inbound conversation unassigned for N minutes → notify/assign;
- Social publish failed → create operational task/notification.

Automation detail shows:

- human-readable trigger, conditions and actions;
- affected channels and required connections;
- draft version versus published immutable version;
- enrollment safeguards, re-entry rule and recursion cap;
- dry-run/test using a selected sample object without outbound effects;
- recent runs with subject, step states, operation IDs and errors;
- pause/publish controls according to permission.

Editing a published automation creates a draft version. Publish review names every live external effect. Replaying resumes only eligible failed steps; it does not rerun the whole enrollment blindly.

### 9.12 Connections — `/portal/w/:ws/settings/connections`

Cards are grouped by Social, Messaging, Email, Webinar/Calendar, Analytics and Payments (merchant-side only when built). Each shows capability, provider, connected identity, scopes, environment, health, last successful sync, credential expiry if known and actions.

OAuth start is a CSRF-protected server command bound to user + workspace + provider; callback state is single-use as specified in document 15. Replacing/disconnecting warns about scheduled posts, inboxes, webinars or automations that will degrade. Secrets and raw tokens are never rendered.

### 9.13 Operations — `/portal/w/:ws/operations`

This cross-module screen is essential before live channels:

- filters by module/type/state/date/initiator;
- queued, running, retry-wait, succeeded, failed/dead-letter, cancelled and reconciliation-required states;
- plain-language summary, affected object, attempts, next retry, last safe error and correlation ID;
- authorised retry/cancel/reconcile actions;
- provider operation detail without exposing secrets/raw sensitive payload by default.

Routine successful work ages out of the default view; failed/ambiguous work remains visible until resolved/acknowledged. The global indicator counts current actionable operations, not all historical jobs.

---

## 10. Onboarding and first value

Onboarding is a resumable workspace state machine, not a blocking tour over every module.

### 10.1 Owner-created workspace

1. **Workspace basics:** name, timezone, locale, currency. Explain that scheduling and reporting use this timezone.
2. **Brand foundations:** use the existing Relaunch72 intake/brand brain if available, or enter minimum logo/voice/offer details. Generation is optional; do not block CRM.
3. **CRM start:** import CSV or create first contact; confirm default pipeline. Show duplicate preview before commit.
4. **Choose first outcome:** `Manage leads`, `Plan social content`, `Handle conversations`, or `Run a webinar`. This determines the next setup path.
5. **Connect only what that outcome needs:** provider OAuth/API setup with scopes and environment clearly shown.
6. **Invite teammates:** suggested roles and exact access summary.
7. **Complete one real loop:** e.g. contact → opportunity → task, or approved post → one sandbox/test target. Show success from authoritative state.

Users can skip optional steps and return from Home. Each checklist item has `not_started | in_progress | waiting_external | complete | blocked`, owner, safe reason and route. Completion comes from domain state—not a browser-only checkbox.

### 10.2 Invited member

An invited marketer/sales user sees:

1. claim invitation and choose password/session;
2. workspace identity and role/access summary;
3. a three-step contextual tour of their permitted Home/module;
4. their first assigned task/conversation/approval if one exists.

They do not see billing, branding or connection prompts they cannot act on.

### 10.3 Sandbox and test outbound safety

Current code protects mock AI spend, but product UX must also distinguish external side effects. In sandbox/test environments:

- outbound email/message/social/webinar effects default off;
- an owner/admin may enable a provider-specific test mode only when the backend policy allows it;
- test destinations/accounts are allowlisted and shown on the final review;
- every affected screen carries `Sandbox` and recipient/account labels;
- templates/drafts may be previewed without sending;
- a live provider connection in a sandbox does not silently make all actions live.

This policy belongs in command authorization/outbox dispatch as well as presentation. A badge alone is not a safety control.

---

## 11. Truthful state, loading, empty and error design

### 11.1 Shared async state model

Use these product states consistently:

| State | Meaning | UI behaviour |
|---|---|---|
| `idle/draft` | Exists only in Relaunch72; no provider effect requested. | Editable; “Draft.” |
| `queued` | Durable job/operation committed, not yet claimed. | Operation link; cancel only when safely supported. |
| `running` | Worker owns a valid lease. | Progress/activity and last heartbeat where useful; navigation remains available. |
| `retry_wait` | Transient failure; durable next attempt scheduled. | Reason, next retry, attempts; optional authorised retry now. |
| `succeeded` | Internal work committed or provider effect confirmed as required. | Completion timestamp/source. |
| `failed/dead_letter` | No automatic attempts remain or permanent validation failed. | Actionable safe reason, repair/retry path, correlation ID. |
| `reconciliation_required` | Provider effect may have occurred but confirmation is ambiguous. | “Checking provider”/manual reconcile; block duplicate effect by default. |
| `cancelled` | Work stopped before a disallowed effect, or provider cancellation confirmed. | Who/when and downstream status. |
| `stale` | Last known data exists but refresh/connection is late. | Keep usable data, show last successful sync and refresh/reconnect. |
| `partial` | Some targets/sources succeeded and others did not. | Aggregate plus per-target/source details; never one false green badge. |

### 11.2 Page-state matrix

Every list/detail screen implements these cases deliberately:

| Case | Required presentation |
|---|---|
| Initial load | Shape-matched skeleton only when the structure is predictable; otherwise compact labelled progress. Preserve page title/navigation. |
| Background refresh | Keep prior data, subtle `Refreshing…`; never blank the page. |
| First-use empty | Explain the value, prerequisite and one permitted primary action. Example: “No opportunities yet. Create one or capture a lead.” |
| Filtered empty | “No results match these filters,” with Clear filters. Never show setup marketing. |
| Search empty | Echo safe query text and suggest scope/filter changes. |
| No permission | Explain access limitation and who can grant it, without leaking whether a forbidden object exists. |
| No entitlement | Route to plan/capability information only for actors who may view billing; otherwise contact-admin copy. |
| Setup required | Name the exact missing connection/configuration and one resolution action. |
| Provider degraded | Keep last known state, show affected capabilities, last success and incident/reconnect action. |
| Partial response | Render successful targets/sections and isolate failed ones with retry. |
| Request error | Plain-language safe message, Retry, correlation ID; technical detail only in authorised Operations. |
| Offline/browser network loss | Preserve unsent form draft locally where safe; never label a command submitted until server receipt. |

Skeletons stop after a bounded request timeout and become an error/retry state. Endless shimmer is prohibited.

### 11.3 Command feedback

- Synchronous validation returns inline field/object errors and moves focus to the summary.
- Accepted async commands return `202` plus command/operation ID and authoritative object version/location.
- Use a short toast for acknowledgement (“Post queued for 3 accounts”) with an Operations link; the durable status remains on the object/Operations page after the toast disappears.
- A submit control prevents duplicate browser clicks, while server idempotency handles refresh/retry/multi-instance races.
- Optimistic UI is allowed only for reversible local presentation such as assignment or board position, and always reconciles against row version. Never optimistically claim sent, published, paid, attended or delivered.
- Error copy distinguishes: fix input, reconnect provider, wait for automatic retry, request permission, contact support, or manual reconciliation.

### 11.4 Status vocabulary

Use one shared `StatusChip` component with text + icon + colour. Reserve:

- neutral: Draft, Not started, Closed;
- blue/in-progress: Queued, Running, Scheduled, Syncing;
- green/confirmed: Approved, Published, Delivered, Active, Complete;
- amber/attention: Needs approval, Retry scheduled, Stale, Partial, Payment due;
- red/action required: Failed, Disconnected, Suppressed, Dead letter;
- purple/explicit simulation: Mock, Sandbox, Preview.

Provider-specific raw values appear in detail/evidence, not as the only customer label.

---

## 12. White-label boundaries

### Organisation-controlled

- product display name;
- primary logo, compact mark and favicon;
- restrained accent/link/focus token chosen from an accessible generated scale;
- custom verified portal/funnel/forms/tracking domains;
- support email/link and help copy;
- customer-facing email header/footer templates within approved compliance blocks;
- workspace-specific identity/content beneath the organisation shell.

These map to `organization_branding` and verified `organization_domains` from document 15 (§5.1).

### Platform-controlled

- semantic status colours and icons;
- spacing, typography scale, component behaviour and accessibility;
- security/account recovery text;
- privacy, consent and legal/compliance content that must not be removed;
- provider attribution, OAuth consent identity and external-provider links;
- environment/mock/sandbox labels;
- operational error semantics and correlation identifiers;
- platform-admin experience.

No arbitrary organisation CSS or JavaScript in the first release. Theme tokens are validated for contrast and safe URL/assets; uploaded logos are scanned/normalised and served from private/versioned storage as appropriate. A brand accent never recolours success/warning/error semantics.

### Settings ownership

| Setting | Owner/scope |
|---|---|
| Product brand/domain/support | Organisation owner/admin with branding permission |
| Workspace name/timezone/locale/currency | Workspace owner/admin |
| Social/messaging/webinar connection | Workspace connection manager |
| Platform subscription | Organisation owner/billing role |
| User locale/theme/notifications | Individual user |
| Legal/provider identity | Platform/provider; visible but not white-labelled away |

As document 15 requires, reusable packages can power other owned products, but separate top-level products should use separate databases initially. White-label organisation branding is not permission to merge PropInvestUK, Ordris and Relaunch72 customer data into one vague tenant plane.

---

## 13. Responsive and accessibility contract

### 13.1 Responsive layouts

Use capability/container breakpoints based on available route width rather than device names:

| Available width | Shell | Dense modules |
|---|---|---|
| `>= 1200px` | Full 232–248px rail, top command bar. | Inbox/listening three panes; planner grid; detail drawer. |
| `768–1199px` | Collapsible icon rail; workspace name in top bar. | Two panes, context becomes drawer; board horizontally paged with list toggle. |
| `< 768px` | Top bar + route title; navigation drawer; optional bottom actions for current task. | One pane at a time; tables become priority rows/cards; composer preview is a tab; sticky safe-area-aware primary action. |

Rules:

- No core action requires hover.
- Never shrink a desktop data table until it becomes illegible; select priority columns and provide row detail.
- Kanban always has a list view and stage-move menu.
- Planner always has agenda/list view.
- Inbox browser navigation preserves queue/filter/scroll state.
- Modal dialogs become full-screen sheets when the viewport cannot safely contain them.
- Avoid two simultaneous drawers/sheets.
- Media previews reserve aspect-ratio space to prevent layout shift.

### 13.2 Accessibility baseline

Release gate is WCAG 2.2 AA for authenticated and public flows:

- semantic landmarks, headings, lists, tables and form associations;
- keyboard access to every action, with logical tab order and visible focus;
- skip link to route content and focus restoration after navigation/dialog closure;
- status communicated by text/icon, never colour alone;
- minimum 4.5:1 body text contrast and 3:1 large text/UI boundaries;
- minimum 44×44 CSS-pixel pointer target for primary mobile controls, with safe spacing;
- errors summarised and associated to fields; focus moves to the error summary after submit;
- `aria-live` used sparingly for command acceptance/status, not every polling update;
- reduced-motion support and no essential information encoded in animation;
- combobox/menu/dialog/grid patterns follow native semantics where possible;
- canvas-only charts/builders are prohibited without an equivalent structured representation;
- social media alt text can be authored and previewed per target;
- media/video includes captions/transcript fields and honest availability states;
- all dates show timezone context; machine values remain valid `datetime` attributes;
- user-visible copy is localisable; do not concatenate translated fragments in manifests.

The current working tree's shared `pageHead`/`appShell` now supplies a language attribute, skip link, main landmark, reduced-motion and forced-colour handling (`orchestrator/src/portal/ui.ts:99-107,127-183`). Treat that as the seed, not the completed accessibility audit: route-specific forms, command palette semantics, focus restoration and dynamic status behaviour still need the gates below.

### 13.3 Accessibility testing

- automated HTML/accessibility scan on every representative route/state;
- keyboard-only test for navigation, command palette, board/list movement, composer and Inbox reply;
- screen-reader smoke tests for Windows/Chrome and iOS/Safari before public launch;
- 200% and 400% zoom/reflow checks;
- light/dark/high-contrast theme checks for every brand token set;
- no test passes solely because hidden desktop and mobile variants duplicate IDs/labels.

---

## 14. Performance and reliability budgets

The current dependency-free HTML is a good baseline. Do not erase it with a client bundle for screens that only need links and forms.

### User-facing budgets (production p75 unless noted)

| Measure | Budget |
|---|---:|
| Authenticated HTML TTFB, excluding an explicitly surfaced provider dependency | ≤ 500 ms |
| LCP | ≤ 2.5 s |
| INP | ≤ 200 ms |
| CLS | ≤ 0.10 |
| Initial shared shell JavaScript | ≤ 140 KB gzip |
| Initial shared CSS | ≤ 50 KB gzip |
| Additional route interaction chunk | ≤ 90 KB gzip per route |
| Initial list/read-model JSON | ≤ 100 KB compressed target; 50 rows default |
| Route DOM | ≤ 1,500 rendered nodes initially; virtualise/segment high-volume lists |
| Command acknowledgement | ≤ 800 ms p75 to durable receipt, even when work continues asynchronously |

These are release budgets, not promises that provider completion happens within them.

### Implementation rules

- Return server-rendered shell and first useful read model together where possible.
- Use cursor/keyset pagination; never fetch all contacts/messages/posts to calculate one screen.
- Module read models project only visible fields; no `SELECT *`/full provider payload in list routes.
- Lazy-load avatars/media/previews and route-specific editors.
- Do not preload planned/disabled module code.
- Use one shared Operations event stream (SSE or bounded backoff polling) rather than every widget polling its own endpoint.
- Pause/reduce refresh in background tabs; reconnect with jitter.
- Cache immutable brand assets/content versions with hashes; customer data HTML/API stays private/no-store or appropriately revalidated.
- Use ETags/row versions for read models and commands.
- Run expensive counts/analytics from indexed projections, not correlated queries in the route.
- Keep provider network calls out of page-render database transactions. Render last known state and enqueue refresh when needed.
- Performance telemetry is partitioned by route/module/environment and excludes raw PII/message content.

---

## 15. Design system and reusable interaction contracts

### Foundation tokens

- neutral surface/elevation/border/text scales;
- semantic info/success/warning/danger/mock tokens;
- organisation accent scale with validated contrast pairs;
- spacing, radius, typography and shadow tokens;
- motion duration/easing with reduced-motion variants;
- density `comfortable | compact` as a user preference for data-heavy screens.

### Required primitives

```text
AppShell, OrganizationWorkspaceSwitcher, PrimaryNav, ModuleTabs
CommandPalette, GlobalCreateMenu, OperationsIndicator
PageHeader, Breadcrumbs, EnvironmentBadge, CapabilityBanner
Button, IconButton, Link, Menu, Tabs, Dialog, Drawer, Tooltip
Field, ErrorSummary, Combobox, DateTimeField, TimezoneLabel
DataTable, CursorPager, FilterBar, SavedViewMenu, BulkActionBar
Board + AccessibleListAlternative, Calendar + AgendaAlternative
StatusChip, AsyncState, EmptyState, InlineError, StaleDataBanner
ObjectLink, ObjectPicker, ContextDrawer, ActivityTimeline
Composer, TargetSelector, ProviderPreview, ApprovalPanel
OperationLink, RetryPanel, ConfirmationReview
```

Primitives contain accessibility and truth behaviour; modules provide labels/data/actions. Modules may not invent new meanings for green/red or new spinner/toast systems.

### Common mutation contract

Every command form/client action sends:

- CSRF proof/session context;
- stable command type/version;
- `Idempotency-Key` for create/send/publish/import/generate operations;
- object ID and expected row version for updates;
- safe return location;
- explicit live/sandbox mode where the command permits both.

Every accepted response provides:

- command receipt/operation ID;
- affected canonical object ID/version when known;
- immediate authoritative state;
- status URL or embedded operation summary;
- idempotent replay result for the same request hash.

---

## 16. Exact code seams

Do not introduce a separate frontend repository yet. The current server composition already mounts `/portal` and `/admin` through one HTTP app (`orchestrator/src/server/app.ts:158-169`), and the portal's dependencies are injectable (`orchestrator/src/portal/router.ts:15-37`). Extend those seams.

### 16.1 Keep and extend current platform contracts

```text
orchestrator/src/platform/
  capabilities.ts             # existing stable entitlement/provider capabilities
  events.ts                   # existing versioned event envelope/catalogue
  modules.ts                  # existing manifest/registry; extend without breaking IDs
  permissions.ts              # PermissionKey, default role profiles, decision types
  setup-requirements.ts       # typed requirement/result contracts
  objects.ts                  # canonical object types + route/link contracts
  commands.ts                 # command contributions and mutation envelopes
  search.ts                   # search contribution/result contracts
  resolve-product.ts          # authoritative manifest × entitlement × permission × readiness
```

Near-term changes to `modules.ts`:

- retain `PlatformModuleId`, ordering, lifecycle/dependency validation;
- rename/clarify `requiredCapabilities` as entitlements or add a separate field;
- add read permissions, setup requirements, tabs, commands, object/search contributions;
- make planned modules absent from normal `navigation()` output by default;
- support route templates under `/portal/w/:workspaceSlug` instead of `#` placeholders;
- preserve a compatibility mapping from `/portal`, `/portal#crm`, `/portal#content` and `/portal/billing` during migration.

### 16.2 Extract portal rendering

```text
orchestrator/src/portal/ui/
  document.ts                 # lang/meta/CSP-safe document frame
  shell.ts                    # AppShell and resolved navigation
  tokens.ts                   # validated theme tokens → CSS variables
  render.ts                   # escaping/attribute/URL helpers
  assets.ts                   # hashed CSS/JS asset resolution
  components/
    async-state.ts
    status-chip.ts
    data-table.ts
    filters.ts
    forms.ts
    context-drawer.ts
    operation.ts
  modules/
    overview.ts
    crm.ts
    content.ts
    social.ts
    inbox.ts
    listening.ts
    webinars.ts
    automations.ts
    analytics.ts
    settings.ts
```

`orchestrator/src/portal/views.ts` becomes a temporary compatibility façade that calls the new renderer for login, current Home/dashboard and billing. Do not copy its embedded `STYLE` string into ten module files.

Move shared CSS and small JavaScript to versioned assets. Tighten CSP toward `style-src 'self'` and `script-src 'self'`/nonces as inline styles are removed; keep form-based operation when JavaScript is absent for core CRM/settings actions.

### 16.3 Routes and read models

```text
orchestrator/src/portal/routes/
  route-table.ts              # method + template + module + read/action permission
  workspace.ts                # resolve/switch selected workspace
  overview.ts
  crm.ts
  content.ts
  social.ts
  inbox.ts
  listening.ts
  webinars.ts
  automations.ts
  settings.ts
  operations.ts

orchestrator/src/read-models/
  workspace-home.ts
  crm-list.ts
  contact-detail.ts
  social-planner.ts
  inbox-list.ts
  conversation-detail.ts
  webinar-detail.ts
  automation-runs.ts
  operations-list.ts
```

`orchestrator/src/portal/router.ts` remains the top-level auth/dispatch adapter temporarily, but delegates to a declarative route table. It must resolve the opaque user session and selected workspace described in document 15 before dispatch. Route handlers receive `RequestContext`; they never accept a second untrusted workspace owner from form/JSON.

`orchestrator/src/portal/data.ts` is split into the read models above. Keep `makeDashboard` only as a file-adapter compatibility path until document 15 PR2/PR5 cut over CRM/artifacts.

### 16.4 Browser/API boundary

Use same-origin, workspace-scoped endpoints behind the portal session:

```text
GET  /portal/w/:ws/api/v1/product-contract
GET  /portal/w/:ws/api/v1/search?q=&cursor=
GET  /portal/w/:ws/api/v1/contacts?view=&cursor=
POST /portal/w/:ws/api/v1/commands/contacts.create
POST /portal/w/:ws/api/v1/commands/opportunities.move
POST /portal/w/:ws/api/v1/commands/social.publish
POST /portal/w/:ws/api/v1/commands/messages.send
GET  /portal/w/:ws/api/v1/operations/:id
GET  /portal/w/:ws/api/v1/operations/stream
```

The workspace route segment is checked against the selected session context and membership; database RLS is still final isolation. Commands call domain services/repositories from document 15, not provider adapters directly. Public forms/webinar registration use separate token/host-resolved commands and never share these authenticated endpoints.

### 16.5 Tests to add

```text
orchestrator/test/product-contract.test.ts
orchestrator/test/permission-resolution.test.ts
orchestrator/test/portal-shell.test.ts
orchestrator/test/portal-route-guard.test.ts
orchestrator/test/truth-states.test.ts
orchestrator/test/white-label-theme.test.ts
orchestrator/test/a11y-render.test.ts
orchestrator/test/responsive-contract.test.ts
orchestrator/test/e2e/crm-first-loop.test.ts
orchestrator/test/e2e/social-partial-publish.test.ts
orchestrator/test/e2e/inbox-ambiguous-send.test.ts
```

Keep the existing platform module tests. Add checks that planned modules never appear in default navigation, permission and entitlement types cannot be mixed, direct routes enforce the same resolver, and workspace switching clears/keys browser caches by workspace.

---

## 17. Delivery phases aligned to the PostgreSQL foundation

Do not let visual breadth outrun data correctness. The order below intentionally tracks document 15 §14.

### UX phase 0 — contract and truth primitives (can start now)

- Stabilise the current platform capability/event/module contracts.
- Add permission/setup types and server resolver tests.
- Finish the new document frame/tokens/shell seam; extract StatusChip, AsyncState, EmptyState and OperationLink from it rather than growing `portal/ui.ts` indefinitely.
- Wrap the current `/portal` dashboard/billing in the shell without changing data storage.
- Show only Overview, CRM read preview, Content preview and Settings/Billing that are truthful now; planned modules remain out of daily navigation.

**Exit:** existing portal behaviour/tests remain; shell renders from a resolved contract; no new screen claims a missing backend.

### Foundation phase 1 — identity/workspaces (document 15 PR1–PR2)

- PostgreSQL identity/workspace/memberships/RLS and opaque sessions.
- Real workspace switcher and organisation aggregate overview.
- Portal read models from PostgreSQL; current artifact preview remains compatibility-labelled.
- Permission-filtered navigation and direct-route guards.

**Exit:** switching among two granted workspaces never leaks cached/server data; revocation removes access immediately.

### Foundation phase 2 — operations (document 15 PR3–PR5)

- Durable jobs/outbox/provider operations and pipeline/artifact metadata.
- Operations indicator/page and route-backed operation status.
- `Create content plan` enqueues; run/QA/artifact/sign-off states become real read models.
- Remove route-bound synchronous generation and filesystem-only status.

**Exit:** worker kill/retry/dead-letter/ambiguous external state is visible and recoverable; UI never claims success early.

### Product phase 1 — first sellable CRM loop (document 15 PR6)

- Contacts, companies, opportunities, tasks, consent, suppression, attribution and dedupe.
- Contacts list/detail, opportunity board/list and Home work queue.
- Public lead capture creates/dedupes Contact + consent + attribution + opportunity/task in one command.
- CSV import preview and reconciliation.

**Exit:** real lead → contact → opportunity → stage → task → measured value works without demo seed, with two-workspace isolation and accessible mobile/keyboard flows.

### Product phase 2 — content + approval

- Database/object-backed content library, versions, QA, approval and calendar.
- Brand brain and current generation artifacts move from dashboard cards into canonical content records.
- Approval work queue and immutable version decisions.

**Exit:** an approved exact content version can be selected downstream; mock/live provenance cannot be lost.

### Product phase 3 — social publishing

- Workspace OAuth/provider connection and account capability/scopes.
- Composer, planner/agenda, approval, one target per account, durable publish jobs and webhook/poll reconciliation.
- Per-target partial/unknown/failure states and Operations integration.

**Exit:** draft → approve → schedule → provider-confirmed per-target outcome works on one proven live adapter; duplicate clicks/retries do not duplicate a confirmed post.

### Product phase 4 — Inbox + WhatsApp

- Conversations/messages/inboxes/endpoints and one proven messaging provider.
- Provider webhooks, contact linking, assignment/unread, consent/suppression policy and delivery reconciliation.
- Three-pane/one-pane Inbox and provider-policy-aware composer.

**Exit:** inbound message → deduped conversation/contact → assignment → authorised reply → provider-confirmed delivery/failed/unknown is durable and replay-safe.

### Product phase 5 — Webinars

- Webinar/session/registration/attendance schema and one provider mode.
- Public registration, contact/consent/attribution command, provider sync and event detail.
- Reminder/follow-up recipes and attended/no-show/unknown segmentation.

**Exit:** registration through attendance/no-show follow-up has one contact identity, idempotent webhooks and truthful sync health.

### Product phase 6 — Automations, listening and analytics

- Guardrailed recipe editor/versioning, enrollments, steps and run history.
- Listening only for proven provider sources with explicit coverage.
- Analytics projections built from real events/provider facts, with source/updated time.
- Consider a visual automation editor only after recipe runtime/recovery is proven.

**Exit:** every report value links to a defined source/projection; every automation step links to durable operation state.

---

## 18. First executable implementation slice

The next UX implementation should be deliberately narrow and compatible with the in-progress platform contracts:

1. **Extend contracts, not pages first.** Add `permissions.ts`, `setup-requirements.ts` and a resolver that takes manifests, entitlements, actor permissions, provider/setup state and environment policy. Update module tests.
2. **Harden and split the new shell.** Keep the document renderer, theme tokens, workspace header, nav and environment badge now present in `portal/ui.ts`; extract common async/empty/status components and make navigation consume the authoritative resolver rather than static lifecycle lists. Keep current login setup separate initially.
3. **Render current truth through it.** `/portal` redirects to or renders `/portal/w/:legacy-or-selected-workspace/home`; Home uses current dashboard data but separates CRM summary, generated drafts and activity into named sections. Preserve every mock/not-published label.
4. **Expose only real destinations.** Home, read-only/current CRM summary, Content preview and Billing/Settings. Do not link Social, Inbox, Listening, Webinars or Automations in the daily nav yet.
5. **Add route and resolver parity tests.** If navigation hides a module/action, direct route and command must produce the correct 404/403/setup response. Add keyboard/HTML semantics checks for the shell.
6. **Then wait for document 15 PR2 for real switching.** The current cookie still carries one tenant ID (`orchestrator/src/portal/router.ts:98-159`); do not fake a multi-workspace selector over it.

This slice creates visible product coherence without depending on unfinished CRM tables or providers. It also gives every following vertical slice the same shell, state, permission and operation vocabulary.

### Migration order

```text
Current /portal routes + current file read model
  → shared shell and compatibility route aliases
  → PostgreSQL user/session/workspace selection (doc 15 PR1–2)
  → durable operation status (doc 15 PR3–5)
  → CRM read/write module (doc 15 PR6)
  → content approval
  → social publishing
  → Inbox/WhatsApp
  → webinars
  → automation/listening/analytics
  → remove legacy /portal hash routes and file dashboard adapter
```

Keep old URLs as server redirects for at least one release after their new destination is stable. Do not maintain two independently editable UIs over the same object.

---

## 19. Acceptance criteria

### Product shell and IA

- [ ] A user can identify organisation, workspace, environment and current module on every authenticated route.
- [ ] Navigation contains only resolved modules; planned modules do not appear as ready/usable.
- [ ] There is one global Create menu, Connections home, Settings home and Operations status surface.
- [ ] Primary/module navigation never exceeds two levels.
- [ ] Browser Back/Forward preserves meaningful list filters, selected conversation/item and drawer routes.
- [ ] Current `/portal` and billing links redirect/resolve without breaking existing customers.

### Tenancy and permission

- [ ] Workspace switch is CSRF-protected, membership-checked and updates the opaque selected workspace session.
- [ ] Browser caches/query keys include workspace ID; switching clears workspace-sensitive local state.
- [ ] Navigation, direct route and command use the same resolver/authorization source.
- [ ] Removing a membership/permission prevents the next read/action without waiting for cookie expiry.
- [ ] Organisation aggregate drill-down selects one explicitly granted workspace before fetching detail.
- [ ] Billing-only organisation members cannot read CRM/messages.
- [ ] Platform support access is time-limited, reasoned and audited.

### Truth and operations

- [ ] Mock, sandbox, preview, stale and live data cannot share an unlabeled visual state.
- [ ] A POST acknowledgement never renders sent/published/delivered/attended as complete without authoritative confirmation.
- [ ] Multi-target social operations show per-target outcomes and partial failure.
- [ ] Ambiguous provider effects block casual duplicate retry and expose reconciliation.
- [ ] Every async operation has stable ID, object link, attempts, safe error and authorised recovery path.
- [ ] No page shows an endless spinner or generic empty state for setup, permission, filtered-empty or provider-failure cases.

### CRM

- [ ] Contact and Opportunity are distinct; one contact can own multiple opportunities.
- [ ] Stage moves use expected row version and reject/reconcile conflicts.
- [ ] Lead capture/import shows dedupe, consent and attribution outcome.
- [ ] Contact timeline differentiates notes, messages, webinar facts, content and automation operations.
- [ ] Accessible list alternatives exist for pipeline board and dense data.

### Social and listening

- [ ] Composer validates each selected target and preserves per-target customisation/version.
- [ ] Scheduling always displays workspace timezone and resulting target time.
- [ ] Approval references an exact content/post version.
- [ ] Provider-confirmed IDs/status/times are stored and visible per target.
- [ ] Enabling a publishing/scheduling rail grants only its declared provider capabilities; Inbox replies and Listening remain unavailable/setup-required until separately proven.
- [ ] Network app-review tier, scopes and limitations are persisted as connection readiness and survive deploy/restart.
- [ ] Listening displays source coverage and last successful sync; it does not claim unsupported networks or whole-web reach.

### Inbox + WhatsApp

- [ ] Inbound provider retry creates one message/conversation event.
- [ ] Reply checks endpoint, provider policy, consent, suppression, permission, environment and usage before queueing.
- [ ] WhatsApp policy/template requirement is adapter-driven, not hard-coded in view copy.
- [ ] Conversation assignment/unread/close state works across two operators without last-write-wins loss.
- [ ] Mobile queue → thread navigation preserves context and has no required horizontal scroll.

### Webinars and automations

- [ ] Registration atomically creates/dedupes contact, consent, attribution and registration before provider sync.
- [ ] Attendance webhooks are idempotent and preserve unknown/unmatched states.
- [ ] Published automation versions are immutable; edits create drafts/new versions.
- [ ] Recipe test mode produces no outbound effect unless an explicit backend-controlled allowlist permits it.
- [ ] Failed step replay does not duplicate completed provider effects or reenrol the same subject/event.

### White label, accessibility and performance

- [ ] Organisation brand can change allowed tokens/assets/domain/support without changing semantic status colours or legal/provider truth.
- [ ] Every allowed brand passes contrast/focus checks in light/dark modes.
- [ ] Representative routes meet WCAG 2.2 AA automated and manual keyboard gates.
- [ ] Board/calendar/composer/inbox have usable mobile and non-pointer alternatives.
- [ ] Production p75 meets the budgets in §14; budget failures block release or carry an explicit approved exception with expiry.
- [ ] No planned module JavaScript/data is loaded on the default Home route.

### End-to-end release gate

A release claiming “CRM + social machine” must demonstrate, in two isolated workspaces:

```text
public lead/form
→ contact + consent + attribution
→ opportunity + task
→ approved content
→ social post scheduled to multiple targets
→ provider-confirmed partial/full outcome
→ inbound reply/mention linked to conversation/contact
→ assigned follow-up
→ every async step visible in Operations and the typed timeline
```

If a webinar is marketed as included, extend the same proof through registration → provider sync → attendance/no-show → follow-up recipe. A polished empty card is not acceptance evidence.

---

## 20. Non-goals for the first product release

- A generic drag-anything page/funnel builder.
- An arbitrary executable plugin marketplace.
- A free-form automation canvas before recipes, versioning and recovery are proven.
- Native video infrastructure when external/embedded webinar modes meet the first outcome.
- Whole-web social listening claims.
- Cross-workspace raw contact/message search in the agency overview.
- Customer-supplied CSS/JavaScript.
- Optimistic “AI agent sent it” behaviour without approval, consent, suppression and provider evidence.
- Rebuilding the existing server-rendered portal as a large SPA solely for visual fashion.
- Showing every future GHL feature in navigation before it earns an end-to-end vertical slice.

---

## 21. Final recommendation

Build the **shell and truth contract once**, then earn each module vertically. The most valuable sequence is:

1. real workspace identity/isolation;
2. real CRM loop and work queue;
3. durable Operations/content approval;
4. one proven social publishing adapter;
5. one proven shared Inbox/WhatsApp adapter;
6. webinar registration/attendance;
7. controlled automations, listening and real analytics.

That route gives Relaunch72 an unmistakable product identity: a calm operational workspace where CRM context, on-brand creation, social publishing, conversations and events meet—without hiding complexity behind fake green statuses or burying users in a GHL-style settings maze.
