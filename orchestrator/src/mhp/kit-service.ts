import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import type { Pool } from 'pg';
import Stripe from 'stripe';
import { MHP_BRAND, MHP_ORIGIN, MHP_SITE, MHP_TERMS_URL, mhpPounds } from './catalog.js';
import type { MhpCommerceConfig } from './commerce-config.js';
import { MHP_KITS, MHP_KIT_REPLAYS, MHP_KIT_SLUG, MHP_SELLER_FOOTER, mhpKit, mhpKitModule, mhpKitPairPrice, mhpKitPrice, type MhpKit } from './kits.js';

/** Module kits (MHP-KITS-001): checkout, signed receipts, after-payment work and private downloads. */
export class MhpKitError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
type QueryPool = Pick<Pool, 'query'>;
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const idOf = (value: string | { id: string } | null | undefined): string | null => typeof value === 'string' ? value : value?.id ?? null;
/** Stripe's shortest Checkout expiry is 30 minutes; one extra minute covers network time. */
const MIN_CHECKOUT_SECONDS = 1_860;
export const MHP_KIT_THANKS_URL = `${MHP_SITE}/kits/thanks/`;
export const MHP_KITS_PAGE = '/app/kits';
const TERMS_MESSAGE = 'I want immediate access to this digital content and I understand this ends my 14-day right to cancel. '
  + `Martin still offers a voluntary 14-day, no-questions refund. [Terms](${MHP_TERMS_URL}).`;
const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const FILE_NAME = /^[a-z0-9][a-z0-9.-]{0,150}\.(pdf|xlsx|docx)$/;

export interface MhpKitJob {
  id: string; lease: string; email: string; name: string; kind: 'single' | 'pair'; kits: string[];
  amountPence: number; paidAt: string; receiptState: string; attempt: number;
}
export interface MhpMyKits { isAdmin: boolean; kits: { kit: string; orderedAt: string }[]; files: { kit: string; name: string; size: number }[] }
export interface MhpKitMailer {
  readonly configured: boolean;
  sendKitReceipt?(email: string, name: string, receipt: MhpKitReceipt): Promise<void>;
}
export interface MhpKitReceipt { kits: { name: string; module: string }[]; amountPence: number; paidAt: string; replay: boolean }
/** Registers a kit buyer for a webinar replay; the webinar service sends the access email. */
export type MhpKitReplayRegistrar = (publicKey: string, email: string, name: string) => Promise<void>;
/** Records a paid kit in the MHP CRM (contact, opportunity at Won, purchase note). Idempotent per key. */
export type MhpKitCrmRecorder = (input: { key: string; email: string; name: string; title: string; note: string }) => Promise<void>;

/** Parsed and checked Stripe Checkout metadata of a kit session. */
function kitsOf(raw: string | undefined): MhpKit[] | null {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const slugs = raw.split(',');
  if (slugs.length < 1 || slugs.length > 2 || new Set(slugs).size !== slugs.length) return null;
  const kits = slugs.map(slug => mhpKit(slug));
  return kits.every(Boolean) ? kits as MhpKit[] : null;
}

export class PgMhpKitService {
  constructor(private readonly readPool: QueryPool, private readonly commandPool: QueryPool, private readonly webhookPool: QueryPool | null,
    private readonly stripe: Stripe | null, private readonly config: MhpCommerceConfig | null, private readonly now: () => number = Date.now) {}

  get billingEnabled(): boolean { return this.stripe !== null && this.config !== null && this.webhookPool !== null; }
  private enabled(): { stripe: Stripe; config: MhpCommerceConfig; pool: QueryPool } {
    if (!this.stripe || !this.config || !this.webhookPool) throw new MhpKitError(503, 'Kit checkout is opening shortly. Please try again soon.');
    return { stripe: this.stripe, config: this.config, pool: this.webhookPool };
  }

  /** One kit at the price of this moment, or two kits for the higher standard price. Server time decides. */
  async checkout(slugs: string[]): Promise<string> {
    const { stripe, config } = this.enabled();
    if (slugs.length < 1 || slugs.length > 2 || slugs.some(s => !MHP_KIT_SLUG.test(s)) || new Set(slugs).size !== slugs.length) {
      throw new MhpKitError(400, slugs.length === 2 ? 'Choose two different kits.' : 'Choose a kit on the kits page.');
    }
    const kits = slugs.map(slug => mhpKit(slug));
    if (kits.some(k => !k)) throw new MhpKitError(400, 'That kit is not on sale. Choose a kit on the kits page.');
    const pair = kits.length === 2;
    const now = this.now(), nowSeconds = Math.floor(now / 1_000);
    const [first, second] = kits as MhpKit[];
    const price = pair ? { pricePence: mhpKitPairPrice(first!, second!), intro: false, endsAt: null } : mhpKitPrice(first!, now);
    // A launch-price checkout expires at the launch end; in its final 31 minutes Stripe's 30-minute floor applies.
    const expiresAt = price.endsAt !== null
      ? Math.max(nowSeconds + MIN_CHECKOUT_SECONDS, Math.min(nowSeconds + 23 * 3_600, Math.floor(price.endsAt / 1_000)))
      : nowSeconds + 23 * 3_600;
    const label = pair ? `${first!.name} + ${second!.name}` : first!.name;
    const metadata = { brand: MHP_BRAND, mhp_checkout: pair ? 'kit_pair' : 'kit', kits: slugs.join(','), price_pence: String(price.pricePence) };
    const session = await stripe.checkout.sessions.create({
      mode: 'payment', payment_method_types: ['card'], allow_promotion_codes: false, expires_at: expiresAt,
      customer_creation: 'always', billing_address_collection: 'auto',
      line_items: [{ quantity: 1, price_data: { currency: 'gbp', unit_amount: price.pricePence,
        product_data: { name: label, description: pair ? 'Two module kits: field guides, calculators and lessons. Lifetime access.'
          : 'Module kit: field guide, calculator and lessons. Lifetime access.', metadata: { brand: MHP_BRAND, kits: slugs.join(',') } } } }],
      consent_collection: { terms_of_service: 'required' },
      custom_text: {
        terms_of_service_acceptance: { message: TERMS_MESSAGE },
        submit: { message: `${label}. ${mhpPounds(price.pricePence)}, paid once.` },
        after_submit: { message: MHP_SELLER_FOOTER },
      },
      metadata, payment_intent_data: { metadata, description: label },
      success_url: pair ? `${MHP_ORIGIN}${MHP_KITS_PAGE}?bought=1` : `${MHP_KIT_THANKS_URL}?kit=${encodeURIComponent(first!.kit)}`,
      cancel_url: pair ? MHP_KIT_THANKS_URL : `${MHP_SITE}/kits/${encodeURIComponent(first!.kit)}/`,
    }, { timeout: 8_000, maxNetworkRetries: 1 });
    if (session.livemode !== config.live || session.status !== 'open' || !session.url || session.amount_total !== price.pricePence) {
      throw new MhpKitError(503, 'Checkout is temporarily unavailable.');
    }
    const url = new URL(session.url);
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') throw new MhpKitError(503, 'Checkout is temporarily unavailable.');
    return url.href;
  }

  /**
   * A signed Stripe event that belongs to a kit, already verified by the MHP webhook. Returns false for anything
   * that is not a kit, so the course path handles it exactly as before.
   */
  async handleEvent(event: Stripe.Event): Promise<boolean> {
    const { stripe, config, pool } = this.enabled();
    if (event.type === 'checkout.session.completed') {
      const kind = event.data.object.metadata?.mhp_checkout;
      if (kind !== 'kit' && kind !== 'kit_pair') return false;
      const session = await stripe.checkout.sessions.retrieve(event.data.object.id);
      const kits = kitsOf(session.metadata?.kits);
      const paid = session.amount_total ?? -1;
      const intent = idOf(session.payment_intent);
      const email = session.customer_details?.email?.trim().toLowerCase() ?? '';
      const ok = session.status === 'complete' && session.payment_status === 'paid' && session.livemode === config.live && session.mode === 'payment'
        && session.currency === 'gbp' && session.metadata?.brand === MHP_BRAND && session.metadata.mhp_checkout === kind
        && kits && kits.length === (kind === 'kit' ? 1 : 2) && intent && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320
        && (kind === 'kit_pair' ? paid === mhpKitPairPrice(kits[0]!, kits[1]!)
          : paid === kits[0]!.pricePence || (kits[0]!.introPricePence !== null && paid === kits[0]!.introPricePence));
      if (!ok) throw new MhpKitError(422, 'Kit payment evidence does not match the kit catalogue.');
      const paidAt = new Date(this.now()).toISOString();
      if (kind === 'kit' && paid === kits[0]!.introPricePence && kits[0]!.introEndsAt && Date.parse(paidAt) >= Date.parse(kits[0]!.introEndsAt)) {
        // Only possible in Stripe's final 30-minute floor; recorded so the money and access stay consistent.
        console.warn(JSON.stringify({ event: 'mhp.kit.late-launch-price', kit: kits[0]!.kit }));
      }
      await pool.query('SELECT app_private.mhp_record_kit_order($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
        config.accountId, config.live, session.id, intent, email, session.customer_details?.name ?? '',
        kind === 'kit' ? 'single' : 'pair', kits.map(k => k.kit), kits.map(mhpKitModule), paid, paidAt]);
      return true;
    }
    if (event.type === 'charge.refunded') {
      const charge = event.data.object;
      const intent = idOf(charge.payment_intent);
      if (!intent) return false;
      const paymentIntent = await stripe.paymentIntents.retrieve(intent);
      const kind = paymentIntent.metadata?.mhp_checkout;
      if (paymentIntent.metadata?.brand !== MHP_BRAND || (kind !== 'kit' && kind !== 'kit_pair')) return false;
      // A full refund ends access to the kit; a partial goodwill refund leaves it in place.
      if (charge.livemode === config.live && charge.amount_refunded >= charge.amount) {
        await pool.query('SELECT app_private.mhp_refund_kit_order($1,$2,$3)', [config.accountId, config.live, intent]);
      }
      return true;
    }
    return false;
  }

  /** One order's after-payment work: receipt (once), webinar replay and CRM (both repeatable). */
  async runJob(deps: { mail: MhpKitMailer; replay?: MhpKitReplayRegistrar; crm?: MhpKitCrmRecorder }): Promise<'idle' | 'done' | 'retry'> {
    const { config, pool } = this.enabled();
    const claimed = await pool.query<{ job: MhpKitJob | null }>('SELECT app_private.mhp_claim_kit_job($1,$2) AS job', [config.accountId, config.live]);
    const job = claimed.rows[0]?.job;
    if (!job) return 'idle';
    const kits = job.kits.map(slug => mhpKit(slug)).filter((k): k is MhpKit => Boolean(k));
    const name = job.name || job.email.split('@')[0]!;
    let complete = true;
    if (job.receiptState === 'pending' && deps.mail.configured && deps.mail.sendKitReceipt) {
      const begun = await pool.query<{ allowed: boolean }>('SELECT app_private.mhp_begin_kit_receipt($1,$2) AS allowed', [job.id, job.lease]);
      if (begun.rows[0]?.allowed) {
        let result: 'sent' | 'rejected' | 'unknown' = 'sent';
        try {
          await deps.mail.sendKitReceipt(job.email, name, { kits: kits.map(k => ({ name: k.name, module: mhpKitModule(k) })),
            amountPence: job.amountPence, paidAt: job.paidAt, replay: kits.some(k => MHP_KIT_REPLAYS[k.kit]) });
        } catch (error) { result = (error as { outcome?: string })?.outcome === 'rejected' ? 'rejected' : 'unknown'; }
        await pool.query('SELECT app_private.mhp_settle_kit_receipt($1,$2,$3)', [job.id, job.lease, result]);
      }
    } else if (job.receiptState === 'pending') complete = false;
    for (const kit of kits) {
      const replay = MHP_KIT_REPLAYS[kit.kit];
      if (!replay) continue;
      if (!deps.replay) { complete = false; continue; }
      try { await deps.replay(replay, job.email, name); } catch { complete = false; }
    }
    if (deps.crm) {
      const date = new Date(job.paidAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
      try {
        await deps.crm({ key: `mhp.kit.${job.id}`, email: job.email, name, title: `${kits.map(k => k.name).join(' + ')} · ${name}`.slice(0, 200),
          note: `Bought ${kits.map(k => k.name).join(' and ')} on ${date} (${mhpPounds(job.amountPence)})`.slice(0, 200) });
      } catch { complete = false; }
    } else complete = false;
    await pool.query('SELECT app_private.mhp_finish_kit_job($1,$2,$3)', [job.id, job.lease, complete]);
    return complete ? 'done' : 'retry';
  }

  async myKits(sessionToken: string): Promise<MhpMyKits> {
    const r = await this.readPool.query<{ kits: MhpMyKits }>('SELECT app_private.mhp_my_kits($1) AS kits', [digest(sessionToken)]);
    const kits = r.rows[0]?.kits;
    if (!kits || !Array.isArray(kits.kits) || !Array.isArray(kits.files)) throw new MhpKitError(503, 'Your kits could not load.');
    return kits;
  }

  async file(sessionToken: string, kit: string, name: string): Promise<{ contentType: string; bytes: Buffer } | null> {
    if (!MHP_KIT_SLUG.test(kit) || !FILE_NAME.test(name)) return null;
    try {
      const r = await this.readPool.query<{ content_type: string; bytes: Buffer }>('SELECT content_type, bytes FROM app_private.mhp_kit_file($1,$2,$3)',
        [digest(sessionToken), kit, name]);
      const row = r.rows[0];
      return row ? { contentType: row.content_type, bytes: row.bytes } : null;
    } catch (error) {
      if ((error as { code?: string })?.code === '42501') throw new MhpKitError(403, 'This download is part of a kit you have not bought.');
      throw error;
    }
  }

  /** Owner upload of the kit deliverables zip: one folder per kit slug. Replaces each uploaded kit's files. */
  async importZip(sessionToken: string, zip: Buffer): Promise<{ kits: number; files: number; skipped: string[] }> {
    const byKit = new Map<string, { name: string; type: string; base64: string }[]>();
    const skipped: string[] = [];
    for (const entry of readZip(zip)) {
      const parts = entry.name.split('/').filter(Boolean);
      if (entry.directory || parts.length === 0) continue;
      const [slug, file] = parts.length === 2 ? parts : [parts[parts.length - 2] ?? '', parts[parts.length - 1]!];
      const extension = /\.([a-z]+)$/.exec(file ?? '')?.[1] ?? '';
      if (!mhpKit(slug ?? '') || !file || !FILE_NAME.test(file) || !TYPES[extension]) { skipped.push(entry.name.slice(0, 120)); continue; }
      const list = byKit.get(slug!) ?? [];
      list.push({ name: file, type: TYPES[extension]!, base64: entry.data().toString('base64') });
      byKit.set(slug!, list);
    }
    if (!byKit.size) throw new MhpKitError(400, 'That zip has no kit folders. Upload kit-deliverables-v3.zip.');
    let files = 0;
    for (const [kit, list] of byKit) {
      if (list.length > 10) throw new MhpKitError(400, `The ${kit} folder has more than 10 files.`);
      try {
        const r = await this.commandPool.query<{ stored: number }>('SELECT app_private.mhp_store_kit_files($1,$2,$3::jsonb) AS stored',
          [digest(sessionToken), kit, JSON.stringify(list)]);
        files += r.rows[0]?.stored ?? 0;
      } catch (error) {
        if ((error as { code?: string })?.code === '42501') throw new MhpKitError(403, 'Owner access is required to upload kit files.');
        throw error;
      }
    }
    return { kits: byKit.size, files, skipped };
  }
}

/** Every kit in the catalogue, for the owner's upload page. */
export const MHP_KIT_LIST = MHP_KITS;

/** A minimal zip reader (stored and deflated entries) for the owner's upload. Bounded: 200 entries, 20 MB each. */
export function readZip(zip: Buffer): { name: string; directory: boolean; data: () => Buffer }[] {
  const bad = (): never => { throw new MhpKitError(400, 'That file is not a readable zip.'); };
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) bad();
  const count = zip.readUInt16LE(end + 10), size = zip.readUInt32LE(end + 12), offset = zip.readUInt32LE(end + 16);
  if (count > 200 || offset + size > zip.length) bad();
  const entries: { name: string; directory: boolean; data: () => Buffer }[] = [];
  let at = offset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) bad();
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20), uncompressed = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28), extraLength = zip.readUInt16LE(at + 30), commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (name.includes('..') || name.startsWith('/') || name.includes('\\') || (flags & 1) || uncompressed > 20_000_000) bad();
    entries.push({ name, directory: name.endsWith('/'), data: () => {
      if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) bad();
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(start, start + compressed);
      if (raw.length !== compressed) bad();
      const out = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: 20_000_000 }) : bad();
      if (out.length !== uncompressed) bad();
      return out;
    } });
  }
  return entries;
}

/** Runs kit after-payment work every 15 seconds; a failing order is retried with backoff, never re-emailed. */
export function startMhpKitJobs(kits: PgMhpKitService, deps: Parameters<PgMhpKitService['runJob']>[0], onError: () => void): () => void {
  let running = false;
  const run = async (): Promise<void> => {
    if (running || !kits.billingEnabled) return;
    running = true;
    try { for (let i = 0; i < 10; i++) { if (await kits.runJob(deps) === 'idle') break; } }
    catch { onError(); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void run(); }, 15_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
