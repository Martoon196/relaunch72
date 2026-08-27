#!/usr/bin/env node

import {
  redactedPublicSocialRevalidatorErrorClass,
  startPublicSocialRevalidatorRunner,
} from './runner.js';

async function main(): Promise<void> {
  const runtime = await startPublicSocialRevalidatorRunner();
  const shutdown = (): void => {
    void runtime.shutdown().catch((error: unknown) => {
      process.stderr.write(
        `Public-social revalidator shutdown failed (${redactedPublicSocialRevalidatorErrorClass(error)})\n`,
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
    `Public-social revalidator startup refused (${redactedPublicSocialRevalidatorErrorClass(error)})\n`,
  );
  process.exitCode = 1;
});
