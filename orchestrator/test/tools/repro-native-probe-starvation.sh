#!/bin/bash
set -euo pipefail
: "${RL72_METHODS_PG_TEST_URL:?Use the disposable native schema}"
node --import tsx --test orchestrator/test/db/creative-media-local-render-pg.integration.test.ts | tee /tmp/rl72-probe-reproduction.log
rg 'R2 reproduction PASS' /tmp/rl72-probe-reproduction.log
