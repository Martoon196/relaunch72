import { BRAND_BRAIN_ROUTE } from './brand-brain-actions.js';
import { CAMPAIGN_WIZARD_ROUTE } from './campaign-wizard-actions.js';
import { CAMPAIGN_COMMAND_ROUTE } from './campaign-command-presenter.js';
import { CAMPAIGN_MACHINE_ROUTE } from './campaign-machine-presenter.js';
import { COMPANY_ASSETS_ROUTE } from './company-assets-actions.js';
import { CONTENT_CALENDAR_ROUTE } from './content-calendar-presenter.js';
import { CONTENT_CONTROL_ROOM_ROUTE } from './content-control-room-presenter.js';
import { LIVE_CHANNELS_ROUTE } from './live-channels-presenter.js';
import { PROVIDER_READINESS_COCKPIT_ROUTE } from './provider-readiness-cockpit-presenter.js';
import { SOCIAL_ACCOUNT_CONTROL_ROUTE } from './social-account-control-presenter.js';
import { SOCIAL_COMPOSER_ROUTE } from './social-composer-presenter.js';
import { IMAGE_STUDIO_ROUTE } from './image-studio-presenter.js';
import { COMPANY_CONTENT_SYNC_ROUTE } from './company-content-sync-actions.js';
import { escapeHtml } from './ui.js';

export type ContentWorkspaceNavigationTarget =
  | 'create'
  | 'campaigns'
  | 'sequences'
  | 'calendar'
  | 'composer'
  | 'images'
  | 'connections'
  | 'readiness'
  | 'live'
  | 'library'
  | 'assets'
  | 'brain'
  | 'sync';

const CONTENT_WORKSPACE_NAVIGATION_STYLE = `
  .pp-content-nav{display:flex;align-items:center;gap:6px;max-width:100%;margin:0 0 14px;padding:6px;border:1px solid #253238;border-radius:10px;background:#090d0f;overflow-x:auto;scrollbar-width:thin;scrollbar-color:#39474e #090d0f}
  .pp-content-nav a{flex:0 0 auto;min-height:44px;display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:7px;padding:0 12px;color:#96a5a9;font-size:12px;font-weight:850;line-height:1.2;text-decoration:none;white-space:nowrap}
  .pp-content-nav a:hover{border-color:#3b4b51;color:#f3f7f6}.pp-content-nav a[aria-current="page"]{border-color:#318178;background:#08211e;color:#65f3e3;box-shadow:inset 0 -2px #00e5cc}
  .pp-content-nav a[data-content-action="create"]{border-color:#2f746c;background:#09201e;color:#74f4e5}.pp-content-nav a[data-content-action="create"]:hover{border-color:#00e5cc;background:#0b2a27;color:#fff}
  .pp-content-nav a:focus-visible{outline:3px solid rgba(0,229,204,.34);outline-offset:2px}
  @media(max-width:560px){.pp-content-nav{margin-inline:-2px;padding:5px}.pp-content-nav a{padding-inline:10px}}
  @media(forced-colors:active){.pp-content-nav,.pp-content-nav a{forced-color-adjust:auto}.pp-content-nav a[aria-current="page"]{border:3px solid Highlight}}
`;

const CONTENT_WORKSPACE_LINKS: readonly Readonly<{
  target: ContentWorkspaceNavigationTarget;
  href: string;
  label: string;
}>[] = Object.freeze([
  { target: 'create', href: CAMPAIGN_WIZARD_ROUTE, label: '+ New campaign' },
  { target: 'campaigns', href: CAMPAIGN_COMMAND_ROUTE, label: 'Campaigns' },
  { target: 'sequences', href: CAMPAIGN_MACHINE_ROUTE, label: 'Sequences' },
  { target: 'calendar', href: CONTENT_CALENDAR_ROUTE, label: 'Calendar' },
  { target: 'connections', href: SOCIAL_ACCOUNT_CONTROL_ROUTE, label: 'Social accounts' },
  { target: 'readiness', href: PROVIDER_READINESS_COCKPIT_ROUTE, label: 'Rail status' },
  { target: 'live', href: LIVE_CHANNELS_ROUTE, label: 'Live Channels' },
  { target: 'library', href: CONTENT_CONTROL_ROOM_ROUTE, label: 'Content Control' },
]);

export function renderContentWorkspaceNavigation(
  active: ContentWorkspaceNavigationTarget,
  options: Readonly<{
    companyAssetsAvailable?: boolean;
    composerAvailable?: boolean;
    imageStudioAvailable?: boolean;
    assetsLabel?: string;
    brandBrainAvailable: boolean;
    brainLabel?: string;
    companyContentSyncAvailable?: boolean;
    /** Property Predator-only reusable campaign template surface. */
    campaignMachineAvailable?: boolean;
    /** Show only when the canonical portal has composed the read-only evidence service. */
    providerReadinessAvailable?: boolean;
    /** Property Predator-only live channel control room. */
    liveChannelsAvailable?: boolean;
  }> = {
    brandBrainAvailable: false,
  },
): string {
  const links = CONTENT_WORKSPACE_LINKS.filter((link) => (
    (link.target !== 'readiness'
      || options.providerReadinessAvailable === true
      || active === 'readiness')
    && (link.target !== 'sequences'
      || options.campaignMachineAvailable === true
      || active === 'sequences')
    && (link.target !== 'live'
      || options.liveChannelsAvailable === true
      || active === 'live')
  )).map((link) => (
    `<a href="${link.href}"${link.target === 'create' ? ' data-content-action="create"' : ''}${active === link.target ? ' aria-current="page"' : ''}>${link.label}</a>`
  )).join('');
  const composer = options.composerAvailable || active === 'composer'
    ? `<a href="${SOCIAL_COMPOSER_ROUTE}"${active === 'composer' ? ' aria-current="page"' : ''}>Composer</a>`
    : '';
  const images = (options.imageStudioAvailable
      ?? (options.companyAssetsAvailable && options.brandBrainAvailable)) || active === 'images'
    ? `<a href="${IMAGE_STUDIO_ROUTE}"${active === 'images' ? ' aria-current="page"' : ''}>Image Studio</a>`
    : '';
  const assets = options.companyAssetsAvailable
    ? `<a href="${COMPANY_ASSETS_ROUTE}"${active === 'assets' ? ' aria-current="page"' : ''}>${escapeHtml(options.assetsLabel ?? 'Company Assets')}</a>`
    : '';
  const brain = options.brandBrainAvailable
    ? `<a href="${BRAND_BRAIN_ROUTE}"${active === 'brain' ? ' aria-current="page"' : ''}>${escapeHtml(options.brainLabel ?? 'Brand Brain')}</a>`
    : '';
  const sync = options.companyContentSyncAvailable
    ? `<a href="${COMPANY_CONTENT_SYNC_ROUTE}"${active === 'sync' ? ' aria-current="page"' : ''}>Source Sync</a>`
    : '';
  return `<style data-property-predator-content-workspace-navigation>${CONTENT_WORKSPACE_NAVIGATION_STYLE}</style><nav class="pp-content-nav" aria-label="Content operations">${links}${composer}${images}${assets}${brain}${sync}</nav>`;
}
