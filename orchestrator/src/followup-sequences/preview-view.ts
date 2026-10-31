import { escapeHtml as e } from '../portal/ui.js';
import { previewFlowMessage } from './channel-drafts.js';
import type { simulateFollowupFlow } from './simulation.js';
export function renderFlowMessagePreviews(previews: readonly ReturnType<typeof previewFlowMessage>[]): string {
  if (!previews.length) return '';
  return `<section class="card"><h2>Review the message copy</h2><p>Synthetic sample values only. These previews send nothing and do not create provider-approved templates.</p>
    ${previews.map((message, at) => `<article class="run"><h3>${at + 1}. ${message.channel === 'email' ? 'Email' : message.channel === 'sms' ? 'Text message' : 'WhatsApp template draft'}</h3>
      ${message.subject ? `<p><strong>${e(message.subject)}</strong></p>` : ''}<pre style="font:17px/1.7 system-ui;white-space:pre-wrap;overflow-wrap:anywhere">${e(message.text)}</pre>
      ${message.feedback ? `<p class="notice">${e(message.feedback.message)}</p>` : ''}${message.channel === 'whatsapp' ? `<p class="notice">Local template draft · not provider approved. ${message.parameterCount ? `${message.parameterCount} parameter${message.parameterCount === 1 ? '' : 's'} also need a later connection.` : 'A matching approved zero-parameter provider template and sender still need connecting.'}</p>` : ''}</article>`).join('')}</section>`;
}
export function renderFlowSimulation(result: ReturnType<typeof simulateFollowupFlow> | undefined): string {
  if (!result) return '';
  return `<section class="card"><div class="eyebrow">Simulation only</div><h2>Preview the journey</h2><p><strong>Nothing was sent, enrolled or saved.</strong> ${e(result.recipient)}. State: ${e(result.state)}.</p>
    ${result.assumesSyntheticConnections ? '<p class="notice">This walkthrough assumes synthetic connections so you can inspect the complete planned journey. It is not delivery or permission evidence.</p>' : ''}
    ${result.actualStartBlocked ? `<p class="notice">Actual Start is blocked: ${result.actualBlockers.map(blocker => e(blocker.replaceAll('_', ' '))).join('; ')}. Connect and test those parts separately.</p>` : '<p>Connection checks do not prove delivery. A real send still needs the person’s permission and the current approved message.</p>'}
    <ol>${result.lines.map(line => `<li><time datetime="${e(line.at)}">${e(new Date(line.at).toLocaleString('en-GB', { timeZone: 'Europe/London' }))} UK</time> — ${e(line.label)}</li>`).join('')}</ol></section>`;
}
