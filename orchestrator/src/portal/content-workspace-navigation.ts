import { BRAND_BRAIN_ROUTE } from './brand-brain-actions.js';
import { COMPANY_ASSETS_ROUTE } from './company-assets-actions.js';
import { CONTENT_CONTROL_ROOM_ROUTE } from './content-control-room-presenter.js';
import { escapeHtml } from './ui.js';

export type ContentWorkspaceNavigationTarget = 'library' | 'assets' | 'brain';

export function renderContentWorkspaceNavigation(
  active: ContentWorkspaceNavigationTarget,
  options: Readonly<{
    companyAssetsAvailable?: boolean;
    assetsLabel?: string;
    brandBrainAvailable: boolean;
    brainLabel?: string;
  }> = {
    brandBrainAvailable: false,
  },
): string {
  const libraryCurrent = active === 'library' ? ' aria-current="page"' : '';
  const assetsCurrent = active === 'assets' ? ' aria-current="page"' : '';
  const brainCurrent = active === 'brain' ? ' aria-current="page"' : '';
  const libraryClass = active === 'library' ? 'button compact' : 'button secondary compact';
  const assetsClass = active === 'assets' ? 'button compact' : 'button secondary compact';
  const brainClass = active === 'brain' ? 'button compact' : 'button secondary compact';
  const assets = options.companyAssetsAvailable
    ? `<a class="${assetsClass}" href="${COMPANY_ASSETS_ROUTE}"${assetsCurrent}>${escapeHtml(options.assetsLabel ?? 'Company Assets')}</a>`
    : '';
  const brain = options.brandBrainAvailable
    ? `<a class="${brainClass}" href="${BRAND_BRAIN_ROUTE}"${brainCurrent}>${escapeHtml(options.brainLabel ?? 'Brand Brain')}</a>`
    : '';
  return `<nav aria-label="Content workspace" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap"><a class="${libraryClass}" href="${CONTENT_CONTROL_ROOM_ROUTE}"${libraryCurrent}>Content control</a>${assets}${brain}</nav>`;
}
