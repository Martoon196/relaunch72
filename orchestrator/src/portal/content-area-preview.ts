/**
 * The content area preview switch.
 *
 * The new shell renders only when BOTH are true:
 * 1. the server's CONTENT_AREA_PREVIEW environment variable is exactly "enabled", and
 * 2. this browser has opted in: the owner pressed "Try the new look" (a CSRF-protected POST to
 *    /portal/seo-blog/look), which set the cookie below. "Back to the old look" clears it.
 *
 * Otherwise every page renders exactly as before. Nothing is stored in the database.
 */
import type { IncomingMessage } from 'node:http';

export const CONTENT_AREA_COOKIE = 'r72_content_look';
export const CONTENT_AREA_LOOK_PATH = '/portal/seo-blog/look';

/** The server-side switch (the environment variable, or the router input that overrides it in tests). */
export function contentAreaPreviewAllowed(value: string | undefined): boolean {
  return value === 'enabled';
}

/** This browser has chosen the new look. */
export function contentAreaCookieOn(req: Pick<IncomingMessage, 'headers'>): boolean {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return false;
  return header.split(';').some((part) => part.trim() === `${CONTENT_AREA_COOKIE}=new`);
}

/** Sets or clears the choice. Only a preference: it grants nothing and holds no identity. */
export function contentAreaCookie(on: boolean, secure: boolean): string {
  const bits = [`${CONTENT_AREA_COOKIE}=${on ? 'new' : ''}`, 'HttpOnly', 'SameSite=Lax', 'Path=/portal/seo-blog', `Max-Age=${on ? 180 * 24 * 3600 : 0}`];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** Where to go after switching: only a page of the content area itself, never another site. */
export function contentAreaBack(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  return /^\/portal\/seo-blog(?:\/[A-Za-z0-9/_.-]*)?(?:\?[A-Za-z0-9=&_.%-]*)?$/.test(v) && !v.includes('//') && !v.includes('..') ? v : '/portal/seo-blog';
}
