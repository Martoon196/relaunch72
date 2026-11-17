/**
 * Affiliate Studio composition (AFFILIATE_STUDIO=enabled, default off). The stores always act in the signed-in
 * owner's own session and only ever for the business that session has selected: a person who runs two businesses
 * cannot reach the other one from here (review 0158, note 2). While 0158 is not opened yet every call answers
 * "not opened yet", which the screens treat as a normal state.
 */
import type { Pool } from 'pg';
import { PgAffiliateProductStore, type AffiliateOwner, type AffiliateProduct, type ProgrammeSettings } from '../affiliate/product-store.js';
import { PgAffiliateReportStore } from '../affiliate/report-store.js';
import type { PortalSessionIdentity } from './auth-service.js';

export const AFFILIATE_FLAG = 'AFFILIATE_STUDIO';
export function affiliateStudioEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return env[AFFILIATE_FLAG]?.trim() === 'enabled'; }

/** What the routes use; `workspaceId` is the session's own business. */
export interface AffiliateStores {
  readonly workspaceId: string;
  readonly products: Pick<PgAffiliateProductStore, 'list' | 'get' | 'settings' | 'saveSettings' | 'add' | 'edit' | 'retire'>;
  readonly reports: Pick<PgAffiliateReportStore, 'list' | 'get' | 'save'>;
}

export function affiliateStores(pool: Pool, identity: PortalSessionIdentity, requestId: string): AffiliateStores {
  const owner: AffiliateOwner = { userId: identity.userId, requestId, sessionToken: identity.sessionToken, selectedWorkspaceId: identity.workspaceId };
  return { workspaceId: identity.workspaceId, products: new PgAffiliateProductStore(pool, owner), reports: new PgAffiliateReportStore(pool, owner) };
}

/** The engine's read of products and details: only for the session's own business; null when not available. */
export function affiliateReader(stores: AffiliateStores): { read(brandId: string): Promise<{ catalogue: readonly AffiliateProduct[]; settings: ProgrammeSettings | null } | null> } {
  return {
    async read(brandId) {
      if (brandId !== stores.workspaceId) return null;
      const [list, settings] = await Promise.all([stores.products.list(brandId), stores.products.settings(brandId, 'amazon_uk')]);
      if (!list.ok || !settings.ok) return null;
      return { catalogue: list.value, settings: settings.value };
    },
  };
}
