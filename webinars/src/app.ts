import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { Env, Mode } from './env.js';
import { defaultServices, type Services, type ServicesFactory } from './services.js';
import { allowedOriginsFor, findApiKey, hasScope, isOriginAllowed, type ApiKeyRow } from './lib/auth.js';
import type { BrandRow } from './lib/config.js';
import { getBrand } from './lib/domain.js';
import { nowIso } from './lib/util.js';

export interface PkContext {
  key: ApiKeyRow;
  brand: BrandRow;
  mode: Mode;
  origin: string;
}

export interface SkContext {
  key: ApiKeyRow;
  /** null for an account-level key */
  brandId: string | null;
  mode: Mode;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { services: Services; pk: PkContext; sk: SkContext };
};

export type Ctx = Context<AppEnv>;

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export const bad = (msg: string, code = 'invalid_request') => new HttpError(400, code, msg);
export const notFound = (what = 'not_found') => new HttpError(404, 'not_found', what);
export const forbidden = (msg = 'forbidden') => new HttpError(403, 'forbidden', msg);

export async function readJson<T = Record<string, unknown>>(c: Ctx): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  try {
    const v = JSON.parse(text);
    if (typeof v !== 'object' || v === null) throw new Error();
    return v as T;
  } catch {
    throw bad('Body must be a JSON object');
  }
}

export function clientIp(c: Ctx): string {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

export function rateLimit(binding: 'RL_PUBLIC' | 'RL_REGISTER', keyFn: (c: Ctx) => string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const rl = c.env[binding];
    if (rl) {
      const { success } = await rl.limit({ key: keyFn(c) });
      if (!success) throw new HttpError(429, 'rate_limited', 'Too many requests');
    }
    await next();
  };
}

/** Throttled last_used_at so a busy key doesn't write on every request. */
function touchKey(c: Ctx, key: ApiKeyRow) {
  const now = c.var.services.now();
  if (key.last_used_at && now - Date.parse(key.last_used_at) < 5 * 60_000) return;
  const p = c.env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(nowIso(now), key.id).run();
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    void p; // no execution context in tests
  }
}

/** Publishable key + origin lock. Key comes from x-ghq-key, ?key= (WebSocket) or a text/plain beacon body. */
export function publishable(opts: { allowBodyKey?: boolean } = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let raw = c.req.header('x-ghq-key') ?? c.req.query('key') ?? null;
    if (!raw && opts.allowBodyKey) {
      try {
        const body = JSON.parse(await c.req.raw.clone().text()) as { key?: string };
        raw = body.key ?? null;
      } catch {
        /* ignore */
      }
    }
    if (!raw || !raw.startsWith('pk_')) throw new HttpError(401, 'unauthorized', 'Publishable key required');
    const key = await findApiKey(c.env.DB, raw, c.var.services.now());
    if (!key || key.type !== 'pk' || !key.brand_id) throw new HttpError(401, 'unauthorized', 'Invalid publishable key');
    const brand = await getBrand(c.env.DB, key.brand_id);
    if (!brand) throw new HttpError(401, 'unauthorized', 'Invalid publishable key');
    const origin = c.req.header('origin') ?? null;
    if (!isOriginAllowed(origin, allowedOriginsFor(key, brand, c.env.PUBLIC_ORIGIN))) {
      throw new HttpError(403, 'origin_not_allowed', 'This key cannot be used from this site');
    }
    c.set('pk', { key, brand, mode: key.mode, origin: origin! });
    c.header('access-control-allow-origin', origin!);
    c.header('vary', 'Origin');
    touchKey(c, key);
    await next();
  };
}

export function secret(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!raw.startsWith('sk_')) throw new HttpError(401, 'unauthorized', 'Secret key required');
    const key = await findApiKey(c.env.DB, raw, c.var.services.now());
    if (!key || key.type !== 'sk') throw new HttpError(401, 'unauthorized', 'Invalid secret key');
    if (!hasScope(key.scopes, scope)) throw forbidden(`Key lacks scope ${scope}`);
    c.set('sk', { key, brandId: key.brand_id, mode: key.mode });
    touchKey(c, key);
    await next();
  };
}

export function createApp(servicesFactory: ServicesFactory = defaultServices) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('services', servicesFactory(c.env));
    await next();
  });

  // CORS preflight for the public API. The real request does the origin lock.
  app.options('/v1/*', (c) => {
    const origin = c.req.header('origin');
    if (!origin || c.req.path.startsWith('/v1/admin')) return c.body(null, 204);
    return c.body(null, 204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, x-ghq-key',
      'access-control-max-age': '86400',
      vary: 'Origin',
    });
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    }
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'Something went wrong' } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));

  app.get('/health', (c) => c.json({ ok: true }));

  return app;
}
