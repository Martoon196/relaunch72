/** Central owner UI only. Native browser requests and server outcomes remain authoritative. */
export const CENTRAL_ACTION_FEEDBACK_PATH = '/portal/seo-blog/action-feedback.js';

export function centralActionFeedbackHead(enabled: boolean): string {
  return enabled ? `<style>#central-action-feedback{position:fixed;inset:12px 12px auto;z-index:1000;max-width:760px;margin:0 auto;padding:14px 18px;border:2px solid #0b5cad;border-radius:10px;background:#edf4ff;color:#152033;box-shadow:0 4px 20px #0002;font:600 15px/1.5 system-ui}#central-action-feedback[hidden]{display:none}</style><script src="${CENTRAL_ACTION_FEEDBACK_PATH}" defer></script>` : '';
}
export function centralActionFeedbackStatus(enabled: boolean): string {
  return enabled ? '<div id="central-action-feedback" role="status" aria-live="polite" aria-atomic="true" hidden></div>' : '';
}

export const CENTRAL_ACTION_FEEDBACK_SCRIPT = `(() => {
  const status = document.getElementById('central-action-feedback');
  if (!status) return;
  const busyOwners = new Set();
  const reset = () => { status.hidden = true; status.textContent = ''; for (const owner of busyOwners) owner.removeAttribute('aria-busy'); busyOwners.clear(); };
  const show = (message, owner) => { status.textContent = message; status.hidden = false; if (owner) { owner.setAttribute('aria-busy', 'true'); busyOwners.add(owner); } };
  const skippedUrl = (url) => /(?:^|\\/)(?:export|preview)(?:\\/|$)/.test(url.pathname) || url.searchParams.has('download');
  const destination = (raw, target) => {
    if (target && target.toLowerCase() !== '_self') return null;
    try {
      const url = new URL(raw || location.href, location.href);
      return url.origin === location.origin && /^https?:$/.test(url.protocol) && !skippedUrl(url) ? url : null;
    } catch { return null; }
  };
  document.addEventListener('submit', (event) => {
    // A new task runs after dispatch, including later AJAX-owner listeners.
    setTimeout(() => {
      if (event.defaultPrevented) return;
      const form = event.target;
      if (!form || form.tagName !== 'FORM' || form.hasAttribute('data-action-feedback-skip')) return;
      const submitter = event.submitter;
      const target = submitter?.getAttribute('formtarget') ?? form.getAttribute('target');
      const method = (submitter?.getAttribute('formmethod') ?? form.getAttribute('method') ?? 'get').toLowerCase();
      if (!['get', 'post'].includes(method) || submitter?.hasAttribute('download')) return;
      if (!form.noValidate && !submitter?.formNoValidate && !form.checkValidity()) return;
      const url = destination(submitter?.getAttribute('formaction') ?? form.getAttribute('action'), target);
      if (!url) return;
      show(url.pathname.endsWith('/profile/extract') ? 'Working… Extracting the brand profile can take a moment. Please wait for the result.' : 'Working… Please wait for the result.', form);
    }, 0);
  });
  document.addEventListener('click', (event) => {
    setTimeout(() => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target?.closest?.('a[href]');
      if (!link || link.hasAttribute('download') || link.hasAttribute('data-action-feedback-skip')) return;
      const raw = link.getAttribute('href');
      if (!raw || raw.startsWith('#')) return;
      const url = destination(raw, link.getAttribute('target'));
      if (!url || (url.hash && url.pathname === location.pathname && url.search === location.search)) return;
      show('Loading…', document.querySelector('main'));
    }, 0);
  });
  window.addEventListener('pageshow', reset);
  reset();
})();`;
