#!/usr/bin/env node

import '../../config.js';
import {
  redactedDarkEmailWorkerErrorClass,
  startPropertyPredatorDarkEmailWorker,
} from './dark-worker.js';

async function main(): Promise<void> {
  const runtime = await startPropertyPredatorDarkEmailWorker();
  let shutdownFailed = false;
  const shutdown = (): void => {
    void runtime.shutdown().catch((error: unknown) => {
      shutdownFailed = true;
      process.exitCode = 1;
      process.stderr.write(
        `Dark email worker shutdown failed (${redactedDarkEmailWorkerErrorClass(error)})\n`,
      );
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await runtime.stopped;
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
  if (shutdownFailed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  // Never render a database/provider error message: it can contain a host,
  // credential-bearing URL or recipient. The error class is sufficient for
  // an operator to correlate with secret-manager and database audit evidence.
  process.stderr.write(
    `Dark email worker startup refused (${redactedDarkEmailWorkerErrorClass(error)})\n`,
  );
  process.exitCode = 1;
});
