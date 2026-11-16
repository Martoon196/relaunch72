import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AFFILIATE_MESSAGES, NOT_OPENED_YET, PgAffiliateProductStore, answerFor, type AffiliateOwner } from '../src/affiliate/product-store.js';
import { PgAffiliateReportStore, REPORT_STORE_MESSAGES, monthRange } from '../src/affiliate/report-store.js';
import { InactivePortalSessionError } from '../src/db/transaction.js';
import { LINK_MESSAGES } from '../src/affiliate/programmes.js';
import { REPORT_MESSAGES } from '../src/affiliate/amazon-tracking-report.js';

const WS = '0b158000-0000-4000-8000-000000000001', SELECTED = '0b158000-0000-4000-8000-000000000002', USER = '0b158000-0000-4000-8000-000000000003';
const owner: AffiliateOwner = { userId: USER, requestId: 'req-affiliate-1', sessionToken: 'session-token-affiliate', selectedWorkspaceId: SELECTED };
const HASH = createHash('sha256').update(owner.sessionToken).digest();
const PAGE = 'https://www.amazon.co.uk/dp/B08N5WRWNW';
const POUND = String.fromCharCode(0xa3);

type Call = { sql: string; values: unknown[] };
/** A pool whose function answers come from `answer` (a value, or an error to throw), recording every statement. */
function fakePool(answer: (fn: string, action: string, input: Record<string, unknown>) => unknown, guard = true) {
  const calls: Call[] = [];
  let released = 0;
  const pool = {
    async connect() {
      return {
        async query(sql: string, values: unknown[] = []) {
          calls.push({ sql, values });
          if (/lock_active_portal_session/u.test(sql)) return { rows: [{ ok: guard }] };
          const match = /app_private\.(affiliate_[a-z_]+)\(/u.exec(sql);
          if (match) {
            const value = answer(match[1]!, values[2] as string, JSON.parse(values[3] as string));
            if (value instanceof Error) throw value;
            return { rows: [{ value }] };
          }
          return { rows: [] };
        },
        release() { released++; },
      };
    },
  };
  return { pool: pool as never, calls, released: () => released };
}
const pgError = (code: string, detail?: string) => Object.assign(new Error(`pg ${code}`), { code, detail });
const SETTINGS = { programme: 'amazon_uk', revision: 1, trackingId: 'mysite-21', registeredSite: 'https://www.example.co.uk', siteListedConfirmed: true, accountConfirmed: true, createdAt: 'x' };

test('every call runs in the owner transaction: request context, the session locked again, the session hash passed', async () => {
  const fake = fakePool(() => []);
  const store = new PgAffiliateProductStore(fake.pool, owner);
  assert.deepEqual(await store.list(WS), { ok: true, value: [] });
  const sqls = fake.calls.map(c => c.sql.replace(/\s+/gu, ' ').trim());
  assert.match(sqls[0]!, /^BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE$/u);
  assert.match(sqls[1]!, /set_config\('app\.user_id'/u);
  assert.deepEqual(fake.calls[1]!.values, [USER, WS, 'user', 'req-affiliate-1']);
  assert.match(sqls[2]!, /lock_active_portal_session/u);
  assert.deepEqual(fake.calls[2]!.values, [HASH, USER, SELECTED], 'the session is checked against the workspace it selected');
  assert.equal(sqls[3], 'SELECT app_private.affiliate_product_command($1,$2,$3,$4::jsonb) AS value');
  assert.deepEqual(fake.calls[3]!.values, [WS, HASH, 'list', '{}']);
  assert.equal(sqls[4], 'COMMIT');
  assert.equal(fake.released(), 1);
  assert.ok(!JSON.stringify(fake.calls).includes(owner.sessionToken), 'the token itself is never sent');
});

test('a database without 0158 answers NOT_OPENED_YET for every call; nothing throws', async () => {
  for (const code of ['42883', '42P01', '3F000']) {
    const fake = fakePool(() => pgError(code));
    const products = new PgAffiliateProductStore(fake.pool, owner), reports = new PgAffiliateReportStore(fake.pool, owner);
    assert.equal(await products.list(WS), NOT_OPENED_YET, code);
    assert.equal(await products.get(WS, WS), NOT_OPENED_YET);
    assert.equal(await products.settings(WS, 'amazon_uk'), NOT_OPENED_YET);
    assert.equal(await products.saveSettings({ workspaceId: WS, programme: 'amazon_uk', expectedRevision: 0, trackingId: 'mysite-21', registeredSite: 'example.co.uk',
      siteListedConfirmed: true, accountConfirmed: true }), NOT_OPENED_YET);
    assert.equal(await products.add({ workspaceId: WS, details: { programme: 'amazon_uk', link: PAGE, productName: 'Kettle', ownerUsed: false } }), NOT_OPENED_YET);
    assert.equal(await products.retire({ workspaceId: WS, productId: WS, expectedRevision: 1 }), NOT_OPENED_YET);
    assert.equal(await reports.list(WS), NOT_OPENED_YET);
    assert.equal(await reports.get(WS, WS), NOT_OPENED_YET);
    assert.equal(await reports.save({ workspaceId: WS, month: '2026-10', originalText: `Tracking ID,Earnings\nmysite-21,${POUND}1.00\n` }), NOT_OPENED_YET);
  }
  assert.deepEqual(NOT_OPENED_YET, { ok: false, kind: 'not_opened_yet' });
});

test('database refusals become typed answers with plain sentences; anything else is thrown as it is', async () => {
  const cases: [Error, string][] = [
    [pgError('42501'), 'forbidden'], [new InactivePortalSessionError(), 'forbidden'], [pgError('40001', 'affiliate_stale'), 'stale'],
    [pgError('23505', 'affiliate_command_reused'), 'command_reused'], [pgError('23505', 'affiliate_report_conflict'), 'report_conflict'],
    [pgError('55000', 'affiliate_settings_required'), 'settings_required'], [pgError('54000', 'affiliate_product_cap'), 'product_cap'],
    [pgError('54000', 'affiliate_report_cap'), 'report_cap'], [pgError('22023', 'affiliate_tag_mismatch'), 'tag_mismatch'],
    [pgError('22023', 'affiliate_not_found'), 'not_found'], [pgError('22023'), 'invalid'], [pgError('23514'), 'invalid'], [pgError('22P02'), 'invalid'],
  ];
  for (const [error, reason] of cases) {
    const answer = answerFor(error);
    assert.deepEqual(answer, { ok: false, kind: 'refused', reason, message: AFFILIATE_MESSAGES[reason as keyof typeof AFFILIATE_MESSAGES] }, reason);
  }
  for (const error of [pgError('57P01'), pgError('08006'), new Error('ECONNREFUSED'), pgError('XX000')]) assert.equal(answerFor(error), null);
  const down = fakePool(() => pgError('08006'));
  await assert.rejects(new PgAffiliateProductStore(down.pool, owner).list(WS), /pg 08006/u);
  // A session that is no longer active is refused before the function runs.
  const inactive = fakePool(() => { throw new Error('the function must not run'); }, false);
  assert.deepEqual(await new PgAffiliateProductStore(inactive.pool, owner).list(WS), answerFor(new InactivePortalSessionError()));
  assert.ok(!inactive.calls.some(c => /affiliate_product_command/u.test(c.sql)));
  for (const message of Object.values(AFFILIATE_MESSAGES)) assert.doesNotMatch(message, /\b(?:sql|error|invalid|uuid|revision|session token|42501|database)\b/iu);
});

test('a bad owner or business id is refused without touching the database', async () => {
  const fake = fakePool(() => { throw new Error('must not run'); });
  for (const bad of [{ ...owner, userId: 'x' }, { ...owner, selectedWorkspaceId: '' }, { ...owner, sessionToken: '' }]) {
    assert.equal((await new PgAffiliateProductStore(fake.pool, bad).list(WS) as { reason?: string }).reason, 'forbidden');
  }
  const store = new PgAffiliateProductStore(fake.pool, owner);
  assert.equal((await store.list('not-a-uuid') as { reason?: string }).reason, 'forbidden');
  assert.equal((await store.get(WS, 'nope') as { reason?: string }).reason, 'invalid');
  assert.equal((await store.retire({ workspaceId: WS, productId: WS, expectedRevision: 0 }) as { reason?: string }).reason, 'invalid');
  assert.equal(fake.calls.length, 0);
});

test('add: the link is rebuilt with the saved tracking ID before it is sent; junk never reaches the database', async () => {
  const sent: Record<string, unknown>[] = [];
  const fake = fakePool((fn, action, input) => {
    if (fn === 'affiliate_programme_command') return SETTINGS;
    sent.push({ action, ...input });
    return { replayed: false, productId: input.productId, revision: 1, status: 'active' };
  });
  const store = new PgAffiliateProductStore(fake.pool, owner);
  const productId = '0b158000-0000-4000-8000-0000000000aa', commandId = '0b158000-0000-4000-8000-0000000000bb';
  const result = await store.add({ workspaceId: WS, productId, commandId, details: { programme: 'amazon_uk',
    link: 'https://www.amazon.co.uk/Kettle-Steel/dp/B08N5WRWNW/ref=sr_1_1?keywords=kettle&th=1', productName: '  Steel   kettle ', notes: 'Boils fast.\r\nQuiet.\t',
    ownerUsed: true, infoUrl: 'https://maker.example/kettle' } });
  assert.deepEqual(result, { ok: true, value: { replayed: false, productId, revision: 1, status: 'active' } });
  assert.deepEqual(sent, [{ action: 'add', commandId, productId, product: { programme: 'amazon_uk', merchantName: 'Amazon UK', productName: 'Steel kettle',
    merchantProductId: 'B08N5WRWNW', productUrl: PAGE, affiliateUrl: `${PAGE}?tag=mysite-21`, infoUrl: 'https://maker.example/kettle', notes: 'Boils fast.\nQuiet.', ownerUsed: true } }]);
  // Refusals in plain English, nothing sent.
  sent.length = 0;
  const refusedWith = async (details: Record<string, unknown>, message: string) => {
    const answer = await store.add({ workspaceId: WS, details: { programme: 'amazon_uk', link: PAGE, productName: 'Kettle', ownerUsed: false, ...details } as never });
    assert.deepEqual(answer, { ok: false, kind: 'refused', reason: answer.ok ? '' : (answer as { reason: string }).reason, message }, JSON.stringify(details));
  };
  await refusedWith({ link: 'https://amzn.to/abc' }, LINK_MESSAGES.shortLink);
  await refusedWith({ link: `${PAGE}?tag=someoneelse-21` }, LINK_MESSAGES.trackingIdMismatch);
  await refusedWith({ productName: '<b>x</b>' }, 'Give the product a name of up to 200 characters.');
  await refusedWith({ productName: 'x'.repeat(201) }, 'Give the product a name of up to 200 characters.');
  await refusedWith({ notes: 'a\u0000b' }, 'What you know about the product can be up to 2,000 characters.');
  await refusedWith({ notes: 'n'.repeat(2001) }, 'What you know about the product can be up to 2,000 characters.');
  for (const infoUrl of ['http://maker.example', 'https://u:p@maker.example', 'javascript:alert(1)', 'https://maker.example:8080/', 'https://maker.example/"x']) {
    await refusedWith({ infoUrl }, 'The maker\'s page must be a full secure web address, or leave it empty.');
  }
  await refusedWith({ ownerUsed: 'yes' }, AFFILIATE_MESSAGES.invalid);
  await refusedWith({ programme: 'amazon_com' }, AFFILIATE_MESSAGES.invalid);
  assert.equal(sent.length, 0);
});

test('add before the programme details are saved is refused with the settings sentence', async () => {
  const fake = fakePool(fn => fn === 'affiliate_programme_command' ? null : { replayed: false });
  const answer = await new PgAffiliateProductStore(fake.pool, owner).add({ workspaceId: WS, details: { programme: 'amazon_uk', link: `${PAGE}?tag=mysite-21`, productName: 'K', ownerUsed: false } });
  assert.deepEqual(answer, { ok: false, kind: 'refused', reason: 'settings_required', message: AFFILIATE_MESSAGES.settings_required });
  assert.ok(!fake.calls.some(c => /affiliate_product_command/u.test(c.sql)));
});

test('saveSettings: cleaned tracking ID and site, both confirmations required', async () => {
  const sent: Record<string, unknown>[] = [];
  const fake = fakePool((_fn, action, input) => { sent.push({ action, ...input }); return { replayed: false, programme: 'amazon_uk', revision: 1 }; });
  const store = new PgAffiliateProductStore(fake.pool, owner);
  const commandId = '0b158000-0000-4000-8000-0000000000cc';
  assert.deepEqual(await store.saveSettings({ workspaceId: WS, programme: 'amazon_uk', expectedRevision: 0, trackingId: ' mysite-21 ', registeredSite: 'https://www.Example.co.uk/blog',
    siteListedConfirmed: true, accountConfirmed: true, commandId }), { ok: true, value: { replayed: false, revision: 1 } });
  assert.deepEqual(sent, [{ action: 'save', commandId, programme: 'amazon_uk', expectedRevision: 0,
    settings: { trackingId: 'mysite-21', registeredSite: 'https://www.example.co.uk', siteListedConfirmed: true, accountConfirmed: true } }]);
  for (const bad of [{ siteListedConfirmed: false }, { accountConfirmed: false }, { trackingId: 'mysite-20' }, { registeredSite: 'http://x.example' }, { expectedRevision: -1 },
    { programme: 'other' }, { commandId: 'x' }]) {
    const answer = await store.saveSettings({ workspaceId: WS, programme: 'amazon_uk', expectedRevision: 0, trackingId: 'mysite-21', registeredSite: 'example.co.uk',
      siteListedConfirmed: true, accountConfirmed: true, ...bad } as never);
    assert.equal((answer as { reason?: string }).reason, 'invalid', JSON.stringify(bad));
  }
  assert.equal(sent.length, 1);
});

test('reports: a month becomes its first and last day; the file is read locally before anything is sent', async () => {
  assert.deepEqual(monthRange('2026-10'), { start: '2026-10-01', end: '2026-10-31' });
  assert.deepEqual(monthRange('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
  assert.deepEqual(monthRange('2026-02'), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(monthRange('2026-12'), { start: '2026-12-01', end: '2026-12-31' });
  for (const bad of ['2026-13', '2026-00', '2026-1', '1999-12', '2026-10-01', '', null, 202610]) assert.equal(monthRange(bad), null, String(bad));
  const sent: Record<string, unknown>[] = [];
  const fake = fakePool((_fn, action, input) => { sent.push({ action, ...input }); return { replayed: false, id: input.id }; });
  const store = new PgAffiliateReportStore(fake.pool, owner);
  const text = `Tracking ID,Clicks,Earnings\nmysite-21,412,${POUND}23.40\nOthers,3,${POUND}0.10\n`;
  const id = '0b158000-0000-4000-8000-0000000000dd';
  assert.deepEqual(await store.save({ workspaceId: WS, month: '2026-10', originalText: text, commandId: id }), { ok: true, value: { replayed: false, id } });
  assert.equal(sent.length, 1);
  const body = sent[0]!;
  assert.equal(body.action, 'save');
  assert.equal(body.sourceSha, createHash('sha256').update(text, 'utf8').digest('hex'));
  assert.deepEqual([body.programme, body.source, body.currency, body.reportStart, body.reportEnd], ['amazon_uk', 'user_uploaded_amazon_tracking_id_summary', 'GBP', '2026-10-01', '2026-10-31']);
  assert.equal((body.payload as { knownEarningsMinor: number }).knownEarningsMinor, 2350);
  assert.equal((body.payload as { unallocatedEarningsMinor: number }).unallocatedEarningsMinor, 10);
  // Refusals, nothing sent.
  sent.length = 0;
  assert.deepEqual(await store.save({ workspaceId: WS, month: '2026-13', originalText: text }), { ok: false, kind: 'refused', reason: 'invalid', message: REPORT_STORE_MESSAGES.month });
  assert.deepEqual(await store.save({ workspaceId: WS, month: '2026-10', originalText: 'Order ID,ASIN,Earnings\n1,2,3.00\n' }),
    { ok: false, kind: 'refused', reason: 'report_unreadable', message: REPORT_MESSAGES.notSummary });
  assert.deepEqual(await store.save({ workspaceId: WS, month: '2026-10', originalText: 7 as never }), { ok: false, kind: 'refused', reason: 'report_unreadable', message: REPORT_MESSAGES.size });
  assert.equal((await store.save({ workspaceId: WS, month: '2026-10', originalText: text, commandId: 'nope' }) as { reason?: string }).reason, 'invalid');
  // Close to the database's limit: refused here in plain English rather than by the database.
  const wide = `Tracking ID,Clicks,Earnings\n${Array.from({ length: 2000 }, (_, i) => `${'t'.repeat(110)}${String(i).padStart(4, '0')}-21,1,${POUND}1.00`).join('\n')}\n`;
  assert.deepEqual(await store.save({ workspaceId: WS, month: '2026-10', originalText: wide }), { ok: false, kind: 'refused', reason: 'report_unreadable', message: REPORT_STORE_MESSAGES.tooBig });
  assert.equal(sent.length, 0);
});
