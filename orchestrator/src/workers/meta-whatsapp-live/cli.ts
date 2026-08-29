#!/usr/bin/env node

import '../../config.js';
import {
  startMetaWhatsAppLiveWorker,
  writeMetaWhatsAppLiveWorkerFailure,
} from './runner.js';

async function main(): Promise<void> {
  const runtime = await startMetaWhatsAppLiveWorker();
  let shutdownFailures = 0;
  const shutdown = (): void => {
    void runtime.shutdown().catch((error: unknown) => {
      shutdownFailures += 1;
      writeMetaWhatsAppLiveWorkerFailure('shutdown', shutdownFailures, error);
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
  writeMetaWhatsAppLiveWorkerFailure('startup', 1, error);
  process.exitCode = 1;
});
