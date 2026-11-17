#!/bin/bash
set -euo pipefail
: "${RL72_METHODS_PG_TEST_URL:?Use the disposable native schema and clock harness}"
node --import tsx --test orchestrator/test/db/creative-media-native-calendar-pg.integration.test.ts | tee /tmp/rl72-trigger-reproduction.log
rg 'R1 reproduction PASS' /tmp/rl72-trigger-reproduction.log
