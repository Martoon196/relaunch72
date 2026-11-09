/** Progressive enhancement only; all records and permissions remain server-owned. */
export const INVESTOR_CLIENT_SOURCE = `document.addEventListener('click', async event => {
  const button = event.target instanceof Element ? event.target.closest('[data-copy-template]') : null;
  if (!(button instanceof HTMLButtonElement)) return;
  const field = document.getElementById(button.dataset.copyTemplate || '');
  const status = button.parentElement.querySelector('[data-copy-status]');
  if (!(field instanceof HTMLTextAreaElement) || !status) return;
  try {
    await navigator.clipboard.writeText(field.value);
    status.textContent = button.dataset.copySuccess || 'Copied. Review it before sending.';
  } catch {
    field.focus(); field.select();
    status.textContent = 'Text selected. Use your device’s Copy command.';
  }
});`;
