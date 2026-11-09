#!/usr/bin/env node

import '../../config.js';
import {
  startCustomerEmailLiveWorker,
  writeCustomerEmailLiveWorkerFailure,
} from './runner.js';

async function main(): Promise<void> {
  const runtime = await startCustomerEmailLiveWorker();
  let shutdownFailureCount = 0;
  const shutdown = (): void => {
    void runtime.shutdown().catch((error: unknown) => {
      shutdownFailureCount += 1;
      writeCustomerEmailLiveWorkerFailure('shutdown', shutdownFailureCount, error);
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
  writeCustomerEmailLiveWorkerFailure('startup', 1, error);
  process.exitCode = 1;
});
