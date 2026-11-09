/**
 * Synthetic, clearly fictional fixtures for the creative studio. The landscape
 * is procedurally drawn here — it is not a provider output, photograph or real
 * place — and exists only to exercise layout, focal crops and contrast checks
 * against a busy, photographic-style background.
 */
import jpeg from 'jpeg-js';
import { deflateSync } from 'node:zlib';

function noise(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

/** A bright, high-detail landscape: sky, sun, hills and grass texture. */
export function syntheticLandscapeJpeg(width = 1536, height = 1024, warm = true): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, t = y / height;
      let r = warm ? 250 - 70 * t : 150 - 60 * t, g = warm ? 205 - 40 * t : 200 - 50 * t, b = warm ? 150 + 60 * t : 245 - 30 * t;
      const sun = Math.hypot(x - width * 0.68, y - height * 0.3);
      if (sun < height * 0.09) { r = 255; g = 245; b = 210; } else if (sun < height * 0.2) { const k = 1 - (sun - height * 0.09) / (height * 0.11); r += 40 * k; g += 30 * k; b += 10 * k; }
      const hill1 = height * (0.58 + 0.06 * Math.sin(x / 210)), hill2 = height * (0.7 + 0.05 * Math.sin(x / 130 + 1.7));
      if (y > hill1) { r = 70 + 40 * noise(x, y); g = 130 + 50 * noise(y, x); b = 60; }
      if (y > hill2) { const blade = noise(Math.floor(x / 3), Math.floor(y / 9)); r = 110 + 90 * blade; g = 170 + 70 * blade; b = 70 + 40 * blade; }
      data[i] = Math.max(0, Math.min(255, r)); data[i + 1] = Math.max(0, Math.min(255, g)); data[i + 2] = Math.max(0, Math.min(255, b)); data[i + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data, width, height }, 88).data);
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc(b: Buffer): number { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

/** A transparent RGBA PNG logo mark: rounded square with an initial-like bar shape. */
export function syntheticLogoPng(color: [number, number, number], width = 360, height = 120): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) {
      const inMark = x < height && Math.hypot(Math.max(0, Math.abs(x - height / 2) - height * 0.3), Math.max(0, Math.abs(y - height / 2) - height * 0.3)) < height * 0.18;
      const inBar = x > height * 1.2 && x < width - 10 && Math.abs(y - height / 2) < height * (x % 60 < 40 ? 0.22 : 0);
      const o = 1 + x * 4;
      if (inMark || inBar) { row[o] = color[0]; row[o + 1] = color[1]; row[o + 2] = color[2]; row[o + 3] = 255; }
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// ─── Two isolated, clearly fictional brands created through the real engine ──
import { randomUUID } from 'node:crypto';
import { harness, OWNER } from './seo-blog-fixtures.js';
import type { BrandProfile } from '../src/seo-blog/types.js';

export type CreativeHarness = ReturnType<typeof harness>;

/** Create and confirm a brand profile with explicit offers, claims and destinations (no model-invented facts). */
export async function creativeBrand(h: CreativeHarness, input: {
  name: string; website: string; offers: BrandProfile['offers']; claims: string[]; pages: { url: string; label: string }[]; audiences: string[]; positioning: string; exclusions?: string[];
  visualGuidance?: string; owner?: { userId: string };
}) {
  const owner = input.owner ?? OWNER;
  const { brand } = await h.engine.createBrand(owner, { commandId: randomUUID(), name: input.name, website: input.website });
  // Scripted test model only (no provider): extraction needs a configured writing allowance.
  await h.engine.updateSettings(owner, brand.id, brand.rowVersion, { budgets: { modelTokensPerMonth: 1_000_000, searchCallsPerMonth: 0, imagesPerMonth: 0 } });
  await h.engine.uploadKnowledge(owner, brand.id, { category: 'product_facts', title: 'Offers', pastedText: input.offers.map((o) => `${o.name}: ${o.description} ${o.price ?? ''}`).join('\n') });
  if (input.visualGuidance) await h.engine.uploadKnowledge(owner, brand.id, { category: 'visual_guidance', title: 'Visual guidance', pastedText: input.visualGuidance });
  const extracted = await h.engine.extractBrandProfile(owner, brand.id);
  const edited = await h.engine.editProfile(owner, brand.id, extracted.version, {
    offers: input.offers, approvedClaims: input.claims, conversionPages: input.pages, audiences: input.audiences, positioning: input.positioning,
    exclusions: input.exclusions ?? [], conflicts: [], missingFacts: [],
  });
  const profile = await h.engine.confirmProfile(owner, brand.id, edited.version);
  return { brand, profile, owner };
}

export const HEARTH = {
  name: 'Fictional Hearth Maintenance', website: 'https://hearth.example',
  offers: [{ name: 'Annual boiler service', description: 'A yearly safety check and service of a domestic gas boiler by a registered engineer.', price: '£89', url: 'https://hearth.example/book', sourceDocumentId: null }],
  claims: ['Every engineer is registered for gas work.', 'Appointments are offered in two-hour windows.'],
  pages: [{ url: 'https://hearth.example/book', label: 'Book a service' }],
  audiences: ['Homeowners in Leeds'], positioning: 'Calm, punctual home maintenance for busy households. We explain every job in plain English.',
  exclusions: ['guaranteed savings'], visualGuidance: 'Warm, homely photography. Brand teal #0f766e with a sunny accent #fbbf24.',
};
export const QUEUE = {
  name: 'Fictional Queue Scheduling', website: 'https://queue.example',
  offers: [{ name: 'Scheduling demonstration', description: 'A 30-minute walkthrough of appointment scheduling for clinic operations teams.', price: null, url: 'https://queue.example/demo', sourceDocumentId: null }],
  claims: ['Reminders are sent by email and text message.'],
  pages: [{ url: 'https://queue.example/demo', label: 'Request a demo' }],
  audiences: ['Clinic operations managers'], positioning: 'Clear appointment coordination for busy clinics.',
};
