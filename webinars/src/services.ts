/** External services behind interfaces so tests (and local dev) can swap them. */
import type { Env } from './env.js';
import { createStreamService, type StreamService } from './lib/stream.js';
import { createTurnstileService, type TurnstileService } from './lib/turnstile.js';

export interface Services {
  stream: StreamService;
  turnstile: TurnstileService;
  now(): number;
}

export type ServicesFactory = (env: Env) => Services;

/**
 * DEV_MODE=1 (set only in .dev.vars for `wrangler dev`): Stream calls return a public sample
 * HLS stream and Turnstile always passes. Never set it in wrangler.toml or production secrets.
 */
function devStream(): StreamService {
  const sample = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  return {
    async createLiveInput() {
      return { uid: 'dev_live_input', rtmps: { url: 'rtmps://live.cloudflare.com:443/live/', streamKey: 'dev-key' }, srt: { url: 'srt://live.cloudflare.com:778', streamId: 'dev', passphrase: 'dev' }, webRTC: { url: 'https://example.invalid/whip' } };
    },
    async createDirectUpload() {
      return { uploadURL: 'https://example.invalid/upload', uid: `dev_video_${Date.now()}` };
    },
    async latestRecording() {
      return { uid: 'dev_recording', duration: 3600, readyToStream: true };
    },
    async videoDetails(uid) {
      return { uid, duration: 3600, readyToStream: true };
    },
    async playback(_uid, { ttlSeconds = 3600, nowMs = Date.now() }) {
      return { hls: sample, webrtc: null, expires_at: new Date(nowMs + ttlSeconds * 1000).toISOString() };
    },
  };
}

export const defaultServices: ServicesFactory = (env) => {
  if (env.DEV_MODE === '1') {
    return { stream: devStream(), turnstile: { verify: async () => true }, now: () => Date.now() };
  }
  return { stream: createStreamService(env), turnstile: createTurnstileService(env), now: () => Date.now() };
};
