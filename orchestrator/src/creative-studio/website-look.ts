/**
 * "Is this your logo and colours?" A proposal built from what the brand's own home page declares
 * (touch icon, icon, share image, theme colour). It is only ever shown; the kit changes when the
 * owner presses the button, through the same saveKit path as a typed kit.
 */
import type { ProposedWebsiteLook } from '../seo-blog/engine.js';
import { NEUTRAL_PALETTE } from './brand-context.js';
import type { BrandKit, Palette } from './types.js';

export interface WebsiteLookProposal {
  /** Null when no declared logo could be used. */
  readonly logo: { readonly bytes: Buffer; readonly sha256: string; readonly mime: 'image/png' | 'image/jpeg' } | null;
  /** The declared main colour, when it differs from what is already in use. */
  readonly colour: string | null;
  /** Exactly what "Yes, use these" would save. Colours the website does not declare are left as they are. */
  readonly palette: Palette;
  /** Why a declared logo is not offered, in plain words. */
  readonly refused: string | null;
  readonly usable: boolean;
}

/** No proposal once the owner has a logo on record: their own choice is never second-guessed. */
export function websiteLookProposal(found: ProposedWebsiteLook | null, kit: BrandKit | null): WebsiteLookProposal | null {
  if (!found || kit?.logo) return null;
  const base = kit?.palette ?? NEUTRAL_PALETTE;
  const colour = found.look.themeColour && found.look.themeColour !== base.primary.toLowerCase() ? found.look.themeColour : null;
  const logo = found.logo ? { bytes: found.logo.bytes, sha256: found.logo.sha256, mime: found.logo.mime } : null;
  if (!logo && !colour && !found.refused) return null;
  return { logo, colour, palette: { ...base, primary: colour ?? base.primary }, refused: logo ? null : found.refused, usable: Boolean(logo || colour) };
}
