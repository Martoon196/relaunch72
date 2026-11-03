# Authority and AI visibility components

These isolated components prepare evidence for the integrated brand SEO programme. They do not enable paid research, create an earned link, send outreach, post to communities or promise AI placement. No live supplier call is used in their tests.

## Supplier inputs and evidence

The fixed DataForSEO domain-intersection adapter requests at most five competitors, excludes the brand and limits the response to 100 candidate domains. Supplier rank is preserved as rank; it is never relabelled traffic, relevance or proof that a page will link. A domain candidate still needs exact page and contact verification. Primary contract: [Domain Intersection](https://docs.dataforseo.com/v3/backlinks/domain_intersection/live/).

The current mentions adapter uses `search_mentions/live`, with explicit platform, market, language, date window and domain-source or answer-phrase scope. Dates filter the supplier's last response update, rather than pretending each returned answer was observed today. ChatGPT data outside the documented US/English scope returns unsupported without a request. Primary contracts: [Search Mentions](https://docs.dataforseo.com/v3/ai_optimization/llm_mentions/search_mentions/live/), [available filters](https://docs.dataforseo.com/v3/ai_optimization/llm_mentions/filters/).

Each indexed observation retains supplier dates separately from retrieval time, platform/model, question, bounded answer excerpt, source references and unused search results. A phrase appearing in an answer, the brand domain appearing among sources, and an unused retrieved result are separate facts. Missing or truncated evidence stays unknown where absence cannot be established. These observations do not establish a consumer's current result, market-wide ranking or referral traffic. Larger totals/continuation tokens mark an incomplete sample; the adapter never follows them.

## Transport and integration

Each invocation performs one request with explicit scoped credentials and no environment reads. The endpoint is fixed, redirects are rejected, the shared fetch/body deadline is at most 90 seconds and decoded JSON streaming is capped at 8 MiB. Content-Length is checked but never trusted as the only limit. Returned URLs are validated as public HTTP(S) evidence and never fetched. Top-level and task statuses, IDs and nonnegative reported costs are retained safely; missing costs remain unknown. These costs are evidence, not an invoice or permission to spend. A supplied request echo is checked against the sent scope; lack of an echo is explicit in the receipt.

Timeouts, interruption and malformed responses after request start remain uncertain outcomes, with no retry suggestion. Production composition must reserve the approved allowance and operator cap, persist a start nonce, then save the receipt through the durable programme boundary. Credentials alone grant no authority. Later integration must supply current brand/source/owner/lease checks, pause controls, idempotence, entitled endpoint readiness, private storage and approval UI. This source slice adds none of those shared runtime paths.

## Qualification and communities

The versioned qualifier accepts an explicit caller policy for traffic, spam indicator and evidence age. Each input fact is observed with source/date or unknown. Stale facts need refreshing; source rank cannot fill a missing traffic or contact field. A ready recommendation still needs exact owner review and has `sendingAllowed=false`. Paid/exchanged-link evidence is excluded. No guessed contact or email is created.

Reddit and Quora URLs remain held for platform-rule, identity and conversation-context review, even if labelled as editorial outreach. They can inform research and later drafts; there is no posting adapter here.

AI inclusion work should continue to improve useful, original content and ordinary technical discoverability. The current [Google guidance](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide) does not promise placement from a special file or mentions tactic. These components therefore expose evidence and uncertainty, not a fabricated optimisation score or guaranteed citation.

## Verification boundary

Focused tests cover exact request bodies, limits, deadlines/cancellation, safe failure/cost parsing, malformed scope and result URLs, brand-separated identities, incomplete samples, mention/source distinctions and honest qualification/community holds. The combined full application and database gates remain required when these components are actually wired into the programme.
