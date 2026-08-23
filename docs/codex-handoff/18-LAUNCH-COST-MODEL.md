# 18 — LAUNCH COST MODEL

**Status:** planning model, not purchasing authority or a financial forecast.
**Verified:** 2026-08-24 against the official public prices linked below and the fuller evidence record in [17-WHITE-LABEL-PROVIDER-MATRIX.md](./17-WHITE-LABEL-PROVIDER-MATRIX.md).
**Currency rule:** vendor list prices remain in their published currency. GBP totals for infrastructure are planning allowances, not live exchange-rate conversions. Tax, VAT and foreign-exchange movement are excluded.

---

## 1. The honest answer

The Relaunch72 core can launch cheaply. The expensive categories are high-volume SMS, partner-resold WhatsApp, broad social listening and a customer-visible automation canvas.

The first pilot should therefore use invisible, usage-priced rails:

- Zernio for a tightly controlled social API pilot;
- Twilio transport behind Relaunch72's own WhatsApp inbox;
- Daily for embedded video;
- Amazon SES for email;
- Plivo for SMS, charged or capped by usage;
- Nylas for booking;
- Relaunch72 jobs and recipes for automations.

That combination has a public fixed vendor floor of roughly **$10/month** before usage: Nylas is $10/month for five connected calendar accounts, while the selected entry tiers for the other rails have no normal monthly platform minimum. Our application/database/storage/monitoring allowance is the larger early fixed cost.

Do not market the live service as “£0 to run.” The mock stack can run at negligible marginal vendor cost; a secure, backed-up, observable customer service cannot.

---

## 2. Public unit costs used in this model

| Rail | Public price used | Cost behaviour | Source |
|---|---:|---|---|
| Social pilot | First 2 connected accounts $0; accounts 3–10 $6 each/month; 11–100 $3; 101+ $1 | Per connected social account, with separate X pass-through calls | [Zernio pricing](https://zernio.com/pricing) |
| WhatsApp transport | $0.005 per message plus Meta template-message fees | Per message; customer WABA/onboarding and Meta charges remain separate | [Twilio WhatsApp pricing](https://www.twilio.com/en-us/whatsapp/pricing) |
| Embedded video | First 10,000 participant-minutes/month $0 | Usage after the free allowance; recording/streaming can add cost | [Daily pricing](https://www.daily.co/pricing/video-sdk/) |
| Transactional email | $0.10 per 1,000 outbound emails on SES à la carte | Usage, attachments and optional dedicated IP/support excluded | [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) |
| UK SMS | Starts at $0.0372 per outbound segment; listed carrier routes can be higher | Per segment, not per conversation; long/Unicode messages can consume several segments | [Plivo UK pricing](https://www.plivo.com/sms/pricing/gb/) |
| Booking | $10/month including 5 connected accounts; then $1.50/account/month | A grant that existed during the month can be billable for that month | [Nylas pricing](https://www.nylas.com/pricing/) |
| Default AI text | Claude Sonnet 4.6: $3 per million input tokens and $15 per million output tokens | Usage; prompt caching and eligible batch work can reduce it | [Anthropic Sonnet](https://www.anthropic.com/claude/sonnet) · [official list prices](https://www-cdn.anthropic.com/files/4zrzovbb/website/3684c2faafb97418665782cea0001f439f74b1d2.pdf) |
| AI image/video/transcription | GPT Image 2 is token-metered; Sora 2 720p is $0.10/second standard; mini transcription is estimated at $0.003/minute | Media generation must be a credit/add-on, not unlimited base usage | [OpenAI API pricing](https://platform.openai.com/pricing) |
| Broad listening | Brand24 Business $599/month on annual billing plus $99/month API add-on | High fixed floor; monthly Business billing is higher | [Brand24 pricing](https://brand24.com/prices/) · [API](https://brand24.com/social-listening-api/) |
| Self-hosted social fallback | Mixpost Enterprise $1,199 once for one business/domain | One-off licence plus hosting, upgrades, network apps and on-call work | [Mixpost pricing](https://mixpost.app/pricing) |
| Partner WhatsApp fallback | 360dialog Growth begins at €500/month; Premium is €1,000/month, plus channel/Meta charges | Fixed partner floor plus per-number and Meta usage | [360dialog partners](https://360dialog.com/partners) |
| Durable workflow upgrade | Temporal Cloud Essentials starts at $100/month | Fixed allowance plus actions/storage | [Temporal pricing](https://temporal.io/pricing) |
| Embedded visual automation | Activepieces Embed starts at $36,000/year | Commercial embedded licence, not a normal cloud-plan shortcut | [Activepieces pricing](https://www.activepieces.com/pricing) |

Published “starts at” telecom pricing is not a safe customer quote. Route, sender, carrier, geography, message encoding and failure rules must be measured in a real acceptance test.

---

## 3. Fixed platform allowance

These are Relaunch72 planning allowances rather than provider quotations:

| Stage | Application, PostgreSQL, object storage, backups, monitoring | Why it changes |
|---|---:|---|
| Private pilot, 1–2 customers | **£40–£120/month** | Small managed services, low storage, modest logs and one worker |
| Early launch, around 10 customers | **£100–£300/month** | Safer database tier, backups, worker capacity, monitoring and retained events |
| Growing service, around 50 customers | **£250–£750/month** | Higher availability, more workers/media, longer logs, support tooling and restore drills |

The lower edge is possible; the upper edge is the safer budget. These figures exclude founder/engineering labour, customer support, legal/privacy work, marketing spend and VAT.

### AI allowance

AI is metered, but ordinary text generation is not the dominant cost if the
product routes work intelligently and records every workspace's usage.

At the current Relaunch72 default, Claude Sonnet 4.6:

- 250,000 input plus 100,000 output tokens costs **$2.25**;
- 1 million input plus 500,000 output tokens costs **$10.50**;
- the second figure is a deliberately heavy monthly reserve for one active
  customer, not a promise that the product should burn that much.

Planning rule: hold **£5–£15 of AI cost per active customer/month** inside the
subscription, then enforce a workspace allowance. Use a cheaper model for
classification and summaries, Sonnet for customer-facing creation, prompt
caching for repeated brand context, and batch processing only where latency is
irrelevant. Premium reasoning, images and generated video consume separate
credits. A 60-second 720p Sora 2 generation is already **$6 before retries**, so
video cannot safely be an unlimited inclusion.

---

## 4. Worked operating scenarios

### 4.1 Private pilot — two customers

Assumptions:

- two connected social accounts in total;
- up to five connected calendars;
- fewer than 10,000 video participant-minutes;
- low email/message volume;
- no broad listening;
- no WhatsApp partner plan;
- no Mixpost purchase.

| Component | Monthly allowance |
|---|---:|
| Core platform | £40–£120 |
| Fixed vendor floor | $10 |
| AI text | about $4.50 at the baseline allowance; $21 at the heavy reserve |
| Email | approximately $0–$1 at ordinary pilot volume |
| Social | $0 before X pass-through calls |
| Video | $0 inside the published allowance |
| WhatsApp/SMS | metered and capped; passed through or protected by plan limits |

**Practical working budget: £75–£250/month**, allowing modest AI usage and headroom beyond the bare public minima.

### 4.2 Early launch — ten customers

Assumptions:

- three social connections per customer: 30 total;
- one calendar connection per customer: 10 total;
- 50,000 emails/month;
- WhatsApp usage is metered separately;
- SMS is not bundled without a segment allowance;
- no broad listening.

Calculated public rail costs:

- Zernio: 8 accounts × $6 plus 20 accounts × $3 = **$108/month**;
- Nylas: $10 plus 5 additional accounts × $1.50 = **$17.50/month**;
- SES: 50 × $0.10 = **$5/month**;
- Sonnet text: 10 × $2.25 = **$22.50/month** at the baseline allowance, or **$105/month** at the heavy reserve;
- illustrated rail/AI total before WhatsApp, SMS, X and video overage: **about $153–$236/month**;
- core platform allowance: **£100–£300/month**.

**Practical working budget: £250–£650/month before metered telecom and broad
listening.** At ten customers, this can remain well below the revenue from even
a modest £79–£149 base plan. Telecom usage and human support—not the
database—are the main margin risks.

### 4.3 Growing service — fifty customers

Assumptions:

- three social connections per customer: 150 total;
- one calendar connection per customer: 50 total;
- 250,000 emails/month;
- WhatsApp/SMS/video billed or capped separately;
- no assumption that one listening licence may legally serve every customer.

Calculated public rail costs:

- Zernio: 8 × $6 + 90 × $3 + 50 × $1 = **$368/month**;
- Nylas: $10 + 45 × $1.50 = **$77.50/month**;
- SES: 250 × $0.10 = **$25/month**;
- Sonnet text: 50 × $2.25 = **$112.50/month** at the baseline allowance, or **$525/month** at the heavy reserve;
- illustrated rail/AI total before WhatsApp, SMS, X, video overage and listening: **about $583–$996/month**;
- core platform allowance: **£250–£750/month**.

**Practical working budget: £700–£1,500/month before metered telecom and broad
listening.** This remains economically attractive, but a new provider's
unusually low rate card must not be treated as permanent. Product pricing should
survive a move to a dearer managed social provider.

---

## 5. The variable-cost traps

### AI and generated media

Text costs remain controllable only if retries, context size, model choice and
per-workspace totals are visible. Image and video costs are less predictable
because quality, duration and failed generations multiply usage.

Policy:

- include a named monthly AI allowance rather than “unlimited AI”;
- meter input, cached input, output and media separately by workspace;
- put a founder-visible hard cap above each customer cap;
- keep premium reasoning, images and video behind credits/add-ons;
- never let an autonomous retry loop spend without a bounded attempt count.

### SMS

At the published UK starting rate, 10,000 outbound segments would already be **$372**, and real carrier routes may be higher. A long message, emoji or non-GSM character can create multiple billable segments.

Policy:

- include a small explicit segment allowance, not “unlimited SMS”;
- show usage before sending a campaign;
- enforce workspace hard caps and quiet hours;
- charge overage or require prepaid credit;
- retain consent and opt-out separately from WhatsApp/email consent.

### WhatsApp

Twilio's markup makes 10,000 messages **$50** before Meta fees. Template category, destination market and Meta policy affect the rest.

Policy:

- price per connected number plus included usage;
- pass through or buffer Meta charges;
- keep WABA and number ownership with the customer wherever possible;
- move to direct Meta Cloud API only after the Tech Provider/app-review burden is justified;
- do not enter a €500–€1,000 partner plan merely to make the roadmap look complete.

### Broad social listening

The Brand24 API route begins around **$698/month** on annual Business billing before margin, tax and any contract limits on redisplaying source content. It is not a base-plan feature.

Policy:

- ship “Listening Lite” from connected-account comments, messages, mentions and reviews;
- sell broad listening only as a paid brand/project entitlement;
- confirm API redistribution rights and source coverage before quoting it;
- do not promise replies from a listening API that only returns monitoring data.

### Video and recordings

Participant-minutes can be cheap while recordings, storage, transcription and streaming are not. Registration, attendance, reminders and follow-up belong to Relaunch72; the video provider supplies the room.

Policy:

- default recording off;
- show participant-minute/recording allowances;
- set workspace spend caps;
- retain recording ownership, export and deletion rules.

---

## 6. Commercial packaging guardrails

The final selling prices require founder positioning and a real support-cost test. A safe first shape is:

| Product | Indicative price shape | Cost protection |
|---|---:|---|
| Core CRM + AI manager | £79–£129/month | Contacts, pipeline, tasks, strategy/content cadence; no unlimited telecom or broad listening |
| Growth + social publishing | £149–£249/month | Explicit number of social connections and scheduled posts |
| WhatsApp number | +£79–£129/number/month | Included message allowance plus overage/Meta-fee rule |
| SMS | Usage bundle or prepaid credit | Segment count, country and sender restrictions made explicit |
| Embedded webinar | Usage allowance/add-on | Participant minutes and recording storage capped |
| Broad listening | From £249/month or custom | Activated only when the underlying API contract and project economics work |

These are planning bands, not published offers. They preserve room for support, payment fees, VAT, provider price changes and a managed-provider migration.

---

## 7. Purchase gates

Do not buy or activate a provider until all of these are true:

1. a named customer workflow needs the rail;
2. the adapter acceptance test passes with reconciliation and disconnect;
3. SaaS/API/resale rights are confirmed for the exact customer-facing use;
4. DPA, subprocessors, data region, retention and deletion are acceptable;
5. a hard workspace spend cap exists;
6. the customer entitlement and overage rule exist;
7. canonical data can be exported without the vendor dashboard;
8. one backup provider is documented.

Immediate consequence: **no Mixpost, Brand24, 360dialog partner, Temporal Cloud or embedded automation licence is needed to finish and pilot the CRM.** Build the customer loop first; activate each paid rail only against real demand.
