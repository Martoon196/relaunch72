#!/usr/bin/env node

import '../../config.js';
import { startTwilioSmsLiveWebhookService } from './server.js';

startTwilioSmsLiveWebhookService().then((runtime) => {
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void runtime.shutdown().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}).catch(() => { process.exitCode = 1; });
