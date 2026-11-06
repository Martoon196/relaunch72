/** Inline SVG icons (24px grid, currentColor). No icon font, no emoji, nothing to load. */
import { html, type TemplateResult } from 'lit';

const i = (paths: string, filled = false): TemplateResult => html`<svg viewBox="0 0 24 24" aria-hidden="true" fill=${filled ? 'currentColor' : 'none'} stroke=${filled ? 'none' : 'currentColor'} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" .innerHTML=${paths}></svg>`;

export const icon = {
  play: () => i('<path d="M7 4.5v15l12-7.5z"/>', true),
  pause: () => i('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>', true),
  volume: () => i('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'),
  muted: () => i('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>'),
  captions: () => i('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3"/>'),
  expand: () => i('<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  calendar: () => i('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>'),
  clock: () => i('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  check: () => i('<path d="m5 12 5 5L20 7"/>'),
  checkCircle: () => i('<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>'),
  users: () => i('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4.5-6.2"/>'),
  pin: () => i('<path d="M12 17v5M5 17h14l-2-5V6a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v6z"/>'),
  send: () => i('<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>'),
  download: () => i('<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),
  external: () => i('<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>'),
  arrow: () => i('<path d="M5 12h14m-6-6 6 6-6 6"/>'),
  chat: () => i('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/>'),
  question: () => i('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/>'),
  poll: () => i('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  sparkle: () => i('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>', true),
  alert: () => i('<path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'),
  close: () => i('<path d="M18 6 6 18M6 6l12 12"/>'),
  megaphone: () => i('<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/>'),
  lock: () => i('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  replay: () => i('<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/>'),
  eyeOff: () => i('<path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10 10 0 0 1 12 5c5 0 9 4 10 7a11 11 0 0 1-3.2 4.3M6.6 6.6A11 11 0 0 0 2 12c1 3 5 7 10 7a10 10 0 0 0 4.1-.9"/>'),
  eye: () => i('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  ban: () => i('<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>'),
  reply: () => i('<path d="M9 17 4 12l5-5M4 12h11a5 5 0 0 1 5 5v2"/>'),
  stop: () => i('<rect x="5" y="5" width="14" height="14" rx="2"/>', true),
  radio: () => i('<circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/>'),
};

export type IconName = keyof typeof icon;
