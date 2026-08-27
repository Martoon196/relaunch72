#!/usr/bin/env node

import {
  redactedPublicSocialTestRailErrorClass,
  startPublicSocialTestRailRunner,
} from './runner.js';

async function main(): Promise<void> {
  const runtime = await startPublicSocialTestRailRunner();
  const shutdown = (): void => {
    void runtime.shutdown().catch((error: unknown) => {
      process.stderr.write(
        `Public-social TEST rail shutdown failed (${redactedPublicSocialTestRailErrorClass(error)})\n`,
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
    `Public-social TEST rail startup refused (${redactedPublicSocialTestRailErrorClass(error)})\n`,
  );
  process.exitCode = 1;
});
