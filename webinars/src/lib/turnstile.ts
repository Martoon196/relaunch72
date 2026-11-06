import type { Env } from '../env.js';

export interface TurnstileService {
  verify(token: string | undefined, ip: string | null): Promise<boolean>;
}

export function createTurnstileService(env: Env): TurnstileService {
  return {
    async verify(token, ip) {
      if (!env.TURNSTILE_SECRET) return false; // fail closed if misconfigured
      if (!token) return false;
      const form = new FormData();
      form.append('secret', env.TURNSTILE_SECRET);
      form.append('response', token);
      if (ip) form.append('remoteip', ip);
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean };
      return data.success === true;
    },
  };
}
