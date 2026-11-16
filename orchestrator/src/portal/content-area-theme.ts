/**
 * The look of the content area preview, in one place.
 *
 * Every colour, font, radius and shadow the new shell uses is a custom property defined here. A different look is a
 * swap of this block (light values in :root, dark values in the media query), never a rewrite of the screens.
 *
 * Current look: "Quiet Engine" (deep teal housing, soft white panels on mist, one warm amber action per screen).
 *
 * Fonts: the portal's content-security policy has `default-src 'none'` and no `font-src`, and only allows inline
 * styles, so web fonts (Urbanist, Hanken Grotesk) cannot load from a font service or as a stylesheet. The stacks
 * below name them first, so a device that has them installed uses them; everyone else gets the closest system face.
 */
export const CONTENT_AREA_TOKENS = `
:root{
--ca-mist:#EEF3F2;--ca-surface:#FFFFFF;--ca-deep:#0E3B43;--ca-ink:#10272C;--ca-muted:#50666B;--ca-amber:#F2B441;--ca-glow:#D5E7E4;
--ca-on-deep:#FFFFFF;--ca-on-deep-2:#D5E7E4;--ca-on-amber:#10272C;--ca-line:#E3EBE9;--ca-link:#0E3B43;
--ca-ok:#1D6B4F;--ca-warn:#8A5A00;--ca-bad:#B42318;--ca-focus:#0E7C86;--ca-focus-on-deep:#F2B441;
--ca-hero:radial-gradient(560px 340px at 90% 0%,rgba(96,178,178,.42),rgba(96,178,178,0) 70%),#0E3B43;
--ca-amber-ring:rgba(242,180,65,.22);--ca-on-deep-line:rgba(255,255,255,.16);--ca-on-deep-fill:rgba(255,255,255,.06);
--ca-font-display:"Urbanist",ui-rounded,"SF Pro Rounded","Nunito","Avenir Next","Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,"Inter",Roboto,Arial,sans-serif;
--ca-font-body:"Hanken Grotesk","Inter","Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;
--ca-weight-display:800;--ca-size-h1:40px;--ca-size-h1-phone:31px;--ca-size-hero:36px;--ca-size-h2:22px;--ca-size-body:16px;
--ca-radius-xl:28px;--ca-radius-l:24px;--ca-radius-m:16px;--ca-radius-s:12px;--ca-radius-xs:8px;--ca-radius-pill:999px;
--ca-shadow:0 1px 2px rgba(14,59,67,.06),0 14px 32px -16px rgba(14,59,67,.22);--ca-shadow-pop:0 16px 34px -12px rgba(14,59,67,.35);
--ca-side-width:248px;--ca-gap:28px;
}
@media (prefers-color-scheme:dark){:root{
--ca-mist:#0B2226;--ca-surface:#123138;--ca-deep:#071A1D;--ca-ink:#E9F2F1;--ca-muted:#A9BFC2;--ca-glow:#1B444C;
--ca-on-deep-2:#A9BFC2;--ca-line:#1F4A52;--ca-link:#8FD3C8;--ca-ok:#7FD8B0;--ca-warn:#F2C46B;--ca-bad:#FF9C92;--ca-focus:#8FD3C8;
--ca-hero:radial-gradient(560px 340px at 90% 0%,rgba(96,178,178,.22),rgba(96,178,178,0) 70%),#0F2F35;
--ca-shadow:none;--ca-shadow-pop:0 16px 34px -12px rgba(0,0,0,.6);
}}
`;
