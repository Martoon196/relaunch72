export function localDateTime(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale || undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));
}

export function localDate(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale || undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
}

export function localTime(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale || undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));
}

export function shortDateTime(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale || undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

export function timeOnly(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale || undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** "2d 4h", "12m 05s" */
export function countdown(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

/** Segments for a tile countdown; days are dropped when zero, seconds when days show. */
export function countdownParts(ms: number): { value: number; label: string }[] {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return [{ value: d, label: d === 1 ? 'day' : 'days' }, { value: h, label: 'hrs' }, { value: m, label: 'min' }];
  return [{ value: h, label: 'hrs' }, { value: m, label: 'min' }, { value: sec, label: 'sec' }];
}

export function utmFromLocation(): Record<string, string> {
  const out: Record<string, string> = {};
  const q = new URLSearchParams(location.search);
  for (const k of ['source', 'medium', 'campaign', 'term', 'content']) {
    const v = q.get(`utm_${k}`);
    if (v) out[k] = v;
  }
  return out;
}
