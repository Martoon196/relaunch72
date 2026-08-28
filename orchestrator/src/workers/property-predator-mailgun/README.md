# Property Predator Mailgun worker activation boundary

The default email worker remains dark: it creates no provider adapter and runs
no poll loop. The live internal-seed mode is available only when every runtime
and database control is explicitly active, the emergency pause is released,
and the exact recipient/caps remain `office@propertypredator.com`, one recipient
per run, and three messages per UTC month.

Use a Mailgun **Domain Sending Key** for `mg.propertypredator.com` wherever the
account supports it. The worker deliberately rejects a broad account API key,
uses only `https://api.eu.mailgun.net`, and never receives the Mailgun webhook
signing key. The signing key belongs to the web ingress service only.

Mailgun provider suppression-list proof is a manual activation check in the
Mailgun web account. This worker does not call or mirror Mailgun suppression
APIs. Growth HQ's own current consent and suppression evidence is still checked
atomically before every provider call, and signed webhooks append later bounce,
complaint and unsubscribe evidence.

An ambiguous or lost HTTP response is never retried. The caller-set Message-ID
is persisted before the call so the signed webhook path can reconcile it. HTTP
408 and 5xx responses are ambiguous too: they enter reconciliation instead of
being recorded as definitive failures. Claims and recovery are restricted to
the configured provider connection; stale-month and exhausted pre-call jobs
terminate without invoking Mailgun.

Temporary failure webhooks remain nonterminal and cannot settle the worker job.
Accepted, delivered, read and permanent-failure receipts reconcile the pilot
reservation, provider operation, delivery and worker job in one transaction
with exact row-count fences. A Mailgun response Message-ID is authoritative;
the deterministic caller-set ID is only the ambiguous-response fallback.

Default background and cycle failures emit one-line JSON telemetry containing
only a fixed safe error class and a process-local monotonically increasing
counter. Provider/database error messages, URLs, recipients and credentials are
never written to worker logs.
