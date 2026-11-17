import { escapeHtml as e } from '../portal/ui.js';

/**
 * The owner's MHP marketing pages share one frame: header navigation, a plain message
 * and a way back. Errors from these areas render inside it instead of as bare text, so
 * the owner is never left on a white page with nowhere to go.
 */
export const MHP_OWNER_STYLES = `body{margin:0;background:#f5f3ed;color:#142019;font:17px/1.65 system-ui,sans-serif}header,main{max-width:1080px;margin:auto;padding:24px;box-sizing:border-box}header,nav,.actions{display:flex;gap:14px;flex-wrap:wrap;align-items:center}header{justify-content:space-between}a{color:#215c3d}h1{font:clamp(30px,5vw,46px)/1.15 Georgia,serif;margin:8px 0 18px}h2{font-size:25px}h3{font-size:20px}.card{background:#fff;border:1px solid #d9ded4;border-radius:18px;padding:clamp(18px,4vw,36px);margin:0 0 24px;min-width:0}.eyebrow{font-size:13px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#83510c}.note{font-size:16px;color:#526154}.notice{border-left:4px solid #b57212;background:#fbf4e5;padding:16px;margin:20px 0}.good{border-left:4px solid #2f7a4d;background:#eaf5ee;padding:16px;margin:20px 0}.wrap{overflow-wrap:anywhere}button,.button{display:inline-block;box-sizing:border-box;max-width:100%;border:0;border-radius:9px;padding:14px 20px;background:#e8a33d;color:#142019;font:700 17px/1.4 system-ui;cursor:pointer;text-decoration:none;text-align:center}.secondary{background:#eeeee7;border:1px solid #bac5b8}button:disabled{opacity:.55;cursor:not-allowed}p{max-width:75ch}a,button,input,select{overflow-wrap:anywhere}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #83510c;outline-offset:3px}@media(max-width:480px){header,main{padding:16px}.actions>*{max-width:100%;width:100%}.actions button,.actions .button{width:100%}}`;
export const MHP_OWNER_NAV = '<header><strong>Martin Howard Property</strong><nav aria-label="Owner navigation"><a href="/hq/marketing">Marketing workspace</a><a href="/hq/marketing/sequences">Follow-up sequences</a><a href="/hq/marketing/emails">Email library</a><a href="/portal/crm/opportunities">Enquiry board</a></nav></header>';

export interface MhpOwnerProblem {
  /** Short heading, e.g. "Open your marketing workspace". */
  readonly heading: string;
  readonly message: string;
  /** Already-escaped HTML controls (links or forms) shown under the message. */
  readonly actions: string;
  readonly title?: string;
}
export function mhpOwnerProblemPage(problem: MhpOwnerProblem): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(problem.title ?? 'Something needs attention')} · MHP Growth HQ</title><style>${MHP_OWNER_STYLES}</style></head><body>${MHP_OWNER_NAV}<main>
  <section class="card" role="alert"><div class="eyebrow">Growth HQ · MHP brand</div><h1>${e(problem.heading)}</h1><p>${e(problem.message)}</p><div class="actions">${problem.actions}</div></section></main></body></html>`;
}
/** True when the cause is that the MHP marketing workspace is not the one selected in this session. */
export function mhpWorkspaceProblem(status: number, message: string): boolean {
  return status === 403 && /marketing workspace|owner workspace/iu.test(message);
}
export const mhpLink = (href: string, label: string, secondary = false): string => `<a class="button${secondary ? ' secondary' : ''}" href="${e(href)}">${e(label)}</a>`;
