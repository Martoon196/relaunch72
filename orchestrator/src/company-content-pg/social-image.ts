import { createHash } from 'node:crypto';
import { CompanyContentValidationError } from './types.js';

/** Browser-finished JPEG, kept inside the exact approved post, not a mutable URL. */
export interface CompanyContentSocialImage {
  readonly mimeType: 'image/jpeg';
  readonly base64: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
}

export const SOCIAL_IMAGE_MAX_BYTES = 600_000;
function invalid(): never {
  throw new CompanyContentValidationError('Choose a valid image, then save the post again.');
}

function jpegDimensions(bytes: Buffer): readonly [number, number] {
  if (bytes.length < 20 || bytes.readUInt16BE(0) !== 0xffd8
      || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) invalid();
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) invalid();
    if (marker === 0xc0 || marker === 0xc2) {
      if (length < 8 || bytes[offset + 2] !== 8) invalid();
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width < 200 || height < 200 || width > 2048 || height > 2048) invalid();
      return [width, height];
    }
    offset += length;
  }
  return invalid();
}

export function socialImageFromDataUrl(dataUrl: string, alt: string): CompanyContentSocialImage {
  const prefix = 'data:image/jpeg;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)
      || dataUrl.length > prefix.length + 800_000) invalid();
  const base64 = dataUrl.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) invalid();
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > SOCIAL_IMAGE_MAX_BYTES || bytes.toString('base64') !== base64) invalid();
  if (typeof alt !== 'string' || !alt.trim() || alt.length > 500
      || /[\u0000-\u001f\u007f]/u.test(alt)) invalid();
  const [width, height] = jpegDimensions(bytes);
  return Object.freeze({ mimeType: 'image/jpeg', base64,
    sha256: createHash('sha256').update(bytes).digest('hex'), width, height, alt: alt.trim() });
}

export function parseCompanyContentSocialImage(value: unknown): CompanyContentSocialImage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const image = value as Record<string, unknown>;
  const keys = ['mimeType', 'base64', 'sha256', 'width', 'height', 'alt'];
  if (Object.keys(image).length !== keys.length || keys.some((key) => !(key in image))
      || image.mimeType !== 'image/jpeg' || typeof image.base64 !== 'string'
      || typeof image.alt !== 'string') invalid();
  const verified = socialImageFromDataUrl(`data:image/jpeg;base64,${image.base64}`, image.alt);
  if (verified.sha256 !== image.sha256 || verified.width !== image.width
      || verified.height !== image.height || verified.alt !== image.alt) invalid();
  return verified;
}
