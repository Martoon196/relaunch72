#!/usr/bin/env node
// Seeds a local `wrangler dev` instance: account keys, a demo brand, keys, and one webinar of each type.
// Usage: node scripts/dev-seed.mjs [apiBase=http://localhost:8787] [siteOrigin=http://localhost:8788]
const api = process.argv[2] ?? 'http://localhost:8787';
const site = process.argv[3] ?? 'http://localhost:8788';
const boot = process.env.BOOTSTRAP_TOKEN ?? 'dev-bootstrap';

async function call(method, path, sk, body) {
  const res = await fetch(`${api}/v1/admin${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(sk ? { authorization: `Bearer ${sk}` } : { 'x-bootstrap-token': boot }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json.data;
}

const keys = await call('POST', '/bootstrap');
const sk = keys.sk_live;
const brand = await call('POST', '/brands', sk, {
  name: 'Demo Property Co', slug: 'demo-property',
  theme: { colors: { primary: '#0b2545', accent: '#C8A04B', background: '#ffffff', surface: '#f6f4ef', text: '#13151a', muted: '#5b6170' }, radius: '12px', button_style: 'pill' },
  settings: {
    domains: { allowed_origins: [site] },
    compliance: { risk_warning: 'Property investment carries risk. Capital at risk. Past performance is not a guide to future returns.', recording_notice: 'This session is recorded.' },
    ctas: { default: { label: 'Book a call', url: 'https://example.com/book' } },
    defaults: { qa_moderation: true },
  },
});
const pk = await call('POST', '/api-keys', sk, { type: 'pk', brand_id: brand.id, name: 'local site' });
const bsk = await call('POST', '/api-keys', sk, { type: 'sk', brand_id: brand.id, name: 'local admin' });

const live = await call('POST', '/webinars', bsk.key, {
  type: 'live', title: 'Q4 Investor Briefing', duration_s: 3600,
  description: 'Where UK yields are heading in 2027, and how to position a portfolio for it.',
  presenters: [{ name: 'Sam Carter', title: 'Head of Research', bio: '15 years in UK residential.' }],
  agenda: [{ time: '0:00', title: 'Market update' }, { time: '0:20', title: 'Three regions to watch' }, { time: '0:45', title: 'Live Q&A' }],
});
await call('POST', `/webinars/${live.id}/live-input`, bsk.key);
const session = await call('POST', '/sessions', bsk.key, { webinar_id: live.id, starts_at: new Date(Date.now() + 10 * 60_000).toISOString() });
await call('POST', '/ctas', bsk.key, { webinar_id: live.id, label: 'Book a strategy call', url: 'https://example.com/book', style: 'card', body: 'Free 20-minute call with our team.', push_mode: 'manual' });
await call('POST', '/polls', bsk.key, { webinar_id: live.id, question: 'What’s your investment budget?', options: ['Under £50k', '£50k–£150k', '£150k+'], crm_field: 'investment_budget_band' });
await call('PATCH', `/webinars/${live.id}`, bsk.key, { status: 'published' });

const ev = await call('POST', '/webinars', bsk.key, { type: 'evergreen', title: 'Passive Income Masterclass', duration_s: 1800, video_uid: 'dev_video', description: 'A scheduled replay of our most popular session.' });
await call('POST', '/slot-rules', bsk.key, { webinar_id: ev.id, kind: 'just_in_time', rule: { every_minutes: 15 } });
await call('POST', '/slot-rules', bsk.key, { webinar_id: ev.id, kind: 'fixed', rule: { days: [2, 4], times: ['19:00'] }, timezone: 'Europe/London' });
await call('POST', '/ctas', bsk.key, { webinar_id: ev.id, label: 'Get the deal pack', url: 'https://example.com/pack', show_at_s: 5 });
await call('PATCH', `/webinars/${ev.id}`, bsk.key, { status: 'published' });

const od = await call('POST', '/webinars', bsk.key, { type: 'on_demand', title: 'Deal Analysis 101', duration_s: 1200, video_uid: 'dev_video', description: 'Watch any time.' });
await call('PATCH', `/webinars/${od.id}`, bsk.key, { status: 'published' });

const host = await call('POST', `/sessions/${session.id}/host-token`, bsk.key, { role: 'host', name: 'Sam' });
console.log(JSON.stringify({ account_sk: sk, brand_id: brand.id, pk: pk.key, brand_sk: bsk.key, live_webinar: live.id, live_session: session.id, host_console: host.console_url, embed: live.embed.snippet }, null, 2));
