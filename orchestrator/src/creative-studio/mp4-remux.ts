/**
 * Lossless conversion of a browser-recorded fragmented MP4 (single track, as written by
 * Chromium's MediaRecorder) into a standard progressive MP4 with the index first
 * ("fast start"): the same encoded samples, complete sample tables and real durations.
 * No re-encoding, no dependency. Any structure outside the narrow supported shape
 * returns null so the caller keeps the original bytes rather than guessing.
 */

export interface Box { readonly type: string; readonly start: number; readonly header: number; readonly end: number }
/** Top-level or child box walk; null on any malformed size. */
export function boxes(b: Buffer, start: number, end: number): Box[] | null {
  const out: Box[] = [];
  for (let o = start; o < end;) {
    if (o + 8 > end) return null;
    let size = b.readUInt32BE(o), header = 8;
    if (size === 1) { if (o + 16 > end) return null; size = Number(b.readBigUInt64BE(o + 8)); header = 16; }
    else if (size === 0) size = end - o;
    if (size < header || o + size > end) return null;
    out.push({ type: b.toString('latin1', o + 4, o + 8), start: o, header, end: o + size });
    o += size;
  }
  return out;
}
export const child = (b: Buffer, parent: Box, type: string) => boxes(b, parent.start + parent.header, parent.end)?.find((x) => x.type === type) ?? null;
const box = (type: string, ...parts: Buffer[]) => { const body = Buffer.concat(parts); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); };
const full = (type: string, version: number, flags: number, ...parts: Buffer[]) => { const vf = Buffer.alloc(4); vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0); return box(type, vf, ...parts); };
const u32 = (...values: number[]) => { const out = Buffer.alloc(values.length * 4); values.forEach((v, i) => out.writeUInt32BE(v >>> 0, i * 4)); return out; };

/**
 * Rewrites a duration field in a copy of an mvhd/mdhd/tkhd box (version 0 or 1).
 * mvhd/mdhd: creation, modification, timescale(4), duration  → v0 +12, v1 +20.
 * tkhd:      creation, modification, track_ID(4), reserved(4), duration → v0 +16, v1 +24.
 */
export function withDuration(b: Buffer, x: Box, duration: number): Buffer | null {
  const copy = Buffer.from(b.subarray(x.start, x.end)), v = copy[x.header]!, base = x.header + 4;
  const at = x.type === 'tkhd' ? (v === 1 ? base + 24 : base + 16) : (v === 1 ? base + 20 : base + 12);
  if (at + (v === 1 ? 8 : 4) > copy.length) return null;
  if (v === 1) copy.writeBigUInt64BE(BigInt(duration), at); else copy.writeUInt32BE(Math.min(0xffffffff, duration), at);
  return copy;
}
function timescale(b: Buffer, x: Box): number { const v = b[x.start + x.header]!; return b.readUInt32BE(x.start + x.header + 4 + (v === 1 ? 16 : 8)); }

export function remuxFragmentedMp4(input: Buffer): Buffer | null {
  const b = Buffer.from(input);
  const top = boxes(b, 0, b.length);
  if (!top) return null;
  const ftyp = top.find((x) => x.type === 'ftyp'), moov = top.find((x) => x.type === 'moov');
  if (!ftyp || !moov || top[0] !== ftyp || !top.some((x) => x.type === 'moof')) return null;
  const traks = boxes(b, moov.start + moov.header, moov.end)?.filter((x) => x.type === 'trak') ?? [];
  if (traks.length !== 1) return null;
  const trak = traks[0]!, mvhd = child(b, moov, 'mvhd'), tkhd = child(b, trak, 'tkhd'), mdia = child(b, trak, 'mdia');
  const mdhd = mdia && child(b, mdia, 'mdhd'), hdlr = mdia && child(b, mdia, 'hdlr'), minf = mdia && child(b, mdia, 'minf');
  const stbl = minf && child(b, minf, 'stbl'), stsd = stbl && child(b, stbl, 'stsd');
  if (!mvhd || !tkhd || !mdhd || !hdlr || !minf || !stsd) return null;
  const trex = (() => { const mvex = child(b, moov, 'mvex'); return mvex ? child(b, mvex, 'trex') : null; })();
  const trexDefaults = trex ? { duration: b.readUInt32BE(trex.start + trex.header + 12), size: b.readUInt32BE(trex.start + trex.header + 16), flags: b.readUInt32BE(trex.start + trex.header + 20) } : { duration: 0, size: 0, flags: 0 };

  const durations: number[] = [], sizes: number[] = [], sync: number[] = [], chunks: Buffer[] = [];
  let firstDecode: number | null = null;
  for (const moof of top.filter((x) => x.type === 'moof')) {
    const trafs = boxes(b, moof.start + moof.header, moof.end)?.filter((x) => x.type === 'traf') ?? [];
    if (trafs.length !== 1) return null;
    const traf = trafs[0]!, tfhd = child(b, traf, 'tfhd'), tfdt = child(b, traf, 'tfdt'), truns = boxes(b, traf.start + traf.header, traf.end)?.filter((x) => x.type === 'trun') ?? [];
    if (!tfhd || truns.length !== 1) return null;
    const tf = b.readUInt32BE(tfhd.start + tfhd.header) & 0xffffff;
    if (tf & 0x01 || !(tf & 0x20000)) return null; // only default-base-is-moof offsets are supported
    let p = tfhd.start + tfhd.header + 8; // version/flags + track_ID
    if (tf & 0x02) p += 4; // sample_description_index
    const defDuration = tf & 0x08 ? b.readUInt32BE((p += 4) - 4) : trexDefaults.duration;
    const defSize = tf & 0x10 ? b.readUInt32BE((p += 4) - 4) : trexDefaults.size;
    const defFlags = tf & 0x20 ? b.readUInt32BE((p += 4) - 4) : trexDefaults.flags;
    if (tfdt && firstDecode === null) { const v = b[tfdt.start + tfdt.header]!; firstDecode = v === 1 ? Number(b.readBigUInt64BE(tfdt.start + tfdt.header + 4)) : b.readUInt32BE(tfdt.start + tfdt.header + 4); }
    const trun = truns[0]!, rf = b.readUInt32BE(trun.start + trun.header) & 0xffffff, count = b.readUInt32BE(trun.start + trun.header + 4);
    if (rf & 0x800 || !(rf & 0x01) || count < 1 || count > 1_000_000) return null; // no composition offsets; data offset required
    let q = trun.start + trun.header + 8;
    const dataOffset = b.readInt32BE(q); q += 4;
    const firstFlags = rf & 0x04 ? b.readUInt32BE((q += 4) - 4) : null;
    let at = moof.start + dataOffset;
    for (let i = 0; i < count; i++) {
      const duration = rf & 0x100 ? b.readUInt32BE((q += 4) - 4) : defDuration;
      const size = rf & 0x200 ? b.readUInt32BE((q += 4) - 4) : defSize;
      const flags = rf & 0x400 ? b.readUInt32BE((q += 4) - 4) : i === 0 && firstFlags !== null ? firstFlags : defFlags;
      if (q > trun.end || size < 1 || at + size > b.length) return null;
      chunks.push(b.subarray(at, at + size)); at += size;
      durations.push(duration); sizes.push(size);
      if (!(flags & 0x10000)) sync.push(durations.length);
    }
  }
  if (!durations.length || firstDecode !== 0 || !sync.length || sync[0] !== 1 || durations.some((d) => d <= 0)) return null;
  const mediaDuration = durations.reduce((n, d) => n + d, 0);
  const movieDuration = Math.round(mediaDuration * timescale(b, mvhd) / timescale(b, mdhd));
  const stts: number[] = [];
  for (const d of durations) { if (stts.length && stts[stts.length - 1] === d) stts[stts.length - 2]!++; else stts.push(1, d); }
  const build = (chunkOffset: number) => {
    const sampleTable = box('stbl', Buffer.from(b.subarray(stsd.start, stsd.end)),
      full('stts', 0, 0, u32(stts.length / 2, ...stts)), full('stss', 0, 0, u32(sync.length, ...sync)),
      full('stsc', 0, 0, u32(1, 1, durations.length, 1)), full('stsz', 0, 0, u32(0, sizes.length, ...sizes)), full('stco', 0, 0, u32(1, chunkOffset)));
    const minfChildren = (boxes(b, minf.start + minf.header, minf.end) ?? []).filter((x) => x.type !== 'stbl').map((x) => Buffer.from(b.subarray(x.start, x.end)));
    const media = box('mdia', withDuration(b, mdhd, mediaDuration)!, Buffer.from(b.subarray(hdlr.start, hdlr.end)), box('minf', ...minfChildren, sampleTable));
    return box('moov', withDuration(b, mvhd, movieDuration)!, box('trak', withDuration(b, tkhd, movieDuration)!, media));
  };
  const head = Buffer.from(b.subarray(ftyp.start, ftyp.end));
  const probe = build(0);
  const payload = Buffer.concat(chunks);
  if (payload.length + 8 > 0xffffffff) return null;
  const moovOut = build(head.length + probe.length + 8);
  if (moovOut.length !== probe.length) return null;
  return Buffer.concat([head, moovOut, box('mdat', payload)]);
}
