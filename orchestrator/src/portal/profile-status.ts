export const PROFILE_STATUS_SCRIPT = `(() => {
  const status = document.querySelector('[data-profile-status-url]');
  if (!status) return;
  const detail = status.querySelector('[data-profile-status-detail]');
  const review = status.querySelector('[data-profile-review]');
  let stopped = false; let polls = 0; let timer;
  const stop = () => { stopped = true; clearTimeout(timer); };
  const poll = async () => {
    if (stopped) return;
    try {
      const response = await fetch(status.getAttribute('data-profile-status-url'), { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('status unavailable');
      const data = await response.json();
      if (stopped) return;
      detail.textContent = data.state + ': ' + data.detail;
      if (!['queued', 'running'].includes(data.state)) { if (review) review.hidden = false; stop(); return; }
      if (++polls >= 100) { detail.textContent += ' Check again with Refresh status; this page has stopped polling.'; stop(); return; }
      timer = setTimeout(poll, 3000);
    } catch {
      if (!stopped) detail.textContent = 'Status could not be checked. The task may still be running. Use Refresh status to check again.';
      stop();
    }
  };
  window.addEventListener('pagehide', stop);
  timer = setTimeout(poll, 1000);
})();`;
