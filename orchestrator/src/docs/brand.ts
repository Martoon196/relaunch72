/**
 * Relaunch72 brand tokens — seed for LS-9 (brand identity). Direction from
 * the approved mockup notes: dark premium, electric accent, bold grotesk
 * headlines. Delivered documents print, so BODY pages are paper-white; the
 * dark treatment lives in the cover/header bands.
 *
 * Self-contained by design: system font stacks only (no webfont fetch — the
 * PDF renderer runs offline and customer docs must not phone home).
 */

export const BRAND = {
  name: 'Relaunch72',
  /** Near-black premium ink (headers, cover). */
  ink: '#0c1018',
  /** Electric accent. */
  electric: '#3557ff',
  /** Accent used sparingly on dark ground. */
  electricBright: '#5d7bff',
  paper: '#ffffff',
  /** Body text on paper. */
  body: '#1e2430',
  /** Muted supporting text. */
  muted: '#5a6372',
  /** Hairlines / table rules. */
  rule: '#d9dde5',
  /** Soft panel background. */
  panel: '#f3f5f9',
  headlineStack: "'Archivo Black', 'Arial Black', 'Helvetica Neue', Arial, sans-serif",
  textStack: "'Helvetica Neue', Helvetica, Arial, 'Segoe UI', sans-serif",
  monoStack: "'SF Mono', 'Cascadia Code', Consolas, 'Liberation Mono', monospace",
} as const;
