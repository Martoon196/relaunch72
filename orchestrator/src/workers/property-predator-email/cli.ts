#!/usr/bin/env node

import '../../config.js';
import {
  redactedDarkEmailWorkerErrorClass,
  startPropertyPredatorDarkEmailWorker,
} from './dark-worker.js';

const EMAIL_WORKER_SERVICE = 'property-predator-email-worker';

function writeWorkerFailure(
  eventKind: 'startup' | 'shutdown',
  count: number,
  error: unknown,
): void {
  process.stderr.write(`${JSON.stringify(Object.freeze({
    schemaVersion: 1,
    event: 'worker_error',
    service: EMAIL_WORKER_SERVICE,
    eventKind,
    count,
    errorClass: redactedDarkEmailWorkerErrorClass(error),
  }))}\n`);
}

async function main(): Promise<void> {
  const mode = process.env.PROPERTY_PREDATOR_EMAIL_WORKER_MODE?.trim();
  const runtime = mode === 'internal-seed-live'
    ? await (await import('../property-predator-mailgun/live-worker.js'))
      .startPropertyPredatorLiveMailgunWorker()
    : await startPropertyPredatorDarkEmailWorker();
  let shutdownFailed = false;
  let shutdownFailureCount = 0;
  const shutdown = (): void => {
    void runtime.shutdown().catch((error: unknown) => {
      shutdownFailed = true;
      shutdownFailureCount += 1;
      process.exitCode = 1;
      writeWorkerFailure('shutdown', shutdownFailureCount, error);
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
  writeWorkerFailure('startup', 1, error);
  process.exitCode = 1;
});
