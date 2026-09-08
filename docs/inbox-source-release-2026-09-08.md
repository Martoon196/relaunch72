# Inbox source clarity — 8 September 2026

The Inbox now links workspace messages and follow-ups to the separate live social
source. The main Inbox performs no social-provider read. It says **Check on open**
until that source is actually opened. Live social distinguishes a successful read,
paused replies, disconnected accounts, permission failures and unavailable reads;
a failed read does not masquerade as an empty inbox.

DM and comment access uses the intersection of connected account evidence and the
configured account allowlist. Reply validation repeats exact account and platform
checks before creating any draft or delivery record. Existing approval and send
controls remain in place.

Responsive hero layouts and theme tokens keep both Inbox sources readable in
Light, Dark and System modes. The manual preview now serves the real appearance
script and supports the canonical social route.

Verification before integration: 2,956 tests passed, 38 database tests skipped,
and TypeScript typecheck passed. Root also verified authenticated fixture views
in Light and Dark. Root's final timestamp/dead-code cleanup requires the normal
focused integration rerun. No schema change or production message is part of this
package. Publication and exact live revision are recorded separately in the root
overnight BUILD-STATE document.
