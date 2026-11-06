/** Worker entry: HTTP (API, embed assets, hosted pages), Queue consumer (webhooks), cron, Durable Object. */
import { createApp } from './app.js';
import { runScheduled } from './cron.js';
import type { Env, WebhookJob } from './env.js';
import { handleWebhookBatch } from './lib/webhooks.js';
import { adminRoutes, bootstrap } from './routes/admin.js';
import { pageRoutes } from './routes/pages.js';
import { publicRoutes } from './routes/public.js';
import { defaultServices, type ServicesFactory } from './services.js';

export { SessionRoom } from './room/session-room.js';

export function buildApp(services: ServicesFactory = defaultServices) {
  const app = createApp(services);
  app.post('/v1/admin/bootstrap', (c) => bootstrap(c));
  app.route('/v1/admin', adminRoutes);
  app.route('/', publicRoutes);
  app.route('/', pageRoutes);
  // Embed bundle and anything else static.
  app.get('*', async (c) => {
    if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
  return app;
}

const app = buildApp();

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<WebhookJob>, env: Env) {
    await handleWebhookBatch(batch, env);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runScheduled(env, defaultServices(env)).then(
        (stats) => Object.keys(stats).length && console.log('cron', JSON.stringify(stats)),
        (err) => console.error('cron failed', err),
      ),
    );
  },
} satisfies ExportedHandler<Env, WebhookJob>;
