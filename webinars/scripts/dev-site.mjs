#!/usr/bin/env node
// A throwaway "brand website" on http://localhost:8788 that embeds the local dev Worker.
// Usage: node scripts/dev-site.mjs <publishable key> [apiOrigin=http://localhost:8787]
// Pages: /  (register + countdown)  /evergreen  /on-demand  /list  /dark
import { createServer } from 'node:http';

const [pk, api = 'http://localhost:8787'] = process.argv.slice(2);
if (!pk) {
  console.error('usage: node scripts/dev-site.mjs <pk_live_…> [apiOrigin]');
  process.exit(1);
}

const page = (title, body, dark = false) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Demo Property Co</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Inter:wght@400;600;700&display=swap">
<style>
  body { margin: 0; font-family: Inter, system-ui, sans-serif; background: ${dark ? '#0b0d12' : '#f7f6f3'}; color: ${dark ? '#eee' : '#13151a'}; }
  nav { display: flex; align-items: center; justify-content: space-between; padding: 16px 28px; background: #0b2545; color: #fff; }
  nav b { font-family: Fraunces, serif; font-size: 20px; letter-spacing: -.01em; }
  nav a { color: rgba(255,255,255,.75); text-decoration: none; margin-left: 18px; font-size: 14px; }
  main { max-width: 1120px; margin: 0 auto; padding: 28px 20px 80px; }
  .gap { height: 24px; }
  /* Deliberately hostile host CSS: none of this may reach the widget. */
  button { background: hotpink !important; font-size: 30px; } input { border: 5px dashed red; } h1 { color: lime; }
</style>
<script src="${api}/v1/embed.js" data-key="${pk}" data-api="${api}" defer></script>
</head><body>
<nav><b>Demo Property Co</b><span><a href="/">Live</a><a href="/evergreen">Evergreen</a><a href="/on-demand">On demand</a><a href="/list">All</a><a href="/dark">Dark</a></span></nav>
<main>${body}</main>
<script>window.__events=[];['ghq:registered','ghq:joined','ghq:cta-click'].forEach(t=>document.addEventListener(t,e=>{window.__events.push(t);console.log(t,e.detail)}));</script>
</body></html>`;

const routes = {
  '/': page('Live webinar', `<ghq-webinar view="countdown" webinar="q4-investor-briefing"></ghq-webinar><div class="gap"></div><ghq-webinar id="w" webinar="q4-investor-briefing" view="register"></ghq-webinar>`),
  '/evergreen': page('Evergreen', `<ghq-webinar id="w" webinar="passive-income-masterclass" view="register"></ghq-webinar>`),
  '/on-demand': page('On demand', `<ghq-webinar id="w" webinar="deal-analysis-101" view="register"></ghq-webinar>`),
  '/list': page('Webinars', `<h2 style="font-family:Fraunces,serif">Upcoming</h2><ghq-webinar view="list"></ghq-webinar><div class="gap"></div><h2 style="font-family:Fraunces,serif">On demand</h2><ghq-webinar view="list" filter="on_demand" layout="list"></ghq-webinar>`),
  '/dark': page('Dark', `<ghq-webinar id="w" webinar="q4-investor-briefing" view="register" theme="dark"></ghq-webinar>`, true),
};

createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/\.html$/, '').replace(/^\/index$/, '/');
  const body = routes[path];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body ?? 'not found');
}).listen(8788, '127.0.0.1', () => console.log('demo site on http://localhost:8788  (embedding', api + ')'));
