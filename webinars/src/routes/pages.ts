/**
 * Hosted pages (for emails and ads), the iframe fallback, the host console page and inbound
 * Stream webhooks. Hosted pages are just the embed on a page themed with the brand's config,
 * served on webinars.growthhq.app/w/<brand>/<webinar> or a brand's custom hostname
 * (Cloudflare for SaaS custom hostnames route to this Worker).
 */
import { Hono } from 'hono';
import { HttpError, notFound, type AppEnv, type Ctx } from '../app.js';
import { resolveConfig, type BrandRow, type ResolvedConfig } from '../lib/config.js';
import { getSession, promoteRecording, type WebinarRow } from '../lib/domain.js';
import { verifyStreamWebhook } from '../lib/stream.js';
import { escapeHtml, nowIso } from '../lib/util.js';

export const pageRoutes = new Hono<AppEnv>();

const VIEWS = new Set(['register', 'room', 'replay', 'list', 'countdown']);

async function liveKey(c: Ctx, brandId: string): Promise<string | null> {
  const k = await c.env.DB.prepare("SELECT display FROM api_keys WHERE brand_id = ? AND type = 'pk' AND mode = 'live' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .bind(brandId).first<{ display: string }>();
  return k?.display ?? null;
}

function shell(c: Ctx, opts: { cfg: ResolvedConfig; title: string; description?: string; body: string; frame?: boolean; key: string }) {
  const { theme } = opts.cfg;
  const font = theme.font_url ? `<link rel="stylesheet" href="${escapeHtml(theme.font_url)}">` : '';
  const favicon = theme.favicon ? `<link rel="icon" href="${escapeHtml(theme.favicon)}">` : '';
  const logo = !opts.frame && theme.logo_light ? `<header><img src="${escapeHtml(theme.logo_light)}" alt="${escapeHtml(opts.cfg.brand.name)}" height="40"></header>` : '';
  const resize = opts.frame
    ? `<script>(function(){var last=0;function post(){var h=document.documentElement.scrollHeight;if(h!==last){last=h;parent.postMessage({type:'ghq:resize',height:h},'*');}}
new ResizeObserver(post).observe(document.body);addEventListener('load',post);
['ghq:registered','ghq:joined','ghq:cta-click'].forEach(function(t){document.addEventListener(t,function(e){parent.postMessage({type:t,detail:e.detail},'*');});});})();</script>`
    : '';
  const html = `<!doctype html>
<html lang="${escapeHtml(opts.cfg.settings.defaults.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
${opts.description ? `<meta name="description" content="${escapeHtml(opts.description.slice(0, 300))}"><meta property="og:description" content="${escapeHtml(opts.description.slice(0, 300))}">` : ''}
<meta property="og:title" content="${escapeHtml(opts.title)}">
${opts.frame ? '' : '<meta name="robots" content="index,follow">'}
${favicon}${font}
<style>
  html,body{margin:0;background:${escapeHtml(theme.colors.background)};color:${escapeHtml(theme.colors.text)};font-family:${escapeHtml(theme.font_family)}}
  main{max-width:${opts.frame ? 'none' : '1100px'};margin:0 auto;padding:${opts.frame ? '0' : '24px 16px 64px'}}
  header{max-width:1100px;margin:0 auto;padding:20px 16px 0}
</style>
<script src="${escapeHtml(c.env.CDN_ORIGIN)}/v1/embed.js" data-key="${escapeHtml(opts.key)}" data-api="${escapeHtml(c.env.API_ORIGIN)}" defer></script>
</head>
<body>${logo}<main>${opts.body}</main>${resize}</body>
</html>`;
  return c.html(html, 200, {
    'content-security-policy': opts.frame ? 'frame-ancestors *' : "frame-ancestors 'self'",
    'cache-control': 'public, max-age=60',
  });
}

async function webinarPage(c: Ctx, brand: BrandRow, webinarSlug: string, frame = false, viewParam?: string) {
  const key = await liveKey(c, brand.id);
  if (!key) throw notFound('Brand has no publishable key yet');
  const w = await c.env.DB.prepare("SELECT * FROM webinars WHERE brand_id = ? AND mode = 'live' AND slug = ? AND status = 'published'").bind(brand.id, webinarSlug).first<WebinarRow>();
  if (!w) throw notFound('Webinar not found');
  const cfg = resolveConfig(brand, w.overrides_json);
  const v = viewParam ?? c.req.query('view') ?? c.req.query('ghq_view') ?? 'register';
  const view = VIEWS.has(v) ? v : 'register';
  return shell(c, {
    cfg, key, frame, title: `${w.title} — ${brand.name}`, description: w.description,
    body: `<ghq-webinar webinar="${escapeHtml(w.slug)}" view="${view}"></ghq-webinar>`,
  });
}

async function listPage(c: Ctx, brand: BrandRow, frame = false) {
  const key = await liveKey(c, brand.id);
  if (!key) throw notFound('Brand has no publishable key yet');
  return shell(c, { cfg: resolveConfig(brand), key, frame, title: `Webinars — ${brand.name}`, body: '<ghq-webinar view="list"></ghq-webinar>' });
}

async function brandBySlug(c: Ctx, slug: string) {
  const b = await c.env.DB.prepare('SELECT * FROM brands WHERE slug = ?').bind(slug).first<BrandRow>();
  if (!b) throw notFound();
  return b;
}

// --- custom hostnames (e.g. webinars.propinvest.co.uk) ---
pageRoutes.use('*', async (c, next) => {
  const host = (c.req.header('host') ?? '').toLowerCase();
  const ours = [c.env.PUBLIC_ORIGIN, c.env.API_ORIGIN, c.env.CDN_ORIGIN].map((o) => { try { return new URL(o).host; } catch { return ''; } });
  if (!host || ours.includes(host) || host.startsWith('localhost') || host.startsWith('127.0.0.1') || c.req.method !== 'GET') return next();
  const p = c.req.path;
  if (p.startsWith('/v1/') || p.startsWith('/frame/') || p.startsWith('/hooks/') || p === '/health') return next();
  const brand = await c.env.DB.prepare("SELECT * FROM brands WHERE json_extract(settings_json, '$.domains.hosted_hostname') = ?").bind(host).first<BrandRow>();
  if (!brand) return next();
  if (p === '/' || p === '') return listPage(c, brand);
  const slug = p.replace(/^\/+|\/+$/g, '');
  if (/^[\w-]+$/.test(slug)) return webinarPage(c, brand, slug);
  return next();
});

pageRoutes.get('/w/:brand', async (c) => listPage(c, await brandBySlug(c, c.req.param('brand'))));
pageRoutes.get('/w/:brand/:webinar', async (c) => webinarPage(c, await brandBySlug(c, c.req.param('brand')), c.req.param('webinar')));

// --- iframe fallback: /frame/<pk>/<webinar|_list>/<view> ---
pageRoutes.get('/frame/:key/:webinar/:view', async (c) => {
  const key = c.req.param('key');
  const k = await c.env.DB.prepare("SELECT brand_id FROM api_keys WHERE display = ? AND type = 'pk' AND (revoked_at IS NULL OR revoked_at > ?)").bind(key, nowIso(c.var.services.now())).first<{ brand_id: string }>();
  if (!k) throw notFound();
  const brand = (await c.env.DB.prepare('SELECT * FROM brands WHERE id = ?').bind(k.brand_id).first<BrandRow>())!;
  if (c.req.param('webinar') === '_list') return listPage(c, brand, true);
  return webinarPage(c, brand, c.req.param('webinar'), true, c.req.param('view'));
});

// --- host / moderator console (token arrives in the URL fragment, never sent to the server) ---
pageRoutes.get('/frame/console', (c) => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Host console</title><meta name="robots" content="noindex">
<style>html,body{margin:0;background:#0f1115;color:#e5e7eb;font-family:system-ui,sans-serif}</style>
<script>
  var p = new URLSearchParams(location.hash.slice(1));
  var s = document.createElement('script');
  s.src = ${JSON.stringify(`${c.env.CDN_ORIGIN}/v1/embed.js`)}; s.defer = true;
  s.dataset.key = p.get('key') || ''; s.dataset.api = ${JSON.stringify(c.env.API_ORIGIN)};
  document.head.appendChild(s);
  addEventListener('DOMContentLoaded', function () {
    var el = document.createElement('ghq-host-console');
    el.setAttribute('session', p.get('session') || '');
    el.token = p.get('token') || '';
    document.body.appendChild(el);
  });
</script></head><body></body></html>`;
  return c.html(html, 200, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
});

// --- Stream webhook: recording ready → replay ---
pageRoutes.post('/hooks/stream', async (c) => {
  const body = await c.req.text();
  if (!c.env.STREAM_WEBHOOK_SECRET || !(await verifyStreamWebhook(c.env.STREAM_WEBHOOK_SECRET, c.req.header('webhook-signature') ?? null, body, Math.floor(c.var.services.now() / 1000)))) {
    throw new HttpError(401, 'bad_signature', 'Invalid signature');
  }
  const v = JSON.parse(body) as { uid?: string; readyToStream?: boolean; duration?: number; liveInput?: string; status?: { state?: string } };
  if (!v.uid) return c.json({ ok: true });
  const now = c.var.services.now();
  if (v.liveInput) {
    const w = await c.env.DB.prepare('SELECT id FROM webinars WHERE stream_live_input_id = ?').bind(v.liveInput).first<{ id: string }>();
    if (w) {
      const s = await c.env.DB.prepare("SELECT id FROM sessions WHERE webinar_id = ? AND kind = 'live' AND status = 'ended' ORDER BY COALESCE(ended_at, ends_at) DESC LIMIT 1")
        .bind(w.id).first<{ id: string }>();
      if (s && (await getSession(c.env.DB, s.id))) {
        await promoteRecording(c.env, c.var.services, s.id, now, { uid: v.uid, duration: v.duration ?? 0, readyToStream: v.readyToStream === true });
      }
    }
  } else if (v.readyToStream) {
    await c.env.DB.prepare('UPDATE webinars SET duration_s = COALESCE(duration_s, ?), updated_at = ? WHERE video_uid = ?')
      .bind(Math.round(v.duration ?? 0) || null, nowIso(now), v.uid).run();
  }
  return c.json({ ok: true });
});
