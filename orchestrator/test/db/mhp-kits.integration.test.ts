/**
 * Module kits (0149) on a disposable PostgreSQL with the actual roles: the webhook records a paid kit through
 * r72_webhook, the member reads kits and files through r72_web, the owner uploads through r72_identity_command.
 * Stripe is a stand-in object; nothing real is called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type Stripe from 'stripe';
import { openTestDatabase, testDatabaseSkipReason } from './database-helper.js';
import { loginRole } from './webinar-harness.js';
import { PgMhpKitService, readZip } from '../../src/mhp/kit-service.js';
import { PgMhpLearningService } from '../../src/mhp/learning-service.js';
import type { MhpCommerceConfig } from '../../src/mhp/commerce-config.js';

const skip = testDatabaseSkipReason();
const MHP_WORKSPACE = '14900000-0000-4000-8000-0000000000a2';
const tokenFor = (label: string): string => createHash('sha256').update(label).digest('base64url');

/** A stored (uncompressed) zip, enough for the owner upload. */
function zip(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data); centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

test('a paid kit opens its module and downloads for its buyer only, once, until a full refund', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const web = await loginRole(admin, 'r72_web');
  const identity = await loginRole(admin, 'r72_identity_command');
  const webhook = await loginRole(admin, 'r72_webhook');
  try {
    // The programme owner is one of the two founder identities the migrations already know.
    const founder = (await admin.query(`SELECT id FROM app.users WHERE lower(email::text)='office@propertypredator.com'`)).rows[0]?.id as string | undefined;
    const users = { buyer: '14900000-0000-4000-8000-000000000001', other: '14900000-0000-4000-8000-000000000002', owner: founder ?? '14900000-0000-4000-8000-000000000003' };
    await admin.query(`INSERT INTO app.users(id,email,status,display_name,email_verified_at) VALUES
      ($1,'kit-buyer@example.invalid','active','Kit Buyer',now()),($2,'kit-other@example.invalid','active','Other',now())`, [users.buyer, users.other]);
    if (!founder) await admin.query(`INSERT INTO app.users(id,email,status,display_name,email_verified_at) VALUES($1,'office@propertypredator.com','active','Owner',now())`, [users.owner]);
    await admin.query(`UPDATE app.users SET status='active',email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1`, [users.owner]);
    await admin.query('INSERT INTO app_private.investor_programme_admins(user_id) VALUES($1) ON CONFLICT DO NOTHING', [users.owner]);
    const org = '14900000-0000-4000-8000-0000000000a1';
    await admin.query(`INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,'Kit proof','kit-proof-org','direct_customer')`, [org]);
    await admin.query(`INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,'Kit proof','kit-proof-ws')`, [MHP_WORKSPACE, org]);
    for (const [label, user] of Object.entries(users)) {
      await admin.query(`INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active') ON CONFLICT DO NOTHING`, [org, user]);
      await admin.query(`INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES($1,$2,$3,'owner','active') ON CONFLICT DO NOTHING`, [MHP_WORKSPACE, org, user]);
      await admin.query(`INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience)
        VALUES($1,$2,$3,$4,now()+interval '1 hour','martin_howard_property')`,
        [createHash('sha256').update(tokenFor(label)).digest(), createHash('sha256').update(`${label}-csrf`).digest(), user, MHP_WORKSPACE]);
    }
    await admin.query(`INSERT INTO app_private.mhp_course_modules(number,slug,title) VALUES('25','unregistered-and-ownerless-land','Unregistered and ownerless land'),('05','brrr','BRRR')`);
    await admin.query(`INSERT INTO app_private.mhp_course_lessons(lesson_key,module_number,position,slug,title,body_md) VALUES('25/01','25',1,'start','Start','Body 25'),('05/01','05',1,'start','Start','Body 05')`);

    const config = { accountId: 'acct_kitproof', live: false } as MhpCommerceConfig;
    const sessions = new Map<string, Stripe.Checkout.Session>();
    const stripe = {
      checkout: { sessions: {
        create: async (params: Stripe.Checkout.SessionCreateParams) => {
          const id = `cs_test_kit${sessions.size + 1}`;
          const s = { id, url: `https://checkout.stripe.com/c/pay/${id}`, status: 'open', livemode: false, mode: 'payment', currency: 'gbp',
            amount_total: params.line_items![0]!.price_data!.unit_amount, metadata: params.metadata, payment_status: 'unpaid', payment_intent: null,
            customer_details: null, params } as unknown as Stripe.Checkout.Session;
          sessions.set(id, s); return s;
        },
        retrieve: async (id: string) => sessions.get(id)!,
      } },
      paymentIntents: { retrieve: async (id: string) => ({ id, metadata: [...sessions.values()].find(s => s.payment_intent === id)?.metadata ?? {} }) },
    } as unknown as Stripe;
    let clock = Date.parse('2026-11-11T18:00:00Z');
    const kits = new PgMhpKitService(web, identity, webhook, stripe, config, () => clock);
    const pay = (id: string, email: string) => Object.assign(sessions.get(id)!, { status: 'complete', payment_status: 'paid', payment_intent: `pi_${id.slice(8)}`,
      customer_details: { email, name: 'Kit Buyer' } });
    const completed = (id: string) => ({ type: 'checkout.session.completed', data: { object: { id, metadata: sessions.get(id)!.metadata } } }) as unknown as Stripe.Event;

    // Launch price before the end, standard price after; two kits cost the higher standard price once.
    assert.match(await kits.checkout(['land-gap']), /^https:\/\/checkout\.stripe\.com\//);
    assert.equal(sessions.get('cs_test_kit1')!.amount_total, 2700);
    const params = (sessions.get('cs_test_kit1') as unknown as { params: Stripe.Checkout.SessionCreateParams }).params;
    assert.equal(params.success_url, 'https://martinhowardproperty.co.uk/kits/thanks/?kit=land-gap');
    assert.equal(params.cancel_url, 'https://martinhowardproperty.co.uk/kits/land-gap/');
    assert.equal(params.consent_collection?.terms_of_service, 'required');
    assert.match((params.custom_text?.after_submit as { message?: string } | undefined)?.message ?? '', /MH196 Ltd, company number 15060897/);
    assert.ok(params.expires_at! <= Date.parse('2026-11-15T23:59:00Z') / 1000);
    clock = Date.parse('2026-11-16T00:00:00Z');
    await kits.checkout(['land-gap']);
    assert.equal(sessions.get('cs_test_kit2')!.amount_total, 9700);
    await kits.checkout(['brrr', 'property-from-the-beginning']);
    assert.equal(sessions.get('cs_test_kit3')!.amount_total, 9700);
    await kits.checkout(['property-from-the-beginning', 'one-lane-pick-your-door']);
    assert.equal(sessions.get('cs_test_kit4')!.amount_total, 4700);
    for (const bad of [[], ['nope'], ['brrr', 'brrr'], ['a', 'b', 'c']]) await assert.rejects(kits.checkout(bad), /kit/i);

    // Before any payment the buyer cannot sign in and the module is shut.
    assert.equal((await admin.query("SELECT app_private.mhp_auth_eligible('kit-buyer@example.invalid') AS ok")).rows[0].ok, false);
    const learning = new PgMhpLearningService(web, identity);
    let outline = await learning.outline(tokenFor('buyer'));
    assert.equal(outline.modules.find(m => m.number === '25')!.open, false);

    // A non-kit event is left to the course path; a kit receipt is recorded once.
    assert.equal(await kits.handleEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_course', metadata: { sku: 'mhp_course' } } } } as unknown as Stripe.Event), false);
    clock = Date.parse('2026-11-11T19:00:00Z');
    pay('cs_test_kit1', 'Kit-Buyer@Example.invalid');
    assert.equal(await kits.handleEvent(completed('cs_test_kit1')), true);
    assert.equal(await kits.handleEvent(completed('cs_test_kit1')), true);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM app_private.mhp_kit_orders')).rows[0].n, 1);
    // An amount that is neither price is refused and records nothing.
    pay('cs_test_kit2', 'kit-other@example.invalid');
    Object.assign(sessions.get('cs_test_kit2')!, { amount_total: 100 });
    await assert.rejects(kits.handleEvent(completed('cs_test_kit2')), /does not match/);

    assert.equal((await admin.query("SELECT app_private.mhp_auth_eligible('kit-buyer@example.invalid') AS ok")).rows[0].ok, true);
    outline = await learning.outline(tokenFor('buyer'));
    assert.equal(outline.tier, 'none');
    assert.equal(outline.modules.find(m => m.number === '25')!.open, true);
    assert.equal(outline.modules.find(m => m.number === '05')!.open, false);
    assert.equal((await learning.content(tokenFor('buyer'), '25/01'))?.body, 'Body 25');
    await assert.rejects(learning.content(tokenFor('buyer'), '05/01'), /full course/);
    await learning.saveProgress(tokenFor('buyer'), '25/01', { taskDone: 'yes', complete: 'yes', notes: '' });
    await assert.rejects(learning.saveProgress(tokenFor('buyer'), '05/01', { taskDone: 'yes' }), /full course/);
    assert.equal((await learning.outline(tokenFor('other'))).modules.find(m => m.number === '25')!.open, false);

    // Files: only the owner uploads; a buyer downloads only their own kit's files.
    const upload = zip({ 'land-gap/land-gap-field-guide.pdf': Buffer.from('%PDF-1.4 land'), 'land-gap/land-letter-to-traced-owner.docx': Buffer.from('docx'),
      'brrr/brrr-field-guide.pdf': Buffer.from('%PDF-1.4 brrr'), 'notes.txt': Buffer.from('skip me'), 'unknown-kit/x.pdf': Buffer.from('x') });
    assert.equal(readZip(upload).length, 5);
    await assert.rejects(kits.importZip(tokenFor('buyer'), upload), /Owner access/);
    assert.deepEqual(await kits.importZip(tokenFor('owner'), upload), { kits: 2, files: 3, skipped: ['notes.txt', 'unknown-kit/x.pdf'] });
    const mine = await kits.myKits(tokenFor('buyer'));
    assert.deepEqual(mine.kits.map(k => k.kit), ['land-gap']);
    assert.deepEqual(mine.files.map(f => f.name).sort(), ['land-gap-field-guide.pdf', 'land-letter-to-traced-owner.docx']);
    const file = await kits.file(tokenFor('buyer'), 'land-gap', 'land-gap-field-guide.pdf');
    assert.equal(file?.contentType, 'application/pdf'); assert.equal(file?.bytes.toString(), '%PDF-1.4 land');
    await assert.rejects(kits.file(tokenFor('buyer'), 'brrr', 'brrr-field-guide.pdf'), /not bought/);
    await assert.rejects(kits.file(tokenFor('other'), 'land-gap', 'land-gap-field-guide.pdf'), /not bought/);
    assert.equal((await kits.myKits(tokenFor('owner'))).files.length, 3);

    // After-payment work: the receipt is sent once; replay and CRM run; a failing step is retried without resending.
    const sent: string[] = [], replays: string[] = [], crm: string[] = [];
    let crmFails = true;
    const deps = { mail: { configured: true, sendKitReceipt: async (email: string) => { sent.push(email); } },
      replay: async (key: string, email: string) => { replays.push(`${key}:${email}`); },
      crm: async (input: { key: string; title: string; note: string }) => { if (crmFails) throw new Error('crm down'); crm.push(`${input.title}|${input.note}`); } };
    assert.equal(await kits.runJob(deps), 'retry');
    assert.deepEqual(sent, ['kit-buyer@example.invalid']);
    assert.equal(await kits.runJob(deps), 'idle', 'a retry waits for its backoff');
    await admin.query('UPDATE app_private.mhp_kit_orders SET job_lease_until=now()-interval \'1 second\'');
    crmFails = false;
    assert.equal(await kits.runJob(deps), 'done');
    assert.deepEqual(sent, ['kit-buyer@example.invalid'], 'never emailed twice');
    assert.deepEqual(replays, ['the-land-nobody-seems-to-own-04f856:kit-buyer@example.invalid', 'the-land-nobody-seems-to-own-04f856:kit-buyer@example.invalid']);
    assert.match(crm[0]!, /^Land Gap Kit · Kit Buyer\|Bought Land Gap Kit on 11 November 2026 \(£27\)$/);
    assert.equal(await kits.runJob(deps), 'idle');

    // A partial refund keeps access; a full refund ends it, while the buyer can still sign in.
    const refund = (amount: number, refunded: number) => ({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_kit1', livemode: false, amount, amount_refunded: refunded } } }) as unknown as Stripe.Event;
    assert.equal(await kits.handleEvent(refund(2700, 1000)), true);
    assert.equal((await learning.outline(tokenFor('buyer'))).modules.find(m => m.number === '25')!.open, true);
    assert.equal(await kits.handleEvent(refund(2700, 2700)), true);
    assert.equal((await learning.outline(tokenFor('buyer'))).modules.find(m => m.number === '25')!.open, false);
    assert.deepEqual((await kits.myKits(tokenFor('buyer'))).kits, []);
    await assert.rejects(kits.file(tokenFor('buyer'), 'land-gap', 'land-gap-field-guide.pdf'), /not bought/);
    assert.equal((await admin.query("SELECT app_private.mhp_auth_eligible('kit-buyer@example.invalid') AS ok")).rows[0].ok, true);

    // A pair opens both modules.
    pay('cs_test_kit3', 'kit-other@example.invalid');
    assert.equal(await kits.handleEvent(completed('cs_test_kit3')), true);
    const pair = await kits.myKits(tokenFor('other'));
    assert.deepEqual(pair.kits.map(k => k.kit).sort(), ['brrr', 'property-from-the-beginning']);
    assert.equal((await learning.outline(tokenFor('other'))).modules.find(m => m.number === '05')!.open, true);
  } finally {
    await Promise.allSettled([web.end(), identity.end(), webhook.end()]);
    await admin.end();
  }
});

test('kit spend counts towards the course once: claimed by email within 90 days and refunded against the course payment', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const web = await loginRole(admin, 'r72_web');
  const identity = await loginRole(admin, 'r72_identity_command');
  const webhook = await loginRole(admin, 'r72_webhook');
  try {
    const org = '15000000-0000-4000-8000-0000000000a1', ws = '15000000-0000-4000-8000-0000000000a2', buyer = '15000000-0000-4000-8000-000000000001';
    await admin.query(`INSERT INTO app.organizations(id,name,slug,kind) VALUES($1,'Credit proof','credit-proof-org','direct_customer')`, [org]);
    await admin.query(`INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES($1,$2,'Credit proof','credit-proof-ws')`, [ws, org]);
    await admin.query(`INSERT INTO app.users(id,email,status,display_name,email_verified_at) VALUES($1,'credit-buyer@example.invalid','active','Credit Buyer',now())`, [buyer]);
    await admin.query(`INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES($1,$2,'owner','active')`, [org, buyer]);
    await admin.query(`INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES($1,$2,$3,'owner','active')`, [ws, org, buyer]);
    await admin.query(`INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience)
      VALUES($1,$2,$3,$4,now()+interval '1 hour','martin_howard_property')`, [createHash('sha256').update(tokenFor('credit')).digest(), createHash('sha256').update('credit-csrf').digest(), buyer, ws]);
    const order = (session: string, kits: string[], amount: number, daysAgo: number, refunded = false, account = 'acct_creditproof') => admin.query(
      `INSERT INTO app_private.mhp_kit_orders(stripe_account,live,session_id,payment_intent_id,email,kind,kits,modules,amount_pence,paid_at,refunded_at)
       VALUES($1,false,$2,$3,'credit-buyer@example.invalid',$4,$5,$6,$7,now()-make_interval(days=>$8),$9)`,
      [account, session, `pi_${session.slice(8)}`, kits.length === 1 ? 'single' : 'pair', kits, kits.map(() => '25'), amount, daysAgo, refunded ? new Date() : null]);
    await order('cs_test_c1', ['land-gap'], 2700, 2);
    await order('cs_test_c2', ['brrr', 'title-splitting'], 9700, 30);
    await order('cs_test_c3', ['hmos-wales-first'], 9700, 120);             // older than 90 days: no credit
    await order('cs_test_c4', ['auctions-and-legal-packs'], 9700, 5, true); // refunded: no credit

    const refunds: { charge: string; amount: number; key: string }[] = [];
    const stripe = { refunds: { create: async (p: { charge: string; amount: number }, o: { idempotencyKey: string }) => { refunds.push({ charge: p.charge, amount: p.amount, key: o.idempotencyKey }); return { id: 're_x' }; } } } as unknown as Stripe;
    const kits = new PgMhpKitService(web, identity, webhook, stripe, { accountId: 'acct_creditproof', live: false } as MhpCommerceConfig);
    const course = { sessionId: 'cs_test_course1', email: 'Credit-Buyer@example.invalid', paidAt: new Date().toISOString(), chargeId: 'ch_course1', chargeAmount: 149700, alreadyRefunded: 0 };

    assert.deepEqual((await kits.myKits(tokenFor('credit'))).credit?.amountPence, 2700 + 9700);
    assert.deepEqual(await kits.applyCourseCredit(course), { creditedPence: 0, capped: false }, 'off until 0150 is confirmed');
    kits.creditEnabled = true;
    assert.deepEqual(await kits.applyCourseCredit(course), { creditedPence: 12400, capped: false });
    assert.deepEqual(refunds, [{ charge: 'ch_course1', amount: 12400, key: 'mhp-kit-credit:cs_test_course1' }]);
    // A replayed receipt claims the same orders; Stripe's idempotency key makes the refund the same request.
    assert.deepEqual(await kits.applyCourseCredit(course), { creditedPence: 12400, capped: false });
    assert.equal(refunds[1]!.key, refunds[0]!.key);
    // A second course purchase finds nothing left to credit, and the kits page shows no credit.
    assert.equal((await kits.myKits(tokenFor('credit'))).credit?.amountPence, 0);
    await order('cs_test_c5', ['doing-it-properly'], 9700, 5, false, 'acct_otheraccount'); // paid on another Stripe account
    assert.deepEqual(await kits.applyCourseCredit({ ...course, sessionId: 'cs_test_course2' }), { creditedPence: 0, capped: false });
    // Credit never empties the course payment: at least £1 stays paid, so it can't read as a full refund.
    await order('cs_test_c6', ['brrr'], 9700, 1);
    assert.deepEqual(await kits.applyCourseCredit({ ...course, sessionId: 'cs_test_course3', chargeAmount: 5000, alreadyRefunded: 0 }), { creditedPence: 4900, capped: true });
    // Kits still open after being credited.
    assert.deepEqual((await kits.myKits(tokenFor('credit'))).kits.map(k => k.kit).sort(), ['brrr', 'doing-it-properly', 'hmos-wales-first', 'land-gap', 'title-splitting']);
    await assert.rejects(admin.query(`SELECT app_private.mhp_claim_kit_credit('acct_creditproof',false,'x@example.invalid','not-a-session',now())`), /Invalid course credit claim/);
  } finally {
    await Promise.allSettled([web.end(), identity.end(), webhook.end()]);
    await admin.end();
  }
});
