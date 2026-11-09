/**
 * Local, test-only native-webinar preview on a DISPOSABLE PostgreSQL.
 *
 * It resets nothing, but it writes synthetic brands, webinars and registrations,
 * so it refuses to run unless the disposable-database guards are set (the same
 * ones the integration tests use). It holds the disposable-database lease while
 * it runs: stop it before running the integration tests, and run one at a time. Cloudflare Stream and Postmark
 * are recording fakes: no provider is called, no email leaves the process and no
 * video is stored. Playback URLs point at a synthetic Stream customer host, which
 * the screenshot run intercepts with a local, labelled mock video.
 *
 *   TEST_DATABASE_URL=… TEST_DATABASE_RESET_CONFIRM=reset-disposable-branch \
 *   RELAUNCH72_DATABASE_INTEGRATION=explicit-disposable-run \
 *   node --import ./test/windows-node24-shim.mjs --import tsx test/manual-webinars-preview.ts [--port 4310] [--no-stream]
 *
 * Sign in as a seeded owner with /preview/sign-in?as=alpha | bravo | alpha-viewer.
 */
import { createHash } from 'node:crypto';
import { openTestDatabase, testDatabaseSkipReason } from './db/database-helper.js';
import { PROFILES, loginRole, seedBrand, startWebinarHttpHarness, syntheticConfig } from './db/webinar-harness.js';
import { loadWebinarConfig } from '../src/webinars/config.js';
import { utcToLocalInput } from '../src/webinars/schedule.js';
import type { WebinarEditInput } from '../src/webinars/service.js';
import { DEFAULT_SETTINGS, readSettings } from '../src/webinars/types.js';

const skip = testDatabaseSkipReason();
if (skip) {
  console.error(`Refusing to run: ${skip}`);
  process.exit(2);
}
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || 4310) || 4310;
const withStream = !args.includes('--no-stream');
// --studio-ingest rtmp://127.0.0.1:<port>/live/ turns on the browser studio, relaying to a local RTMP receiver (stand-in for Cloudflare).
const studioIngest = args.includes('--studio-ingest') ? args[args.indexOf('--studio-ingest') + 1] ?? null : null;

let offsetMs = 0;
const now = () => Date.now() + offsetMs;
const localIn = (minutesFromNow: number) => utcToLocalInput(new Date(Date.now() + minutesFromNow * 60_000).toISOString(), 'Europe/London');

const admin = await openTestDatabase();
const content = await loginRole(admin, 'r72_content_command');
const crmPool = await loginRole(admin, 'r72_crm_command');
const alpha = await seedBrand(admin, 'Relaunch72 Demo', '#ed9c24');
const bravo = await seedBrand(admin, 'PropertyPredator Demo', '#00e5cc');
const h = await startWebinarHttpHarness({
  contentPool: content, crmPool, port, now,
  ...(studioIngest ? { studio: { ffmpegPath: process.env.WEBINAR_STUDIO_FFMPEG ?? 'ffmpeg', ingestUrl: studioIngest } } : {}),
  users: {
    alpha: { identity: alpha.owner, profile: PROFILES.relaunch72 },
    'alpha-viewer': { identity: alpha.viewer, profile: PROFILES.relaunch72 },
    bravo: { identity: bravo.owner, profile: PROFILES.propertyPredator },
  },
  configFor: (origin) => (withStream ? syntheticConfig(alpha.ws, bravo.ws, origin) : loadWebinarConfig({ WEBINAR_ACCESS_SECRET: 's'.repeat(40), WEBINAR_PUBLIC_ORIGIN: origin })),
});
const svc = h.service;
const rid = () => crypto.randomUUID();

const edit = (over: Partial<WebinarEditInput>): WebinarEditInput => ({
  kind: 'live', title: '', summary: '', presenterName: 'Martin Howard', presenterTitle: 'Founder', timezone: 'Europe/London', startsLocal: localIn(60 * 24),
  durationMinutes: 60, capacity: null,
  settings: readSettings({
    ...DEFAULT_SETTINGS, reminderOffsetsMinutes: [1440, 60], questionsEnabled: true, questionsModerated: true, replay: { enabled: true, availableDays: 14 },
    marketingConsentText: 'Send me occasional property investing insights. Unsubscribe any time.', privacyUrl: 'https://example.test/privacy',
    questions: [{ label: 'What is your investing experience?', required: true, type: 'select', options: ['New to property', '1–3 properties', '4+ properties'] }],
    cta: { label: 'Book a strategy call', url: 'https://example.test/book', body: 'Twenty minutes with the team to plan your next deal.', mode: 'manual' },
  }),
  ...over,
});
const people = [
  ['Aisha Khan', 'newsletter'], ['Ben Carter', 'linkedin'], ['Chloe Davies', 'newsletter'], ['Dan Evans', 'podcast'],
  ['Ella Foster', 'linkedin'], ['Finn Green', ''], ['Grace Hall', 'newsletter'],
] as const;
async function register(key: string, n: number = people.length) {
  const out = [];
  for (const [name, source] of people.slice(0, n)) {
    const email = `${name.split(' ')[0]!.toLowerCase()}@example.test`;
    out.push(await svc.register(key, { email, name, answers: {}, marketing: name.length % 2 === 0, consent: { version: 'webinar-1' }, attribution: source ? { utm_source: source } : {} }));
  }
  return out;
}
const keyOf = async (id: string, who = alpha.owner) => (await svc.get(who, rid(), id)).event.publicKey;

// ── Alpha (Relaunch72 shell) ──
const live = await svc.create(alpha.owner, rid(), edit({ title: 'Property investor briefing: November', summary: 'How we find, fund and refurbish below-market deals in 2026, with live Q&A.', startsLocal: localIn(-10) }));
await svc.setStatus(alpha.owner, rid(), live, 'publish');
const liveKey = await keyOf(live);
const regs = await register(liveKey);
if (withStream) {
  await svc.provisionLiveInput(alpha.owner, rid(), live);
  const liveUid = [...h.cf.liveInputs.keys()][0]!;
  h.cf.liveInputs.get(liveUid)!.status = 'connected';
  await svc.refreshLive(alpha.owner, rid(), live);
  await svc.startSession(alpha.owner, rid(), live);
  await svc.setCta(alpha.owner, rid(), live, true);
  for (const [i, r] of regs.slice(0, 5).entries()) {
    const claim = { registrationId: r.registrationId!, version: 1 };
    await svc.signal(liveKey, claim, 'room_accessed', 'waiting', null, null);
    if (i < 4) await svc.signal(liveKey, claim, 'player_started', 'live', null, null);
  }
  const claims = regs.map((r) => ({ registrationId: r.registrationId!, version: 1 }));
  await svc.ask(liveKey, claims[0]!, 'Do you still use bridging finance with rates where they are?');
  await svc.ask(liveKey, claims[1]!, 'What yield do you need on an HMO in the North West?');
  await svc.ask(liveKey, claims[2]!, 'Will the replay be available?');
  const qs = await svc.questions(alpha.owner, rid(), live);
  await svc.moderate(alpha.owner, rid(), live, qs.find((q) => q.body.startsWith('Will'))!.id, 'answer', 'Yes, for 14 days after the session.');
  await svc.moderate(alpha.owner, rid(), live, qs.find((q) => q.body.startsWith('Do you'))!.id, 'approve', '');
}
const upcoming = await svc.create(alpha.owner, rid(), edit({ title: 'Autumn market update', summary: 'Prices, rents and lending: what changed this quarter.', startsLocal: localIn(60 * 24 * 3) }));
await svc.setStatus(alpha.owner, rid(), upcoming, 'publish');
await register(await keyOf(upcoming), 3);
const onDemand = await svc.create(alpha.owner, rid(), edit({ kind: 'on_demand', title: 'Deal analysis masterclass', summary: 'Watch any time: the numbers behind three real deals.', startsLocal: '' }));
if (withStream) {
  await svc.beginUpload(alpha.owner, rid(), onDemand, 512 * 1024 * 1024, 'masterclass.mp4');
  const uid = (await svc.get(alpha.owner, rid(), onDemand)).event.videoUid!;
  h.cf.videos.set(uid, { uid, readyToStream: true, status: { state: 'ready' }, duration: 2712 });
  await svc.uploadFinished(alpha.owner, rid(), onDemand);
  await svc.setStatus(alpha.owner, rid(), onDemand, 'publish');
}
await svc.create(alpha.owner, rid(), edit({ kind: 'scheduled_recording', title: 'Portfolio Q&A (recorded)', summary: 'A recorded session shown at a set time.', startsLocal: localIn(60 * 24 * 8) }));

// ── Bravo (PropertyPredator shell): a finished live session with a replay ──
const finished = await svc.create(bravo.owner, rid(), edit({ title: 'Predator Briefing: spotting distressed stock', summary: 'The signals our software uses to surface motivated sellers.', presenterName: 'PropertyPredator team', presenterTitle: '', startsLocal: localIn(-60 * 26) }));
await svc.setStatus(bravo.owner, rid(), finished, 'publish');
const finishedKey = await keyOf(finished, bravo.owner);
await register(finishedKey, 4);
if (withStream) {
  offsetMs = -26 * 3600_000;
  await svc.provisionLiveInput(bravo.owner, rid(), finished);
  const liveUid = [...h.cf.liveInputs.keys()].at(-1)!;
  h.cf.liveInputs.get(liveUid)!.status = 'connected';
  await svc.refreshLive(bravo.owner, rid(), finished);
  await svc.startSession(bravo.owner, rid(), finished);
  offsetMs = -25 * 3600_000;
  await svc.endSession(bravo.owner, rid(), finished);
  offsetMs = 0;
  const rec = crypto.randomUUID().replace(/-/g, '');
  await svc.streamNotification(createHash('sha256').update(`preview-recording-${rec}`).digest(), { uid: rec, liveInput: liveUid, state: 'ready', readyToStream: true, duration: 3540, errorReason: null });
}
await svc.create(bravo.owner, rid(), edit({ title: 'Predator Briefing: December', startsLocal: localIn(60 * 24 * 20) }));

const tokenLink = (key: string, registrationId: string) => svc.roomUrl({ workspaceId: alpha.ws, publicKey: key } as never, { registrationId, version: 1 });
console.log(JSON.stringify({
  origin: h.origin,
  withStream,
  alphaLive: { id: live, key: liveKey, roomLink: tokenLink(liveKey, regs[0]!.registrationId!) },
  alphaOnDemand: { id: onDemand },
  alphaUpcoming: { id: upcoming },
  bravoReplay: { id: finished, key: finishedKey, roomLink: svc.roomUrl({ workspaceId: bravo.ws, publicKey: finishedKey } as never, { registrationId: (await admin.query('SELECT id FROM app.webinar_registrations WHERE event_id = $1 ORDER BY created_at LIMIT 1', [finished])).rows[0].id, version: 1 }) },
}));
console.error(`Webinar preview on ${h.origin} — synthetic data, fake Cloudflare, no email leaves the process. Ctrl+C to stop.`);
process.on('SIGINT', () => { void h.close().then(() => Promise.all([content.end(), crmPool.end(), admin.end()])).then(() => process.exit(0)); });
