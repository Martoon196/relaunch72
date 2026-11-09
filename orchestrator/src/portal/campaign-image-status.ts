/** Read-only bounded progress. Never reloads over owner edits or submits generation work. */
export const CAMPAIGN_IMAGE_STATUS_SCRIPT = `(() => {
  const tasks = [...document.querySelectorAll('[data-campaign-image-task]')];
  if (!tasks.length) return;
  let generation = 0; const timers = new Set(); const requests = new Set();
  const reset = () => { generation++; for (const timer of timers) clearTimeout(timer); timers.clear(); for (const request of requests) request.abort(); requests.clear(); };
  const poll = async (node, round, epoch) => {
    if (epoch !== generation || !node.isConnected) return;
    if (round >= 90) { const detail = node.querySelector('[data-task-detail]'); if (detail) detail.textContent = 'Automatic progress checks paused. Save any edits, then refresh this page to check the latest result.'; return; }
    let endpoint; try { endpoint = new URL(node.dataset.endpoint, location.href); } catch { return; }
    if (endpoint.origin !== location.origin || !/^\\/portal\\/seo-blog\\/b\\/[0-9a-f-]{36}\\/image\\/status$/.test(endpoint.pathname)) return;
    const controller = new AbortController(); requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10000); timers.add(timeout);
    try {
      const response = await fetch(endpoint.href, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) throw Error('Unavailable');
      const result = await response.json();
      if (epoch !== generation || !node.isConnected) return;
      if (!result || result.id !== node.dataset.campaignImageTask || !['queued','running','done','blocked','failed','cancelled'].includes(result.state) || typeof result.detail !== 'string' || result.detail.length > 600) throw Error('Invalid status');
      const labels = { queued: 'Waiting to start', running: 'Preparing images', done: 'Needs checking', blocked: 'Needs attention', failed: 'Needs checking', cancelled: 'Cancelled' };
      const detail = node.querySelector('[data-task-detail]'); if (detail) detail.textContent = result.prepared === true ? 'Images ready to review' : labels[result.state];
      const technical = node.querySelector('[data-task-technical]'); if (technical) technical.textContent = result.state + ' · ' + result.detail;
      const ready = node.querySelector('[data-task-result]'); if (ready) {
        ready.hidden = result.prepared !== true && ['queued','running'].includes(result.state);
        const link = ready.querySelector('a'); if (link) link.textContent = result.prepared === true ? 'View saved images' : 'See what needs checking';
      }
      if (!['queued','running'].includes(result.state)) return;
    } catch (error) {
      if (epoch !== generation) return;
      const detail = node.querySelector('[data-task-detail]'); if (detail) detail.textContent = 'Progress temporarily unavailable. Save any edits, then refresh to check the saved request.';
    } finally { clearTimeout(timeout); timers.delete(timeout); requests.delete(controller); }
    if (epoch !== generation) return;
    const timer = setTimeout(() => { timers.delete(timer); void poll(node, round + 1, epoch); }, 5000); timers.add(timer);
  };
  const start = () => { const epoch = generation; for (const task of tasks) void poll(task, 0, epoch); };
  addEventListener('pagehide', reset); addEventListener('pageshow', event => { if (event.persisted) { reset(); start(); } });
  start();
})();`;
