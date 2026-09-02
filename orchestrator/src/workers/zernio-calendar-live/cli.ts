#!/usr/bin/env node

import '../../config.js';
import {
  startZernioCalendarLiveWorker,
  writeZernioCalendarWorkerFailure,
} from './runner.js';

async function main(): Promise<void> {
  const runtime = await startZernioCalendarLiveWorker();
  let shutdownFailureCount = 0;
  const shutdown = (): void => {
    void runtime.shutdown().catch((error: unknown) => {
      shutdownFailureCount += 1;
      writeZernioCalendarWorkerFailure('shutdown', shutdownFailureCount, error);
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
  writeZernioCalendarWorkerFailure('startup', 1, error);
  process.exitCode = 1;
});
