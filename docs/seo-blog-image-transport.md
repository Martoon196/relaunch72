# SEO campaign image transport component

This isolated component makes one explicit `gpt-image-2` request using a scoped image credential supplied by the composition root. It reads no environment variables and has no database, filesystem, approval, publishing or account capabilities. It does not enable automatic generation or authorise spend.

The fixed request produces one opaque JPEG candidate, requested at 1536×1024 with medium quality and compression 85. Brand and actor identities must be opaque UUIDs; only their SHA-256 safety identifier reaches the provider. Prompts are limited to 8000 Unicode characters and 32 KiB UTF-8. Image references and URL inputs are unsupported.

The complete HTTP operation has a 240-second deadline, respects caller cancellation and rejects redirects. JSON streaming is limited to 12 MiB even when Content-Length is absent or false. Unsupported content encodings are rejected; the request asks for identity encoding. Exactly one canonical base64 image of at most 8 MiB is accepted, with JPEG SOI/EOI markers. No returned URL is fetched and no automatic retry occurs.

`candidate_received` means candidate bytes and provider evidence arrived. It does **not** mean measured dimensions, complete JPEG validity, content suitability, owner approval or publication. `requestedSize` records the request, not a measurement. The bytes use a private non-enumerable copy-on-access property. Optional model/size/format metadata is checked when present; missing usage remains unknown rather than zero. Counters are evidence, not an invoice. Provider request IDs are hashed; raw error bodies, credentials, revised prompts and generation prompts are not included in receipts. If candidate bytes are known before a metadata failure, the unknown-outcome receipt retains them for recovery.

Production integration must atomically reserve the existing brand allowance and operator concurrency/spend ceiling, record the provider start, then persist the returned candidate and receipt **before** decoding or cropping. Existing JPEG preparation then validates actual dimensions and full decoding in a recoverable local stage. A failed crop or lost receipt acknowledgement must not repeat the provider request. Any interruption, malformed response or server failure after transport starts is an uncertain paid outcome requiring that durable workflow. Known HTTP rejections remain distinct; neither classification grants a retry.

Focused tests use injected transports and actual JPEG fixture bytes. They make no provider call. This component and the separately reviewed JPEG preparation component still require integration and the full release gates before production use.


`prepareImageGenerationRequest` validates and freezes the exact request before admission, without a credential or network operation. Its wire SHA hashes the actual UTF-8 body, not a database reserialization. Body, prompt and opaque identities are private/non-enumerable; transport reuses the same preparation logic. The durable start boundary can therefore reserve the exact identity before any provider call.
