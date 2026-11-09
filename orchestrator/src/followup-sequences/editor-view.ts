import { escapeHtml as e } from '../portal/ui.js';
import { followupEntryIntent, type FollowupBrand, type FollowupChannel, type FollowupSequenceDefinition } from './definition.js';
import type { FlowInlineMessage } from './composition.js';
export interface FlowMessageChoice { readonly channel: FollowupChannel; readonly itemId: string; readonly versionId: string; readonly sha256: string; readonly label: string }
export interface FlowEditorProfile { readonly brand: FollowupBrand; readonly base: '/hq/marketing/sequences' | '/portal/follow-ups'; readonly libraryHref: string | null; readonly futureWebinarEntry: boolean }
export interface FlowEditorInput {
  readonly profile: FlowEditorProfile; readonly csrf: string; readonly commandId: string; readonly contentItemId: string; readonly previousVersionId: string;
  readonly definition: FollowupSequenceDefinition; readonly choices: readonly FlowMessageChoice[];
  readonly inlineMessages?: Readonly<Record<string, FlowInlineMessage>>;
  readonly detail?: { readonly versionNumber: number; readonly published: boolean; readonly isLatest: boolean };
}
const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${e(value)}">`;
/** The same native composition UI is used by both brand-authority adapters. */
export function renderFlowEditor(input: FlowEditorInput): string {
  const { profile, definition, detail } = input;
  return `<section class="card"><style>.flow-inline{border:1px solid #c7d0c4;border-radius:10px;margin:18px 0;padding:18px;min-width:0}.flow-inline textarea{box-sizing:border-box;display:block;width:100%;max-width:100%;min-height:180px;padding:13px;margin-top:7px;border:1px solid #9da99b;border-radius:8px;font:17px/1.6 system-ui;background:#fff;color:#142019;resize:vertical}.flow-inline legend{font-weight:800;padding:0 8px}</style>
    <div class="eyebrow">${detail ? `Version ${detail.versionNumber} · ${detail.published ? 'Published' : detail.isLatest ? 'Draft' : 'Older version'}` : 'New sequence'}</div>
    <h2>${detail ? 'Edit your sequence' : 'Build the next conversation'}</h2><p>Add messages and waits, then drag steps or use Move up / Move down. Write messages in their steps or choose exact versions from your local library.</p>
    ${profile.libraryHref ? `<p><a href="${e(profile.libraryHref)}">Open the email library</a></p>` : ''}
    <form method="post" action="${profile.base}/save" data-sequence-editor data-initial="${e(JSON.stringify(definition))}" data-emails="${e(JSON.stringify(input.choices.filter(choice => choice.channel === 'email')))}" data-messages="${e(JSON.stringify(input.choices))}" data-message-endpoint="${profile.base}/message">
    ${hidden('csrf', input.csrf)}${hidden('commandId', input.commandId)}${hidden('contentItemId', input.contentItemId)}${hidden('previousVersionId', input.previousVersionId)}${hidden('definition', JSON.stringify(definition))}${hidden('inlineMessages', JSON.stringify(input.inlineMessages ?? {}))}
    <label>Sequence name<input data-field="title" maxlength="180" value="${e(definition.title)}" required></label>
    ${profile.futureWebinarEntry ? `<label>How people join<select data-entry-mode><option value="manual" ${followupEntryIntent(definition).mode === 'manual' ? 'selected' : ''}>Manual start — current webinar sign-ups</option><option value="webinar_signup" ${followupEntryIntent(definition).mode === 'webinar_signup' ? 'selected' : ''}>Future opted-in webinar sign-ups</option></select></label><p class="note">Choosing future sign-ups saves your intent. Publish this version, then explicitly enable its future-signup rule below. Existing registrations stay on the separate manual Start action.</p>`
      : '<p class="notice">Build now; connect and test before starting. You will choose the people to add when PP delivery is connected.</p>'}
    <label>Retry window for each message (hours)<input data-field="expiryHours" type="number" min="1" max="168" value="${definition.expiryHours}" required></label>
    <p class="note">The retry window starts when that message is due. Expired work is shown; it is never silently extended.</p>
    <div data-steps></div><div class="actions"><button type="button" data-add="email" class="secondary">+ Email</button><button type="button" data-add="wait" class="secondary">+ Wait</button><button type="button" data-add="sms" class="secondary">+ Text message</button><button type="button" data-add="whatsapp" class="secondary">+ WhatsApp</button></div>
    <h3>When should this stop?</h3><p>Unsubscribing or Stop prevents further messages on connected channels. Simulation sends nothing and changes no real permissions.</p>
    ${(['reply', 'booked', 'purchased'] as const).map(key => `<label class="check"><input type="checkbox" data-stop="${key}" ${definition.stopOn[key] ? 'checked' : ''}> ${key === 'reply' ? 'When they reply' : key === 'booked' ? 'When they book' : 'When they buy'} <span class="note">— event connection pending; selecting this blocks actual Start</span></label>`).join('')}
    <p data-editor-status role="status" class="note"></p><noscript><p>The visual step editor needs JavaScript. Saved flows remain available for reading and their existing controls.</p></noscript>
    <label>Simulation scenario<select name="simulationCase"><option value="happy">Complete planned journey</option><option value="pause">Pause for 15 minutes, then resume</option><option value="reply">Sample reply after the first message</option><option value="booked">Sample booking after the first message</option><option value="purchased">Sample purchase after the first message</option><option value="unsubscribe">Sample unsubscribe after the first message</option><option value="failed">First message fails</option><option value="unknown">First message outcome is unknown</option></select></label>
    <div class="actions"><button formaction="${profile.base}/preview" class="secondary">Preview timeline</button><button formaction="${profile.base}/simulate" class="secondary">Simulate journey</button><button ${detail && !detail.isLatest ? 'disabled' : ''}>Save draft</button></div></form>
    <p class="note">Save keeps a version of your messages and flow. Other flows keep the wording you chose and show when it needs review. Publishing sends nothing and does not connect a sender.</p>
    ${profile.brand === 'mhp' ? '<p class="note">Saving an edit holds unsent runs on the older sequence. Those runs keep their history; cancel them before a fresh start. A fresh start begins at the first step and can repeat earlier messages.</p>' : ''}</section>`;
}
