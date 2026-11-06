# Relaunch72 Publisher & SEO (WordPress plugin)

- Source: `relaunch72-publisher/` (PHP 7.4+, WordPress 6.4+). Protocol, supported configurations, security, installation and rollback: [docs/seo-blog-wordpress.md](../docs/seo-blog-wordpress.md).
- Installable ZIP: `dist/relaunch72-publisher-<version>.zip` plus `.sha256`. Rebuild deterministically with `node wordpress-plugin/build-zip.mjs` (sorted entries, fixed timestamps: the same source gives the same digest).
- `test-harness/` is a **disposable** WordPress Playground harness. Its mu-plugin exposes a token-protected test-control route and fakes image downloads; never install it on a real site.

## Disposable WordPress e2e

```bash
SEO_PLUGINS_DIR=/path/to/unzipped-seo-plugins wordpress-plugin/test-harness/boot.sh 9400   # wait for "Ready!"
cd orchestrator
WP_E2E_SCENARIO=standalone node --import ./test/windows-node24-shim.mjs --import tsx --test test/manual-wordpress-plugin.e2e.ts
```

Scenarios: `standalone`, `rank_math`, `yoast`, `hold` (both SEO plugins active), `lifecycle` (deactivate, reactivate, uninstall; run last because it removes plugin settings). `WP_VERSION=6.4 PHP_VERSION=7.4` boots the minimum supported versions.
