/**
 * Disposable-database fixture: give one test brand a founder allowance.
 *
 * Since migration 0145 every new brand starts with no spend authority, and only a limits
 * operator (the founder) can raise it. This goes through that same founder command, with the
 * real role and a real session, so the test brand is provisioned the way a live one is.
 * Nothing here loosens a production limit.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { PgSeoLimitsService } from '../../src/portal/seo-blog-limits-service.js';

export interface FounderSession { readonly user: string; readonly home: string; readonly token: string }

export async function grantFounderAllowance(admin: pg.Pool, content: pg.Pool, founder: FounderSession, brandId: string,
  limits: { modelTokens: number | null; searchCalls?: number | null; images?: number | null; studioImages?: number | null }): Promise<void> {
  await admin.query('INSERT INTO app_private.seo_limit_operators(user_id) VALUES($1) ON CONFLICT DO NOTHING', [founder.user]);
  const service = new PgSeoLimitsService(content, { sessionToken: founder.token, userId: founder.user, workspaceId: founder.home, userEmail: `async-${founder.user}@example.test` }, randomUUID());
  const row = (await service.list()).brands.find((b) => b.id === brandId);
  if (!row) throw new Error('The test brand is not visible to the founder command.');
  await service.save(brandId, row.rowVersion, { modelTokens: limits.modelTokens, searchCalls: limits.searchCalls ?? 0, images: limits.images ?? 0, studioImages: limits.studioImages ?? 0 });
}
