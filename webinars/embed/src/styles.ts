import { css } from 'lit';
import type { Theme } from './types.js';

/**
 * Brand theme → CSS custom properties on the host element. Everything inside the shadow
 * roots reads these, so a brand's look is pure data. Derived tones (soft accent, elevated
 * surface, ring) are computed with color-mix so brands only ever supply six colours.
 */
export function themeVars(theme: Theme, mode: 'light' | 'dark', accent?: string | null): string {
  const c = theme.colors;
  const dark = mode === 'dark';
  const vars: Record<string, string> = {
    '--ghq-primary': c.primary,
    '--ghq-accent': accent || c.accent,
    '--ghq-bg': dark ? '#0d0f14' : c.background,
    '--ghq-surface': dark ? '#161922' : c.surface,
    '--ghq-surface-2': dark ? '#1e222d' : '#ffffff',
    '--ghq-text': dark ? '#f4f5f7' : c.text,
    '--ghq-muted': dark ? '#9aa3b2' : c.muted,
    '--ghq-border': dark ? 'rgba(255,255,255,.09)' : 'rgba(17,24,39,.1)',
    '--ghq-shadow': dark ? '0 1px 2px rgba(0,0,0,.5), 0 12px 32px -12px rgba(0,0,0,.6)' : '0 1px 2px rgba(17,24,39,.05), 0 12px 32px -14px rgba(17,24,39,.18)',
    '--ghq-font': theme.font_family,
    '--ghq-radius': theme.radius,
    '--ghq-btn-radius': theme.button_style === 'pill' ? '999px' : theme.radius,
    '--ghq-btn-fill': theme.button_style === 'outline' ? 'transparent' : 'var(--ghq-primary)',
    '--ghq-btn-text': theme.button_style === 'outline' ? 'var(--ghq-primary)' : '#fff',
  };
  return Object.entries(vars).map(([k, v]) => `${k}:${String(v).replace(/[;{}<>]/g, '')}`).join(';');
}

const fontsLoaded = new Set<string>();
/** @font-face doesn't apply from inside a shadow root, so web fonts go in the host document. */
export function loadFont(url?: string) {
  if (!url || fontsLoaded.has(url) || !/^https:\/\//.test(url)) return;
  fontsLoaded.add(url);
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = url;
  document.head.appendChild(l);
}

/** Deterministic hue for avatars: same name, same colour, every device. */
export function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export const base = css`
  :host {
    display: block;
    font-family: var(--ghq-font, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
    color: var(--ghq-text, #111827);
    line-height: 1.55;
    box-sizing: border-box;
    -webkit-font-smoothing: antialiased;
    --_accent-soft: color-mix(in srgb, var(--ghq-accent) 13%, transparent);
    --_accent-line: color-mix(in srgb, var(--ghq-accent) 40%, transparent);
    --_primary-soft: color-mix(in srgb, var(--ghq-primary) 10%, transparent);
    --_ease: cubic-bezier(.2, .7, .2, 1);
  }
  *, *::before, *::after { box-sizing: inherit; }
  [hidden] { display: none !important; }
  h1, h2, h3 { line-height: 1.15; margin: 0 0 .45em; letter-spacing: -.015em; font-weight: 700; }
  h1 { font-size: clamp(1.6rem, 1.1rem + 2vw, 2.4rem); }
  h2 { font-size: 1.25rem; }
  h3 { font-size: 1.05rem; }
  p { margin: 0 0 1em; }
  a { color: var(--ghq-accent); }
  ul { padding-left: 0; list-style: none; margin: 0; }
  .muted { color: var(--ghq-muted); }
  .small { font-size: .875rem; }
  .xs { font-size: .78rem; }

  .eyebrow {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: .72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
    color: var(--ghq-accent); margin-bottom: 10px;
  }
  .eyebrow::before { content: ''; width: 18px; height: 2px; background: currentColor; border-radius: 2px; }

  .card {
    background: var(--ghq-surface-2);
    border: 1px solid var(--ghq-border);
    border-radius: var(--ghq-radius);
    box-shadow: var(--ghq-shadow);
    padding: 22px;
  }
  .card.flat { box-shadow: none; background: var(--ghq-surface); }
  .stack > * + * { margin-top: 14px; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }

  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: .8rem; font-weight: 600; padding: 5px 11px; border-radius: 999px;
    background: var(--ghq-surface); border: 1px solid var(--ghq-border); color: var(--ghq-text);
    white-space: nowrap;
  }
  .pill svg { width: 14px; height: 14px; color: var(--ghq-accent); flex: none; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: .7rem; font-weight: 700; letter-spacing: .07em; text-transform: uppercase;
    padding: 4px 10px; border-radius: 999px;
    background: var(--_accent-soft); color: var(--ghq-accent);
  }
  .badge.live { background: #e11d48; color: #fff; }
  .badge.live::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #fff; animation: ghq-pulse 1.4s ease-out infinite; }
  .badge.neutral { background: var(--ghq-surface); color: var(--ghq-muted); border: 1px solid var(--ghq-border); }

  button, .btn {
    font: inherit; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    min-height: 46px; padding: 10px 20px; border-radius: var(--ghq-btn-radius);
    border: 2px solid var(--ghq-primary); background: var(--ghq-btn-fill); color: var(--ghq-btn-text); text-decoration: none;
    transition: transform .15s var(--_ease), box-shadow .2s var(--_ease), background .2s, border-color .2s, opacity .2s;
  }
  button svg, .btn svg { width: 18px; height: 18px; flex: none; }
  button:hover, .btn:hover { transform: translateY(-1px); box-shadow: 0 8px 20px -10px color-mix(in srgb, var(--ghq-primary) 70%, transparent); }
  button:active, .btn:active { transform: translateY(0); box-shadow: none; }
  button.accent, .btn.accent { background: var(--ghq-accent); border-color: var(--ghq-accent); color: #fff; }
  button.accent:hover, .btn.accent:hover { box-shadow: 0 8px 20px -10px color-mix(in srgb, var(--ghq-accent) 80%, transparent); }
  button.secondary, .btn.secondary { background: transparent; color: var(--ghq-text); border-color: var(--ghq-border); }
  button.secondary:hover, .btn.secondary:hover { border-color: var(--ghq-text); box-shadow: none; }
  button.ghost { background: transparent; border-color: transparent; color: var(--ghq-muted); }
  button.ghost:hover { background: var(--_primary-soft); color: var(--ghq-text); transform: none; box-shadow: none; }
  button.link { background: none; border: none; color: var(--ghq-accent); padding: 4px; min-height: 0; text-decoration: underline; }
  button.sm { min-height: 34px; padding: 5px 12px; font-size: .82rem; border-width: 1.5px; }
  button.icon { min-height: 40px; width: 40px; padding: 0; border-radius: 50%; }
  button:disabled, .btn[aria-disabled='true'] { opacity: .55; cursor: not-allowed; transform: none; box-shadow: none; }
  button.busy { cursor: progress; }

  button:focus-visible, .btn:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible, label.choice:focus-within {
    outline: 3px solid var(--_accent-line); outline-offset: 2px;
  }
  label { display: block; font-weight: 600; font-size: .88rem; margin-bottom: 6px; }
  input, select, textarea {
    font: inherit; width: 100%; padding: 11px 13px; min-height: 46px; color: var(--ghq-text); background: var(--ghq-surface-2);
    border: 1.5px solid var(--ghq-border); border-radius: calc(var(--ghq-radius) * .8);
    transition: border-color .15s, box-shadow .15s;
  }
  input:hover, select:hover, textarea:hover { border-color: color-mix(in srgb, var(--ghq-text) 30%, transparent); }
  input:focus, select:focus, textarea:focus { border-color: var(--ghq-accent); box-shadow: 0 0 0 4px var(--_accent-soft); outline: none; }
  textarea { min-height: 88px; resize: vertical; }
  .check { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; cursor: pointer; }
  .check input { width: 20px; min-height: 20px; height: 20px; margin-top: 3px; flex: none; accent-color: var(--ghq-accent); }

  .choice {
    display: flex; gap: 12px; align-items: center; padding: 11px 14px; cursor: pointer; font-weight: 500;
    border: 1.5px solid var(--ghq-border); border-radius: calc(var(--ghq-radius) * .8); background: var(--ghq-surface-2);
    transition: border-color .15s, background .15s, box-shadow .15s;
  }
  .choice:hover { border-color: var(--_accent-line); }
  .choice:has(input:checked) { border-color: var(--ghq-accent); background: var(--_accent-soft); box-shadow: 0 0 0 1px var(--ghq-accent) inset; }
  .choice input { width: 18px; min-height: 18px; height: 18px; margin: 0; accent-color: var(--ghq-accent); flex: none; }

  .avatar {
    width: 44px; height: 44px; border-radius: 50%; flex: none; display: grid; place-items: center;
    font-weight: 700; font-size: .85rem; color: #fff; object-fit: cover; letter-spacing: .02em;
    background: linear-gradient(135deg, hsl(var(--h, 220) 55% 48%), hsl(calc(var(--h, 220) + 40) 60% 38%));
  }
  .avatar.xs { width: 26px; height: 26px; font-size: .62rem; }

  .error { color: #be123c; font-size: .9rem; }
  .alert { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: calc(var(--ghq-radius) * .8); background: color-mix(in srgb, #be123c 9%, transparent); color: #9f1239; font-size: .9rem; }
  .alert svg { width: 18px; height: 18px; flex: none; margin-top: 1px; }
  .risk { font-size: .78rem; color: var(--ghq-muted); border-left: 3px solid var(--ghq-accent); padding: 6px 12px; margin-top: 14px; line-height: 1.5; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }

  .skeleton { position: relative; overflow: hidden; background: var(--ghq-surface); border-radius: 8px; min-height: 14px; }
  .skeleton::after {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--ghq-text) 6%, transparent), transparent);
    transform: translateX(-100%); animation: ghq-shimmer 1.4s infinite;
  }
  .fade-in { animation: ghq-fade .35s var(--_ease) both; }
  .rise { animation: ghq-rise .4s var(--_ease) both; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; display: inline-block; }
  .dot.pulse { animation: ghq-pulse 1.4s ease-out infinite; }
  .dot.off { background: #f59e0b; animation: none; }

  @keyframes ghq-shimmer { to { transform: translateX(100%); } }
  @keyframes ghq-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ghq-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  @keyframes ghq-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 55%, transparent); } 100% { box-shadow: 0 0 0 7px transparent; } }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
`;
