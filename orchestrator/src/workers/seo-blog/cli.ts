/**
 * SEO blog worker: bounded ticks that run due jobs (inventory, planning,
 * writing), dispatch due publications through the execution-time policy gate
 * and reconcile unknown outcomes. Uses the existing r72_content_command
 * identity in the worker actor role. Stop with SIGTERM; in-flight leases
 * expire and are resumed by the next process without duplicating work.
 *
 * Required: DATABASE_CONTENT_COMMAND_URL, SEO_BLOG_ENABLED=true.
 * Optional: SEO_BLOG_WORKER_INTERVAL_MS (default 60000), SEO_BLOG_WORKER_ONCE=true.
 */
import '../../config.js';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { loadDatabaseConfig } from '../../db/config.js';
import { createDatabasePool } from '../../db/pool.js';
import { createWorkerSeoBlogEngine } from '../../portal/seo-blog-service.js';
import { idleUntilShutdown } from './lifecycle.js';

async function main(): Promise<void> {
  if (process.env.SEO_BLOG_ENABLED?.trim() !== 'true') {
    console.log('seo-blog worker: disabled; idle with no database or provider activity.');
    await idleUntilShutdown();
    return;
  }
  const pool = createDatabasePool(loadDatabaseConfig('contentCommand', process.env));
  console.log('seo-blog worker: capability profile-extraction-v1 (write stage profile; uncertain calls held).');
  const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const interval = Math.max(15_000, Number(process.env.SEO_BLOG_WORKER_INTERVAL_MS ?? 60_000));
  let stopping = false;
  let lastDaily = '';
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  try {
    do {
      const requestId = `seo-blog-worker-${randomUUID()}`;
      const engine = createWorkerSeoBlogEngine(pool, requestId);
      try {
        const today = new Date().toISOString().slice(0, 10);
        if (today !== lastDaily) {
          // Brands with ongoing production get one idempotent daily job (key daily:<date>).
          await engine.enqueueDailyForAll(await engine.activeBrands());
          lastDaily = today;
        }
        const result = await engine.tick(owner);
        if (result.jobs || result.brands) console.log(`seo-blog worker: ${result.jobs} job(s), ${result.brands} brand(s) checked`);
      } catch (error) {
        console.error('seo-blog worker: tick failed', (error as Error).name, (error as Error).message.slice(0, 200));
      }
      if (process.env.SEO_BLOG_WORKER_ONCE === 'true') break;
      await new Promise((resolve) => setTimeout(resolve, interval));
    } while (!stopping);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('seo-blog worker failed to start', (error as Error).message);
  process.exitCode = 1;
});
