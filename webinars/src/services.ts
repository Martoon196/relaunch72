/** External services behind interfaces so tests (and test-mode keys) can swap them. */
import type { Env } from './env.js';
import { createStreamService, type StreamService } from './lib/stream.js';
import { createTurnstileService, type TurnstileService } from './lib/turnstile.js';

export interface Services {
  stream: StreamService;
  turnstile: TurnstileService;
  now(): number;
}

export type ServicesFactory = (env: Env) => Services;

export const defaultServices: ServicesFactory = (env) => ({
  stream: createStreamService(env),
  turnstile: createTurnstileService(env),
  now: () => Date.now(),
});
