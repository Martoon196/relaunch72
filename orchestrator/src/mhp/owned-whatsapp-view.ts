import { escapeHtml as esc } from '../portal/ui.js';
import { MHP_OWNED_WHATSAPP_PERMISSION, type MhpOwnedWhatsAppSendResult, type MhpOwnedWhatsAppSnapshot } from './owned-whatsapp-service.js';

export const MHP_OWNED_WHATSAPP_ROUTE = '/hq/marketing/whatsapp';
export function mhpOwnedWhatsAppPage(input: { snapshot: MhpOwnedWhatsAppSnapshot; csrf: string; commandId: string; templateId: string;
  result?: MhpOwnedWhatsAppSendResult; notice?: string }): string {
  const { database, detail, choices, blockers, phone } = input.snapshot;
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
  const form = (action: string, contents: string) => `<form method="post" action="${MHP_OWNED_WHATSAPP_ROUTE}/${action}">${hidden('csrf', input.csrf)}${hidden('commandId', input.commandId)}${contents}</form>`;
  const connected = Boolean(database?.bindingId), template = database?.templates[0];
  const connect = !connected && !blockers.length ? form('connect', `<p>Run the seal tool where the WhatsApp worker key lives, paste your access token into it, and paste its output here. Your token never passes through this page.</p>`
    + `<label>Sealed connection text<textarea name="envelope" rows="7" required></textarea></label>`
    + `<label>MHP WhatsApp sender number<input name="senderNumber" required maxlength="16" placeholder="+447..."></label>`
    + `<label>Where ownership is recorded<input name="ownershipEvidence" required minlength="8" maxlength="500" placeholder="Meta Business Manager WABA ... owned by MH196 Ltd"></label>`
    + `<label class="check"><input type="checkbox" name="confirmed" value="yes" required>This WhatsApp Business number and account belong to Martin Howard Property (MH196 Ltd).</label><button>Connect MHP WhatsApp</button>`) : '';
  const pin = connected && !template && detail ? form('template', `${hidden('templateId', input.templateId)}${hidden('itemId', detail.review.contentItemId)}${hidden('versionId', detail.review.contentVersionId)}${hidden('sha256', detail.review.contentSha256)}`
    + `<blockquote>${esc((detail.payload as { bodyText?: string }).bodyText ?? '')}</blockquote><p>Template <strong>${esc((detail.payload as { templateName?: string }).templateName ?? '')}</strong> · ${esc((detail.payload as { language?: string }).language ?? '')}</p>`
    + `<label>Meta template ID<input name="metaTemplateId" required inputmode="numeric" maxlength="30"></label>`
    + `<label>Category<select name="category"><option value="marketing">Marketing</option><option value="utility">Utility</option></select></label>`
    + `<label>Approval reference<input name="approvalReference" required minlength="8" maxlength="500" placeholder="WhatsApp Manager shows Approved on ..."></label>`
    + `<label class="check"><input type="checkbox" name="confirmed" value="yes" required>Meta shows this exact template as Approved.</label><button>Pin approved template</button>`) : '';
  const ready = connected && template && database?.possessionProven && !database.suppressed;
  const send = template ? form('send', `${hidden('templateId', template.templateId)}<p>Sends template <strong>${esc(template.name)}</strong> once to your own number ${esc(phone ?? '')}. WhatsApp allows one test a day and three a month.</p>`
    + `<label class="check"><input type="checkbox" name="agreed" value="yes" required>${esc(MHP_OWNED_WHATSAPP_PERMISSION)}</label><button${ready ? '' : ' disabled'}>Send my one WhatsApp test</button>`) : '';
  const result = input.result ?? database?.lastResult;
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>MHP WhatsApp · Growth HQ</title>`
    + `<style>body{margin:0;background:#f5f3ed;color:#142019;font:17px/1.6 system-ui,sans-serif}main,header{max-width:940px;margin:auto;padding:24px}section{background:#fff;padding:clamp(20px,4vw,36px);border-radius:18px;margin:20px 0;border:1px solid #d9dfd5}h1{font:38px/1.15 Georgia,serif}label{display:block;margin:18px 0}input,textarea,select,button{font:inherit;box-sizing:border-box}input:not([type=checkbox]):not([type=hidden]),textarea,select{display:block;width:100%;padding:12px;border:1px solid #75846f;border-radius:8px;margin-top:8px}button{background:#e8a33d;border:0;border-radius:9px;padding:14px 20px;font-weight:700;cursor:pointer}button:disabled{opacity:.5}.check{display:flex;gap:12px}.check input{flex:0 0 auto;margin-top:7px}blockquote{white-space:pre-wrap;border-left:4px solid #e8a33d;padding:16px;background:#f6f4ed}.status{padding:14px;background:#eaf0e5;border-radius:8px}a{color:inherit}nav{display:flex;gap:18px}</style></head>`
    + `<body><header><strong>Martin Howard Property · Growth HQ</strong><nav><a href="/hq/marketing">Marketing workspace</a><a href="/hq/marketing/phone-test">Phone test</a></nav></header><main><h1>Connect and test MHP WhatsApp</h1>`
    + `<p>One owner test to your own number. WhatsApp replies such as STOP are not yet recorded as opt-outs, so nobody else can be messaged from here.</p>`
    + `${input.notice ? `<p role="status" class="status">${esc(input.notice)}</p>` : ''}${blockers.length ? `<section><h2>Setup needed</h2><ul>${blockers.map(b => `<li>${esc(b)}</li>`).join('')}</ul></section>` : ''}`
    + `<section><h2>1. MHP WhatsApp sender</h2><p>${connected ? `Connected: ${esc(database?.senderNumber ?? '')} · WABA ${esc(database?.wabaId ?? '')}` : 'Not connected.'}</p>${connect}</section>`
    + `<section><h2>2. Approved template</h2><p>${template ? `Pinned: ${esc(template.name)} · ${esc(template.language)} · ${esc(template.category)}` : 'No template pinned yet.'}</p>`
    + `${!template && choices.length ? `<p>Saved WhatsApp drafts: ${choices.map(c => `<a href="${MHP_OWNED_WHATSAPP_ROUTE}?item=${encodeURIComponent(c.itemId)}&amp;version=${encodeURIComponent(c.versionId)}">${esc(c.label)}</a>`).join(' · ')}</p>` : ''}${pin}</section>`
    + `<section><h2>3. Your one test</h2><p>Your number ${esc(phone ?? '')}: ${database?.possessionProven ? 'proved with an SMS code' : 'not yet proved; verify it on the phone test page'}${database?.suppressed ? ' · blocked by an opt-out' : ''}.</p>${send}</section>`
    + `${result ? `<section><h2>Recorded test status</h2><p role="status" class="status">${esc(result.state)}${result.replayed ? ' · saved outcome of an earlier request; nothing new queued' : ''}</p><p>Queued is not delivered. This page never resends automatically.</p></section>` : ''}</main></body></html>`;
}
