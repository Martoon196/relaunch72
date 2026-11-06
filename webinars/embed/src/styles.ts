import { css } from 'lit';
import type { Theme } from './types.js';

/** Brand theme → CSS custom properties on the host element (inherited through every shadow root). */
export function themeVars(theme: Theme, mode: 'light' | 'dark', accent?: string | null): string {
  const c = theme.colors;
  const dark = mode === 'dark';
  const vars: Record<string, string> = {
    '--ghq-primary': c.primary,
    '--ghq-accent': accent || c.accent,
    '--ghq-bg': dark ? '#0f1115' : c.background,
    '--ghq-surface': dark ? '#1a1d24' : c.surface,
    '--ghq-text': dark ? '#f3f4f6' : c.text,
    '--ghq-muted': dark ? '#9ca3af' : c.muted,
    '--ghq-border': dark ? '#2b303b' : 'rgba(0,0,0,.12)',
    '--ghq-font': theme.font_family,
    '--ghq-radius': theme.radius,
    '--ghq-btn-radius': theme.button_style === 'pill' ? '999px' : theme.radius,
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

export const base = css`
  :host {
    display: block;
    font-family: var(--ghq-font, system-ui, sans-serif);
    color: var(--ghq-text, #111);
    line-height: 1.5;
    box-sizing: border-box;
    -webkit-font-smoothing: antialiased;
  }
  *, *::before, *::after { box-sizing: inherit; }
  [hidden] { display: none !important; }
  h1, h2, h3 { line-height: 1.2; margin: 0 0 .5em; }
  h1 { font-size: clamp(1.5rem, 3vw, 2.25rem); }
  h2 { font-size: 1.25rem; }
  p { margin: 0 0 1em; }
  a { color: var(--ghq-accent); }
  .muted { color: var(--ghq-muted); }
  .small { font-size: .875rem; }
  .card {
    background: var(--ghq-surface);
    border: 1px solid var(--ghq-border);
    border-radius: var(--ghq-radius);
    padding: 20px;
  }
  .stack > * + * { margin-top: 14px; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .badge {
    display: inline-block; font-size: .75rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
    padding: 3px 9px; border-radius: 999px; background: var(--ghq-surface); border: 1px solid var(--ghq-border); color: var(--ghq-muted);
  }
  .badge.live { background: #dc2626; color: #fff; border-color: #dc2626; }
  button, .btn {
    font: inherit; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    min-height: 44px; padding: 10px 18px; border-radius: var(--ghq-btn-radius); border: 2px solid var(--ghq-primary);
    background: var(--ghq-primary); color: #fff; text-decoration: none;
  }
  button.secondary, .btn.secondary { background: transparent; color: var(--ghq-primary); }
  button.accent, .btn.accent { background: var(--ghq-accent); border-color: var(--ghq-accent); }
  button.link { background: none; border: none; color: var(--ghq-accent); padding: 4px; min-height: 0; text-decoration: underline; }
  button:disabled { opacity: .6; cursor: progress; }
  button:focus-visible, .btn:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible {
    outline: 3px solid var(--ghq-accent); outline-offset: 2px;
  }
  label { display: block; font-weight: 600; font-size: .9rem; margin-bottom: 4px; }
  input, select, textarea {
    font: inherit; width: 100%; padding: 10px 12px; min-height: 44px; color: var(--ghq-text); background: var(--ghq-bg);
    border: 1px solid var(--ghq-border); border-radius: var(--ghq-radius);
  }
  textarea { min-height: 80px; resize: vertical; }
  .check { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; }
  .check input { width: 20px; min-height: 20px; height: 20px; margin-top: 2px; flex: none; }
  .error { color: #b91c1c; font-size: .9rem; }
  .risk { font-size: .8rem; color: var(--ghq-muted); border-left: 3px solid var(--ghq-accent); padding: 6px 10px; margin-top: 12px; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }
`;
