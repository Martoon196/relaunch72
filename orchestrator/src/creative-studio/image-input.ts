/** Structural verification of owner-supplied or stored image bytes before any renderer sees them. */
import { createHash } from 'node:crypto';
import { decodeVerifiedJpeg, JpegPreparationError } from '../seo-blog/jpeg-preparation.js';

export const CREATIVE_IMAGE_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, dimension: 8192, pixels: 8_000_000 });

export interface VerifiedImage {
  readonly mime: 'image/jpeg' | 'image/png';
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  /** Private copy; never serialised into ordinary metadata. */
  readonly bytes: Buffer;
}

export class CreativeImageError extends Error {
  constructor(message: string) { super(message); this.name = 'CreativeImageError'; }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Walk every PNG chunk, check CRCs and bounds, and read the IHDR dimensions. */
function inspectPng(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new CreativeImageError('That PNG is incomplete or malformed.');
  let at = 8; let header: { width: number; height: number } | null = null; let sawData = false; let chunks = 0;
  while (at + 12 <= bytes.length) {
    if (++chunks > 10_000) throw new CreativeImageError('That PNG has too many chunks.');
    const length = bytes.readUInt32BE(at); const type = bytes.toString('latin1', at + 4, at + 8);
    if (length > bytes.length - at - 12 || !/^[A-Za-z]{4}$/u.test(type)) throw new CreativeImageError('That PNG is incomplete or malformed.');
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== bytes.readUInt32BE(at + 8 + length)) throw new CreativeImageError('That PNG failed its integrity check.');
    if (chunks === 1) {
      if (type !== 'IHDR' || length !== 13) throw new CreativeImageError('That PNG is incomplete or malformed.');
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4) };
      if (body[12] !== 0 && body[12] !== 1) throw new CreativeImageError('That PNG uses an unsupported interlace mode.');
    }
    if (type === 'IDAT') sawData = true;
    at += 12 + length;
    if (type === 'IEND') {
      if (at !== bytes.length || !header || !sawData) throw new CreativeImageError('That PNG is incomplete or malformed.');
      return header;
    }
  }
  throw new CreativeImageError('That PNG is incomplete or malformed.');
}

export function verifyCreativeImage(input: Uint8Array): VerifiedImage {
  if (!(input instanceof Uint8Array) || input.byteLength < 8 || input.byteLength > CREATIVE_IMAGE_LIMITS.bytes) {
    throw new CreativeImageError('Upload a JPEG or PNG of at most 8 MB.');
  }
  const bytes = Buffer.from(input);
  let mime: VerifiedImage['mime']; let width: number; let height: number;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    try { ({ width, height } = decodeVerifiedJpeg(bytes)); }
    catch (error) { throw new CreativeImageError(error instanceof JpegPreparationError ? error.message : 'That JPEG could not be read.'); }
    mime = 'image/jpeg';
  } else if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    ({ width, height } = inspectPng(bytes)); mime = 'image/png';
  } else {
    throw new CreativeImageError('Only JPEG and PNG images are supported. SVG and other formats are not accepted.');
  }
  if (!width || !height || width > CREATIVE_IMAGE_LIMITS.dimension || height > CREATIVE_IMAGE_LIMITS.dimension || width * height > CREATIVE_IMAGE_LIMITS.pixels) {
    throw new CreativeImageError('That image is too large. Use at most 8 megapixels.');
  }
  const result = { mime, width, height, sha256: createHash('sha256').update(bytes).digest('hex') };
  Object.defineProperty(result, 'bytes', { enumerable: false, get: () => Buffer.from(bytes) });
  return Object.freeze(result) as VerifiedImage;
}
