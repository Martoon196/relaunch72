#!/bin/bash
# DISPOSABLE WordPress (WordPress Playground) for the Relaunch72 Publisher e2e.
# Usage: wordpress-plugin/test-harness/boot.sh [PORT]
# Optional: SEO_PLUGINS_DIR=<dir containing seo-by-rank-math/ and wordpress-seo/ unzipped
#   from https://downloads.wordpress.org/plugin/<slug>.latest-stable.zip> enables the
#   rank_math / yoast / hold scenarios. Needs `npx @wp-playground/cli` (network on first run).
set -e
cd "$(dirname "$0")"
H="$(pwd -W 2>/dev/null || pwd)"; P="$(cd ../relaunch72-publisher && (pwd -W 2>/dev/null || pwd))"
PORT=${1:-9400}
EXTRA=()
if [ -n "$SEO_PLUGINS_DIR" ]; then
  EXTRA+=(--mount-dir "$SEO_PLUGINS_DIR/seo-by-rank-math" /wordpress/wp-content/plugins/seo-by-rank-math)
  EXTRA+=(--mount-dir "$SEO_PLUGINS_DIR/wordpress-seo" /wordpress/wp-content/plugins/wordpress-seo)
fi
MSYS_NO_PATHCONV=1 exec npx --yes @wp-playground/cli@3.1.62 server --port=$PORT --site-url=https://wp.test --workers=6 --login \
  ${WP_VERSION:+--wp=$WP_VERSION} ${PHP_VERSION:+--php=$PHP_VERSION} \
  --mount-dir "$P" /wordpress/wp-content/plugins/relaunch72-publisher \
  --mount-dir "$H/mu" /wordpress/wp-content/mu-plugins \
  --mount-dir "$H/fixtures" /r72-fixtures \
  --define R72_TEST_TOKEN harness-token-0123456789 --define-bool WP_DEBUG true --define-bool WP_DEBUG_LOG true \
  --blueprint=blueprint.json "${EXTRA[@]}"
