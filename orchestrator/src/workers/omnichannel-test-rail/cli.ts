#!/usr/bin/env node

import {
  redactedOmnichannelTestRailErrorClass,
  startOmnichannelTestRailRunner,
} from './runner.js';

async function main(): Promise<void> {
  const runtime = await startOmnichannelTestRailRunner();
  const shutdown = (): void => {
    void runtime.shutdown().catch((error: unknown) => {
      process.stderr.write(
        `Test rail shutdown failed (${redactedOmnichannelTestRailErrorClass(error)})\n`,
      );
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await runtime.stopped;
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Test rail startup refused (${redactedOmnichannelTestRailErrorClass(error)})\n`,
  );
  process.exitCode = 1;
});
