/**
 * <script src="https://cdn.webinars.growthhq.app/v1/embed.js" data-key="pk_live_…" defer></script>
 * Reads its own data attributes, then loads the component bundle next to it.
 */
interface EmbedConfig { key: string; api: string; base: string }
declare global { interface Window { __GHQ_EMBED__?: EmbedConfig } }

(() => {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script?.src || window.__GHQ_EMBED__) return;
  const src = new URL(script.src);
  window.__GHQ_EMBED__ = {
    key: script.dataset.key ?? '',
    api: (script.dataset.api ?? src.origin).replace(/\/+$/, ''),
    base: new URL('.', src).href,
  };
  import(/* webpackIgnore: true */ new URL('embed-app.js', src).href).catch((err) => console.error('[ghq-webinar] failed to load', err));
})();

export {};
