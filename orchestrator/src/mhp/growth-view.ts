import { MHP_EVENT_NAMES, type MhpApplicationRecord, type MhpGrowthSummary } from './growth-service.js';

const e = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const STYLE = `:root{color-scheme:light;--ink:#142019;--muted:#58685e;--line:#d9e0d8;--gold:#e8a33d;--paper:#f5f5ef}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 system-ui,-apple-system,sans-serif}a{color:#1f6b45}header{background:var(--ink);color:#fff;padding:20px max(20px,calc((100vw - 1160px)/2));display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}header strong{font-size:18px}nav{display:flex;gap:20px;flex-wrap:wrap}nav a{color:#f1bc6b;text-decoration:none;font-weight:650}main{max-width:1160px;margin:auto;padding:44px 20px 80px}.eyebrow{font-size:12px;letter-spacing:.15em;text-transform:uppercase;font-weight:700;color:var(--muted)}h1{font-size:clamp(30px,4vw,44px);line-height:1.1;letter-spacing:-.03em;margin:8px 0 14px}.intro{color:var(--muted);max-width:680px}.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;margin:26px 0}.stat{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px}.stat b{display:block;font-size:30px;letter-spacing:-.02em}.stat span{color:var(--muted);font-size:14px}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden}th,td{text-align:left;padding:10px 14px;border-top:1px solid var(--line)}th{background:#f4f6f1}.panel{background:#fff;border:1px solid var(--line);border-radius:16px;padding:22px;margin:22px 0;max-width:720px}.notice{background:#eef7ef;border:1px solid #b9dcc0;border-radius:14px;padding:14px 18px;margin:18px 0}button{background:var(--gold);color:var(--ink);border:0;border-radius:10px;padding:12px 16px;font:inherit;font-weight:750;cursor:pointer}input[type=file]{margin:12px 0;display:block}.small{font-size:14px;color:var(--muted)}.funnel{display:flex;flex-wrap:wrap;gap:10px;align-items:stretch;margin:18px 0 26px}.funnel .stat{flex:1 1 170px}.funnel .rate{align-self:center;color:var(--muted);font-size:14px;font-weight:650}.scroll{overflow-x:auto}.scroll table{min-width:960px}td.long{white-space:pre-wrap;overflow-wrap:anywhere;min-width:220px}`;

function frame(title: string, body: string): string {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)} · Martin Howard Property</title><style>${STYLE}</style></head><body><header><strong>Martin Howard Property</strong><nav aria-label="Owner navigation"><a href="/hq">Access</a><a href="/hq/growth">Growth</a><a href="/hq/applications">Applications</a><a href="/hq/course">Course</a><a href="/hq/verdicts">Verdicts</a><a href="/app/learn">Training centre</a></nav></header><main>${body}</main></body></html>`;
}

export function hqGrowthPage(summary: MhpGrowthSummary, marketingMode: string): string {
  const stat = (value: number | string, label: string): string => `<div class="stat"><b>${e(value)}</b><span>${e(label)}</span></div>`;
  const kinds = summary.byKind ?? {};
  const levels = summary.byLevel ?? {};
  const mode = marketingMode === 'live' ? 'Emails are sending to everyone who signs up.'
    : marketingMode === 'test' ? 'Test mode: only the test inboxes receive emails. Everyone else waits in the queue.'
      : 'Emails are switched off. Sign-ups are saved and their emails wait in the queue (reminders that miss their moment are dropped).';
  return frame('Growth', `<span class="eyebrow">Owner HQ · Growth</span><h1>Who's coming in.</h1><p class="intro">Counts only. Email addresses stay in the database and never appear on this page.</p><div class="notice"><strong>Email: ${e(marketingMode)}.</strong> ${e(mode)}</div><div class="stats">${stat(summary.prospects, 'people on the list')}${stat(summary.signupsToday, 'sign-ups today')}${stat(kinds.webinar ?? 0, 'webinar registrations')}${stat(kinds.sheet ?? 0, 'cheat sheet downloaders')}${stat(kinds.waitlist ?? 0, 'on the course waitlist')}${stat(summary.unsubscribed, 'unsubscribed')}${stat(summary.sends.sent, 'emails sent')}${stat(summary.sends.pending, 'emails waiting')}${stat(summary.sends.failed, 'emails failed')}${stat(summary.storiesWaiting, `stories to review (${summary.stories} total)`)}${stat(summary.learners, 'members learning')}${stat(summary.lessonsCompleted, 'lessons completed')}</div>${funnel(summary)}<h2>By level</h2><p>${['L1', 'L2', 'L3', 'unknown'].map(level => `${level === 'unknown' ? 'No quiz' : level}: <strong>${e(levels[level] ?? 0)}</strong>`).join(' · ')}</p><h2>By sign-up</h2><table><thead><tr><th>Form</th><th>People</th></tr></thead><tbody>${summary.byLabel.map(row => `<tr><td>${e(row.label)}</td><td>${e(row.count)}</td></tr>`).join('') || '<tr><td colspan="2">No sign-ups yet.</td></tr>'}</tbody></table>`);
}

const EVENT_LABELS: Record<string, string> = {
  webinar_page_viewed: 'Webinar page viewed', live_page_opened: 'Live page opened', replay_page_opened: 'Replay page opened',
  diagnostic_started: 'First Door check started', diagnostic_completed: 'First Door check completed', offer_viewed: 'Mentoring offer viewed',
  application_started: 'Application started',
};

function funnel(summary: MhpGrowthSummary): string {
  const events = summary.events ?? {};
  const stages: { label: string; value: number | null }[] = [
    { label: 'webinar registrations', value: summary.byKind?.webinar ?? 0 },
    { label: 'live page opens', value: events.live_page_opened ?? 0 },
    { label: 'applications', value: summary.applications?.total ?? 0 },
    { label: 'calls and enrolments (recorded manually for now)', value: null },
  ];
  const parts: string[] = [];
  stages.forEach((stage, index) => {
    const previous = stages[index - 1];
    if (previous) {
      const rate = previous.value && stage.value !== null ? `${Math.round((stage.value / previous.value) * 100)}%` : '';
      parts.push(`<span class="rate" aria-hidden="true">${rate ? `&rarr; ${e(rate)}` : '&rarr;'}</span>`);
    }
    parts.push(`<div class="stat"><b>${stage.value === null ? '&ndash;' : e(stage.value)}</b><span>${e(stage.label)}</span></div>`);
  });
  const doors = Object.entries(summary.applicationsByDoor ?? {}).sort((a, b) => b[1] - a[1]);
  const rows = MHP_EVENT_NAMES.map(name => `<tr><td>${e(EVENT_LABELS[name] ?? name)}</td><td>${e(events[name] ?? 0)}</td></tr>`).join('');
  return `<h2>Webinar funnel</h2><p class="small">Counts only. Percentages compare each stage with the one before. A page opened is a page load, not proof that anyone watched.</p><div class="funnel">${parts.join('')}</div>`
    + `<p>Applications today: <strong>${e(summary.applications?.today ?? 0)}</strong>${doors.length ? ` · By door: ${doors.map(([door, n]) => `${e(door)} <strong>${e(n)}</strong>`).join(' · ')}` : ''} · <a href="/hq/applications">See applications</a></p>`
    + `<h2>Page events, last 30 days</h2><table><thead><tr><th>Event</th><th>Count</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function hqApplicationsPage(applications: readonly MhpApplicationRecord[]): string {
  const when = (value: string): string => new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' });
  const rows = applications.map(a => `<tr><td>${e(when(a.createdAt))}</td><td>${e(a.status)}</td><td>${e(a.name)}<br><a href="mailto:${e(a.email)}">${e(a.email)}</a>${a.phone ? `<br>${e(a.phone)}` : ''}</td><td>${e(a.location)}</td><td>${e(a.door)}</td><td>${e(a.experience)}</td><td>${e(a.hours)}</td><td class="long">${e(a.objective)}</td><td>${e(a.obstacle)}</td><td>${e(a.support)}</td><td>${a.discuss ? 'Yes' : 'No'}</td><td>${a.marketingConsent ? 'Yes' : 'No'}</td><td>${e(a.source)}</td></tr>`).join('');
  return frame('Applications', `<span class="eyebrow">Owner HQ · Applications</span><h1>One Lane Mentoring applications.</h1><p class="intro">Newest first, up to 200. These details are for assessing the application and contacting the applicant about it. Status changes are recorded manually for now.</p><div class="scroll"><table><thead><tr><th>Received (UK)</th><th>Status</th><th>Applicant</th><th>Town or area</th><th>Door</th><th>Experience</th><th>Hours a week</th><th>90-day objective</th><th>Obstacle</th><th>Support</th><th>Discuss</th><th>Tips emails</th><th>Source</th></tr></thead><tbody>${rows || '<tr><td colspan="13">No applications yet.</td></tr>'}</tbody></table></div>`);
}

export function hqCoursePage(input: { csrf: string; course: MhpGrowthSummary['course']; loaded?: { modules: number; lessons: number } }): string {
  return frame('Course', `<span class="eyebrow">Owner HQ · Course</span><h1>Load the course.</h1><p class="intro">The lessons live in the database, not in the code, so paid content never sits in a public place. Upload the course bundle file to replace the lessons. Member progress is kept.</p>${input.loaded ? `<div class="notice"><strong>Loaded.</strong> ${e(input.loaded.modules)} modules and ${e(input.loaded.lessons)} lessons are live in the training centre.</div>` : ''}<p>Live now: <strong>${e(input.course.modules)}</strong> modules, <strong>${e(input.course.lessons)}</strong> lessons${input.course.loadedAt ? `, loaded ${e(new Date(input.course.loadedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }))} UK time` : ''}.</p><form class="panel" method="post" action="/hq/course" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${e(input.csrf)}"><label for="bundle"><strong>Course bundle (.json)</strong></label><input id="bundle" type="file" name="bundle" accept="application/json,.json" required><button>Replace the course</button><p class="small">This replaces every module and lesson in one step. If the file is wrong, nothing changes.</p></form>`);
}

function publicFrame(title: string, body: string): string {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)} · Martin Howard Property</title><style>${STYLE}main{max-width:620px}</style></head><body><header><strong>Martin Howard Property</strong></header><main>${body}</main></body></html>`;
}
export function publicMessagePage(title: string, message: string, back = 'https://martinhowardproperty.co.uk/'): string {
  return publicFrame(title, `<h1>${e(title)}</h1><p class="intro">${e(message)}</p><p><a href="${e(back)}">&larr; Back to Martin Howard Property</a></p>`);
}
export function unsubscribeConfirmPage(prospectId: string, token: string): string {
  return publicFrame('Unsubscribe', `<h1>Stop the emails?</h1><p class="intro">Press the button and you won't get any more emails from Martin Howard Property, including webinar reminders.</p><form method="post" action="/email/unsubscribe?p=${encodeURIComponent(prospectId)}&amp;t=${encodeURIComponent(token)}"><button>Unsubscribe me</button></form>`);
}
