/**
 * One structured start-up log line saying which paid and optional parts of the SEO blog engine are switched on in this
 * process, read from the same runtime objects the engine is built with. Never a setting's value, a credential or
 * supplier account details: only on/off states. For the operator's logs, never for a page.
 */

export interface SeoBlogCapabilities {
  /** The research provider's own mode (live only when it has credentials). */
  readonly search: 'live' | 'unconfigured';
  /** The keyword-numbers provider's mode, or off when the engine has none. Mock numbers never count as on. */
  readonly keywords: 'live' | 'mock' | 'off';
  /** Whether the engine was given a method controller (the writing-methods switch). */
  readonly methods: boolean;
}

export function seoBlogCapabilitiesLine(process: 'portal' | 'worker', c: SeoBlogCapabilities): string {
  return JSON.stringify({ event: 'seo-blog.capabilities', process, research: c.search === 'live' ? 'live' : 'unconfigured', searchNumbers: c.keywords === 'live' ? 'on' : 'off', writingMethods: c.methods ? 'on' : 'off' });
}

let portalLogged = false;
/** Logs the portal's line once per process (the service may be created more than once, for example in tests). */
export function logPortalSeoBlogCapabilities(c: SeoBlogCapabilities, log: (line: string) => void = console.log): void {
  if (portalLogged) return;
  portalLogged = true;
  log(seoBlogCapabilitiesLine('portal', c));
}
