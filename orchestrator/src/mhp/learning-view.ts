import { renderMhpMarkdown } from './markdown.js';
import type { MhpCourseLessonOutline, MhpCourseModuleOutline, MhpCourseOutline, MhpLessonProgress } from './learning-service.js';

const e = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const DOORS: Record<string, string> = { refer: 'Refer', source: 'Source', run: 'Run', own: 'Own', all: 'All doors', foundation: 'Foundations' };
const LEVELS: Record<string, string> = { L1: 'Level 1 · Beginning', L2: 'Level 2 · Building', L3: 'Level 3 · Scaling' };
const JOIN = 'https://martinhowardproperty.co.uk/join/';

const STYLE = `:root{color-scheme:light;--ink:#142019;--muted:#58685e;--line:#d9e0d8;--gold:#e8a33d;--paper:#f5f5ef;--green:#1f6b45}*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}a{color:var(--green);text-underline-offset:3px}
header{background:var(--ink);color:#fff;padding:20px max(20px,calc((100vw - 1160px)/2));display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
header strong{font-size:18px;letter-spacing:-.02em}nav{display:flex;align-items:center;gap:20px;flex-wrap:wrap}nav a{color:#f1bc6b;text-decoration:none;font-weight:650;font-size:15px}
nav button{background:transparent;color:#fff;border:1px solid #66776a;border-radius:6px;padding:6px 10px;font:inherit;font-size:13px;cursor:pointer}
main{max-width:1160px;margin:auto;padding:44px 20px 80px}.eyebrow{font-size:12px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;color:var(--muted)}
h1{font-size:clamp(32px,5vw,50px);line-height:1.08;letter-spacing:-.03em;margin:10px 0 14px}h2{letter-spacing:-.02em;line-height:1.2}
.intro{max-width:680px;color:var(--muted);font-size:19px;margin:0 0 28px}.crumbs{font-size:14px;margin-bottom:18px}.crumbs a{text-decoration:none}
.notice{background:#fff8ea;border:1px solid #f0d29f;border-radius:14px;padding:18px 20px;margin:0 0 28px}.notice.ok{background:#eef7ef;border-color:#b9dcc0}.notice p{margin:4px 0 0}
.meter{height:10px;background:#e3e8e1;border-radius:99px;overflow:hidden}.meter span{display:block;height:100%;background:var(--gold)}
.summary{display:flex;gap:28px;align-items:center;flex-wrap:wrap;background:#fff;border:1px solid var(--line);border-radius:18px;padding:20px 24px;margin-bottom:34px}
.summary .meter{flex:1;min-width:200px}.summary b{font-size:28px;letter-spacing:-.02em}
.level{margin:38px 0 12px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:22px;display:flex;flex-direction:column;gap:10px;text-decoration:none;color:inherit}
a.card:hover{border-color:var(--ink)}.card h3{margin:0;font-size:20px;line-height:1.25;letter-spacing:-.01em}.card p{margin:0;color:var(--muted);font-size:15px}
.tag{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}.lock{color:#9a6a1f}
.lessons{list-style:none;padding:0;margin:0;background:#fff;border:1px solid var(--line);border-radius:18px;overflow:hidden}
.lessons li{border-top:1px solid var(--line)}.lessons li:first-child{border-top:0}.lessons a,.lessons .row{display:grid;grid-template-columns:44px 1fr auto;gap:14px;padding:16px 20px;text-decoration:none;color:inherit;align-items:start}
.lessons a:hover{background:#fafbf7}.num{font-weight:800;color:var(--muted)}.lessons small{display:block;color:var(--muted);font-size:14px}.state{font-size:13px;font-weight:700;white-space:nowrap}
.done{color:var(--green)}.layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:36px;align-items:start}
.prose{background:#fff;border:1px solid var(--line);border-radius:18px;padding:clamp(20px,4vw,44px);max-width:100%}.prose p,.prose li{max-width:72ch}
.prose blockquote{margin:18px 0;padding:4px 18px;border-left:4px solid var(--gold);background:#fbf8f0}.prose pre{background:#f1f3ee;padding:14px;border-radius:10px;overflow:auto;font-size:14px}
.prose code{background:#f1f3ee;padding:1px 5px;border-radius:4px;font-size:.92em}.prose pre code{background:none;padding:0}
.table{overflow-x:auto;margin:18px 0}.prose table{border-collapse:collapse;min-width:100%;font-size:15px}.prose th,.prose td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}.prose th{background:#f4f6f1}
aside{position:sticky;top:18px;display:flex;flex-direction:column;gap:16px}.panel{background:#fff;border:1px solid var(--line);border-radius:18px;padding:20px}.panel h2{font-size:18px;margin:0 0 8px}
.task{background:var(--ink);color:#fff}.task h2{color:#f1bc6b}label.check{display:flex;gap:10px;align-items:flex-start;margin:10px 0;font-size:15px}label.check input{width:20px;height:20px;margin-top:2px;flex:none}
textarea{width:100%;min-height:150px;font:inherit;font-size:15px;padding:10px;border:1.5px solid #8a938c;border-radius:10px}
button.primary{width:100%;background:var(--gold);color:var(--ink);border:0;border-radius:10px;padding:13px 16px;font:inherit;font-weight:750;cursor:pointer;margin-top:8px}
.pager{display:flex;justify-content:space-between;gap:12px;margin-top:22px;flex-wrap:wrap}.pager a{font-weight:650}.small{font-size:14px;color:var(--muted)}
.disclaimer{margin-top:40px;font-size:13px;color:var(--muted);max-width:760px}
.layout>*{min-width:0}@media(max-width:900px){.layout{grid-template-columns:minmax(0,1fr)}aside{position:static}}`;

function frame(title: string, csrf: string, body: string, owner: boolean): string {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)} · Martin Howard Property</title><style>${STYLE}</style></head><body><header><strong>Martin Howard Property</strong><nav aria-label="Member navigation"><a href="/app/learn">Training centre</a><a href="/app/desk">Deal Desk</a><a href="/portal/investors">Investor CRM</a><a href="/app/account">Account</a>${owner ? '<a href="/hq">HQ</a>' : ''}<form method="post" action="/portal/logout"><input type="hidden" name="_csrf" value="${e(csrf)}"><button>Sign out</button></form></nav></header><main>${body}<p class="disclaimer">Education, not legal, tax or financial advice. Rules change: check the current position and take advice before you act. No income is promised. Martin is connected to Property Predator, Key Properties UK, Ordris and Hello New Home and may earn when you use them.</p></main></body></html>`;
}

const counts = (module: MhpCourseModuleOutline, progress: Record<string, MhpLessonProgress>) => {
  const done = module.lessons.filter(l => progress[l.key]?.completed).length;
  return { done, total: module.lessons.length, pct: module.lessons.length ? Math.round(done * 100 / module.lessons.length) : 0 };
};
const moduleName = (m: Pick<MhpCourseModuleOutline, 'number' | 'title'>): string => `Module ${Number(m.number)}: ${m.title}`;

function accessNotice(outline: MhpCourseOutline): string {
  if (outline.tier === 'full') return '';
  if (outline.tier === 'desk') return `<div class="notice"><strong>Module 0 and Module 1 are open to you.</strong><p>Every other module shows its lessons and tasks so you can see what's inside. The full course opens the rest. <a href="${JOIN}">See how to join</a>.</p></div>`;
  return `<div class="notice"><strong>Your account doesn't include the course yet.</strong><p>You can see every module, lesson and task below. Lessons open with Deal Desk (Modules 0 and 1) or the full course (everything). <a href="${JOIN}">See how to join</a>.</p></div>`;
}

export function learnHomePage(outline: MhpCourseOutline, csrf: string): string {
  const all = outline.modules.flatMap(m => m.lessons);
  const done = all.filter(l => outline.progress[l.key]?.completed).length;
  const pct = all.length ? Math.round(done * 100 / all.length) : 0;
  const next = outline.modules.filter(m => m.open).flatMap(m => m.lessons).find(l => !outline.progress[l.key]?.completed);
  const groups = ['L1', 'L2', 'L3', ''].map(level => {
    const modules = outline.modules.filter(m => (m.level ?? '') === level || (level === '' && !['L1', 'L2', 'L3'].includes(m.level ?? '')));
    if (!modules.length) return '';
    return `<h2 class="level">${e(LEVELS[level] ?? 'More modules')}</h2><div class="grid">${modules.map(m => {
      const c = counts(m, outline.progress);
      return `<a class="card" href="/app/learn/${e(m.number)}"><span class="tag">${m.open ? '' : '<span class="lock">Locked · </span>'}${e(DOORS[m.door ?? ''] ?? 'Course')} · ${c.total} ${c.total === 1 ? 'lesson' : 'lessons'}</span><h3>${e(moduleName(m))}</h3>${m.promise ? `<p>${e(m.promise.length > 190 ? `${m.promise.slice(0, 187).trimEnd()}...` : m.promise)}</p>` : ''}<div class="meter" aria-label="${c.done} of ${c.total} lessons complete"><span style="width:${c.pct}%"></span></div><p class="small">${c.done} of ${c.total} complete</p></a>`;
    }).join('')}</div>`;
  }).join('');
  const empty = outline.modules.length ? '' : `<div class="notice"><strong>The lessons are being loaded.</strong><p>${outline.isAdmin ? 'Upload the course bundle in <a href="/hq/course">HQ · Course</a>.' : 'Check back shortly.'}</p></div>`;
  return frame('Training centre', csrf, `<span class="eyebrow">Training centre</span><h1>One lesson, one task,<br>one step forward.</h1><p class="intro">Work through the modules in order, or jump to the door you're working on. Tick each task when you've done it: that's what moves you on.</p>${accessNotice(outline)}${empty}${all.length ? `<div class="summary"><div><b>${done}</b> of ${all.length} lessons complete</div><div class="meter"><span style="width:${pct}%"></span></div>${next ? `<a href="/app/learn/${e(next.key)}">Next: ${e(next.title)} &rarr;</a>` : ''}</div>` : ''}${groups}`, outline.isAdmin);
}

function lessonList(module: MhpCourseModuleOutline, progress: Record<string, MhpLessonProgress>): string {
  return `<ol class="lessons">${module.lessons.map(l => {
    const p = progress[l.key];
    const state = p?.completed ? '<span class="state done">Complete</span>' : p?.taskDone ? '<span class="state">Task done</span>' : '';
    const inner = `<span class="num">${String(l.position).padStart(2, '0')}</span><span><strong>${e(l.title)}</strong>${l.task ? `<small>Task: ${e(l.task)}</small>` : ''}</span><span>${l.minutes ? `<small>${l.minutes} min</small>` : ''}${state}</span>`;
    return `<li>${module.open ? `<a href="/app/learn/${e(l.key)}">${inner}</a>` : `<div class="row">${inner}</div>`}</li>`;
  }).join('')}</ol>`;
}

export function learnModulePage(outline: MhpCourseOutline, module: MhpCourseModuleOutline, content: { overview?: string; sources?: string } | null, csrf: string): string {
  const c = counts(module, outline.progress);
  const locked = module.open ? '' : `<div class="notice"><strong>This module is part of the full course.</strong><p>Here's everything it covers, lesson by lesson. <a href="${JOIN}">See how to join</a>.</p></div>`;
  const overview = content?.overview ? `<h2>About this module</h2><div class="prose">${renderMhpMarkdown(content.overview)}</div>` : '';
  const sources = content?.sources ? `<details class="panel" style="margin-top:22px"><summary><strong>Sources and further reading</strong></summary><div class="prose" style="border:0;padding:12px 0 0">${renderMhpMarkdown(content.sources)}</div></details>` : '';
  return frame(moduleName(module), csrf, `<p class="crumbs"><a href="/app/learn">&larr; Training centre</a></p><span class="eyebrow">${e(LEVELS[module.level ?? ''] ?? 'Course')} · ${e(DOORS[module.door ?? ''] ?? '')}</span><h1>${e(moduleName(module))}</h1>${module.promise ? `<p class="intro">${e(module.promise)}</p>` : ''}${locked}${module.lessons.length ? `<div class="summary"><div><b>${c.done}</b> of ${c.total} complete</div><div class="meter"><span style="width:${c.pct}%"></span></div></div>` : ''}${lessonList(module, outline.progress)}${overview ? `<div style="margin-top:34px">${overview}</div>` : ''}${sources}`, outline.isAdmin);
}

export function learnLessonPage(input: { outline: MhpCourseOutline; module: MhpCourseModuleOutline; lesson: MhpCourseLessonOutline; body: string; csrf: string; saved?: boolean }): string {
  const { outline, module, lesson, csrf } = input;
  const p = outline.progress[lesson.key] ?? { taskDone: false, completed: false, notes: '' };
  const index = module.lessons.findIndex(l => l.key === lesson.key);
  const prev = module.lessons[index - 1], next = module.lessons[index + 1];
  const later = !next ? outline.modules.slice(outline.modules.findIndex(m => m.number === module.number) + 1).find(m => m.open && m.lessons.length) : undefined;
  const nextLink = next ? `<a href="/app/learn/${e(next.key)}">Next: ${e(next.title)} &rarr;</a>` : later ? `<a href="/app/learn/${e(later.number)}">Next module: ${e(later.title)} &rarr;</a>` : '<a href="/app/learn">Back to the training centre &rarr;</a>';
  return frame(lesson.title, csrf, `<p class="crumbs"><a href="/app/learn">Training centre</a> / <a href="/app/learn/${e(module.number)}">${e(moduleName(module))}</a></p><span class="eyebrow">Lesson ${lesson.position}${lesson.minutes ? ` · ${lesson.minutes} minutes` : ''}</span><h1>${e(lesson.title)}</h1>${input.saved ? '<div class="notice ok"><strong>Saved.</strong></div>' : ''}<div class="layout"><article class="prose">${renderMhpMarkdown(input.body)}</article><aside>${lesson.task ? `<div class="panel task"><h2>Your task</h2><p>${e(lesson.task)}</p></div>` : ''}<form class="panel" method="post" action="/app/learn/${e(lesson.key)}"><h2>Your progress</h2><input type="hidden" name="csrf" value="${e(csrf)}">${lesson.task ? `<label class="check"><input type="checkbox" name="taskDone" value="yes"${p.taskDone ? ' checked' : ''}> I've done the task</label>` : ''}<label class="check"><input type="checkbox" name="complete" value="yes"${p.completed ? ' checked' : ''}> Lesson complete</label><label for="notes" class="small">Your notes (only you can see these)</label><textarea id="notes" name="notes" maxlength="10000">${e(p.notes)}</textarea><button class="primary">Save progress</button></form></aside></div><div class="pager">${prev ? `<a href="/app/learn/${e(prev.key)}">&larr; ${e(prev.title)}</a>` : '<span></span>'}${nextLink}</div>`, outline.isAdmin);
}
