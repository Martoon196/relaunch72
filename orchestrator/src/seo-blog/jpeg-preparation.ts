/** Bytes-in preparation only. No provider, storage, approval or publishing effects. */
import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';

export const JPEG_PREPARATION_LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024, inputPixels: 8_000_000, inputDimension: 8192,
  decoderMemoryMiB: 128, variants: 3, outputPixels: 1_500_000, outputBytes: 600_000,
});
export const JPEG_VARIANT_PROFILES = Object.freeze({
  blog: Object.freeze({ width: 1600, height: 900 }),
  instagram: Object.freeze({ width: 1080, height: 1350 }),
  linkedin: Object.freeze({ width: 1200, height: 627 }),
});
export type JpegVariantProfile = keyof typeof JPEG_VARIANT_PROFILES;
export interface JpegFocalPoint { readonly x: number; readonly y: number }
export interface JpegCrop { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface JpegTransformRecipe {
  readonly version: 'r72-jpeg-focal-v1';
  readonly sourceSha256: string;
  readonly profile: JpegVariantProfile;
  readonly focal: JpegFocalPoint;
  readonly crop: JpegCrop;
  readonly width: number;
  readonly height: number;
  readonly quality: number;
  readonly metadataStripped: true;
}
export interface PreparedJpeg {
  readonly mimeType: 'image/jpeg';
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  /** Each access returns a copy; callers cannot mutate the content-addressed asset. */
  readonly bytes: Buffer;
  readonly recipe: JpegTransformRecipe | null;
}
export class JpegPreparationError extends Error {
  constructor(readonly code: 'invalid_input' | 'malformed' | 'unsupported' | 'pixel_limit' | 'orientation' | 'recipe' | 'output_limit', message: string) {
    super(message); this.name = 'JpegPreparationError';
  }
}
function invalid(): never { throw new JpegPreparationError('malformed', 'The JPEG is incomplete or malformed.'); }
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

/** Read only IFD0's main-image orientation. Other EXIF data is never copied to a derivative. */
function checkExif(bytes: Buffer, start: number, end: number): void {
  if (end - start < 4 || bytes.toString('ascii', start, start + 4) !== 'Exif') return;
  if (end - start < 6 || bytes.toString('ascii', start, start + 6) !== 'Exif\0\0') invalid();
  const base = start + 6;
  if (end - base < 8) invalid();
  const order = bytes.toString('ascii', base, base + 2);
  if (order !== 'II' && order !== 'MM') invalid();
  const u16 = (at: number) => { if (at < base || at + 2 > end) invalid(); return order === 'II' ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at); };
  const u32 = (at: number) => { if (at < base || at + 4 > end) invalid(); return order === 'II' ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at); };
  if (u16(base + 2) !== 42) invalid();
  const offset = u32(base + 4);
  if (offset < 8 || offset > end - base - 2) invalid();
  const directory = base + offset;
  const entries = u16(directory);
  if (entries > 256 || directory + 2 + entries * 12 + 4 > end) invalid();
  for (let index = 0; index < entries; index++) {
    const at = directory + 2 + index * 12;
    if (u16(at) !== 0x0112) continue;
    if (u16(at + 2) !== 3 || u32(at + 4) !== 1) invalid();
    const orientation = u16(at + 8);
    if (orientation < 1 || orientation > 8) invalid();
    if (orientation !== 1) throw new JpegPreparationError('orientation', 'Rotate this image to its normal orientation before preparing variants.');
  }
}
function nextScanMarker(bytes: Buffer, start: number): number {
  let at = start;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) { at++; continue; }
    const markerAt = at++;
    while (at < bytes.length && bytes[at] === 0xff) at++;
    if (at >= bytes.length) invalid();
    const marker = bytes[at]!;
    if (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) { at++; continue; }
    return markerAt;
  }
  return invalid();
}

/** Entire marker structure is bounded and checked before invoking the allocating decoder. */
function inspectHeader(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new JpegPreparationError('unsupported', 'Only JPEG bytes are supported by this preparation component.');
  let at = 2; let segments = 0; let scans = 0;
  let frame: { width: number; height: number; components: number } | null = null;
  while (at < bytes.length) {
    if (++segments > 4096 || bytes[at++] !== 0xff) invalid();
    while (at < bytes.length && bytes[at] === 0xff) at++;
    if (at >= bytes.length) invalid();
    const marker = bytes[at++]!;
    if (marker === 0xd9) {
      if (at !== bytes.length || !frame || !scans) invalid();
      return { width: frame.width, height: frame.height };
    }
    if (marker === 0 || marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7) || at + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(at);
    if (length < 2 || length > bytes.length - at) invalid();
    const start = at + 2; const end = at + length;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (marker !== 0xc0 && marker !== 0xc2) throw new JpegPreparationError('unsupported', 'This JPEG encoding is not supported.');
      if (frame || end - start < 6) invalid();
      const precision = bytes[start]!; const height = bytes.readUInt16BE(start + 1); const width = bytes.readUInt16BE(start + 3); const components = bytes[start + 5]!;
      if (!width || !height || length !== 8 + 3 * components) invalid();
      if (precision !== 8 || (components !== 1 && components !== 3)) throw new JpegPreparationError('unsupported', 'Use a standard 8-bit greyscale or RGB JPEG.');
      if (width > JPEG_PREPARATION_LIMITS.inputDimension || height > JPEG_PREPARATION_LIMITS.inputDimension || width * height > JPEG_PREPARATION_LIMITS.inputPixels) throw new JpegPreparationError('pixel_limit', 'The JPEG dimensions exceed the preparation limit.');
      frame = { width, height, components };
    }
    if (marker === 0xe1) checkExif(bytes, start, end);
    at = end;
    if (marker === 0xda) {
      if (!frame || ++scans > 128 || end - start < 4) invalid();
      const components = bytes[start]!;
      if (components < 1 || components > frame.components || length !== 6 + 2 * components) invalid();
      at = nextScanMarker(bytes, at);
    }
  }
  return invalid();
}
function asset(bytes: Buffer, dimensions: { width: number; height: number }, recipe: JpegTransformRecipe | null): PreparedJpeg {
  const owned = Buffer.from(bytes);
  const metadata = { mimeType: 'image/jpeg' as const, sha256: digest(owned), ...dimensions, recipe };
  Object.defineProperty(metadata, 'bytes', { enumerable: false, get: () => Buffer.from(owned) });
  return Object.freeze(metadata) as PreparedJpeg;
}
function cropFor(width: number, height: number, output: { width: number; height: number }, focal: JpegFocalPoint): JpegCrop {
  const ratio = output.width / output.height;
  const cropWidth = Math.min(width, height * ratio); const cropHeight = cropWidth / ratio;
  return Object.freeze({ x: Math.max(0, Math.min(width - cropWidth, focal.x * width - cropWidth / 2)), y: Math.max(0, Math.min(height - cropHeight, focal.y * height - cropHeight / 2)), width: cropWidth, height: cropHeight });
}
function resample(data: Uint8Array, sourceWidth: number, sourceHeight: number, crop: JpegCrop, target: { width: number; height: number }): Buffer {
  const output = Buffer.allocUnsafe(target.width * target.height * 4);
  const scale = crop.width / target.width; // one scale preserves aspect ratio in both axes
  for (let y = 0; y < target.height; y++) {
    const sy = Math.max(0, Math.min(sourceHeight - 1, crop.y + (y + 0.5) * scale - 0.5));
    const y0 = Math.floor(sy); const y1 = Math.min(sourceHeight - 1, y0 + 1); const fy = sy - y0;
    for (let x = 0; x < target.width; x++) {
      const sx = Math.max(0, Math.min(sourceWidth - 1, crop.x + (x + 0.5) * scale - 0.5));
      const x0 = Math.floor(sx); const x1 = Math.min(sourceWidth - 1, x0 + 1); const fx = sx - x0;
      const a = (y0 * sourceWidth + x0) * 4; const b = (y0 * sourceWidth + x1) * 4;
      const c = (y1 * sourceWidth + x0) * 4; const d = (y1 * sourceWidth + x1) * 4; const index = (y * target.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) output[index + channel] = Math.round((data[a + channel]! * (1 - fx) + data[b + channel]! * fx) * (1 - fy) + (data[c + channel]! * (1 - fx) + data[d + channel]! * fx) * fy);
      output[index + 3] = 255;
    }
  }
  return output;
}

/** Synchronous sequential decoding/transforms; no internal parallel work or fake storage URLs. */
export function prepareJpegVariants(input: Uint8Array, request: { profiles?: readonly JpegVariantProfile[]; focal?: JpegFocalPoint } = {}): { readonly original: PreparedJpeg; readonly variants: readonly PreparedJpeg[] } {
  if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > JPEG_PREPARATION_LIMITS.inputBytes) throw new JpegPreparationError('invalid_input', 'Supply JPEG bytes within the 8 MiB input limit.');
  const profiles: readonly JpegVariantProfile[] = request.profiles ?? ['blog', 'instagram', 'linkedin'];
  if (!profiles.length || profiles.length > JPEG_PREPARATION_LIMITS.variants || new Set(profiles).size !== profiles.length || profiles.some((id) => !Object.hasOwn(JPEG_VARIANT_PROFILES, id))) throw new JpegPreparationError('recipe', 'Choose up to three distinct supported image formats.');
  const proposed = request.focal ?? { x: 0.5, y: 0.5 };
  if (![proposed.x, proposed.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) throw new JpegPreparationError('recipe', 'The focal point must be between 0 and 1 in both directions.');
  const focal = Object.freeze({ x: proposed.x, y: proposed.y });
  const source = Buffer.from(input); const dimensions = inspectHeader(source);
  let decoded: jpeg.RawImageData<Uint8Array>;
  try { decoded = jpeg.decode(source, { useTArray: true, formatAsRGBA: true, tolerantDecoding: false, maxResolutionInMP: JPEG_PREPARATION_LIMITS.inputPixels / 1_000_000, maxMemoryUsageInMB: JPEG_PREPARATION_LIMITS.decoderMemoryMiB }); }
  catch { throw new JpegPreparationError('malformed', 'The JPEG could not be decoded safely within the preparation limits.'); }
  if (decoded.width !== dimensions.width || decoded.height !== dimensions.height || decoded.data.length !== dimensions.width * dimensions.height * 4) invalid();
  const original = asset(source, dimensions, null); const variants: PreparedJpeg[] = [];
  for (const profile of profiles) {
    const target = JPEG_VARIANT_PROFILES[profile];
    if (target.width * target.height > JPEG_PREPARATION_LIMITS.outputPixels) throw new JpegPreparationError('output_limit', 'The requested image format exceeds its pixel limit.');
    const crop = cropFor(dimensions.width, dimensions.height, target, focal);
    const pixels = resample(decoded.data, dimensions.width, dimensions.height, crop, target);
    let prepared: PreparedJpeg | null = null;
    for (const quality of [85, 70, 55]) {
      const encoded = jpeg.encode({ data: pixels, ...target }, quality).data;
      if (encoded.length > JPEG_PREPARATION_LIMITS.outputBytes) continue;
      const recipe: JpegTransformRecipe = Object.freeze({ version: 'r72-jpeg-focal-v1', sourceSha256: original.sha256, profile, focal, crop, ...target, quality, metadataStripped: true });
      prepared = asset(encoded, target, recipe); break;
    }
    if (!prepared) throw new JpegPreparationError('output_limit', 'An image variant could not fit the byte limit at the supported quality levels.');
    variants.push(prepared);
  }
  return Object.freeze({ original, variants: Object.freeze(variants) });
}
