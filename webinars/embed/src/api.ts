export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface EmbedConfig { key: string; api: string; base: string }

export function embedConfig(): EmbedConfig {
  const c = (window as unknown as { __GHQ_EMBED__?: EmbedConfig }).__GHQ_EMBED__;
  if (!c) throw new Error('embed.js not loaded');
  return c;
}

export class Api {
  constructor(public base: string, public key: string) {}

  async req<T>(method: 'GET' | 'POST', path: string, body?: unknown, bearer?: string): Promise<T> {
    const headers: Record<string, string> = { 'x-ghq-key': this.key };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    let res: Response;
    try {
      res = await fetch(`${this.base}/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit' });
    } catch {
      throw new ApiError(0, 'network', 'Connection problem — please check your internet and try again.');
    }
    const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string; message: string } };
    if (!res.ok) throw new ApiError(res.status, json.error?.code ?? 'error', json.error?.message ?? 'Something went wrong');
    return json.data as T;
  }

  /** Fire-and-forget that survives page unload (text/plain = no CORS preflight). */
  beacon(path: string, body: Record<string, unknown>) {
    const payload = JSON.stringify({ ...body, key: this.key });
    const url = `${this.base}/v1${path}`;
    if (!navigator.sendBeacon?.(url, new Blob([payload], { type: 'text/plain' }))) {
      void fetch(url, { method: 'POST', body: payload, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(() => undefined);
    }
  }
}

export const store = {
  get(k: string): string | null {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string) {
    try { localStorage.setItem(k, v); } catch { /* private mode */ }
  },
  del(k: string) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  },
};

export function deviceId(): string {
  let id = store.get('ghq:device');
  if (!id) {
    id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 36);
    store.set('ghq:device', id);
  }
  return id;
}

export function emit(el: HTMLElement, name: 'ghq:registered' | 'ghq:joined' | 'ghq:cta-click', detail: Record<string, unknown>) {
  el.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
}
