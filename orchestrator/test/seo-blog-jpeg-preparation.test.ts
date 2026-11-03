import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import { JPEG_PREPARATION_LIMITS, JPEG_VARIANT_PROFILES, JpegPreparationError, prepareJpegVariants } from '../src/seo-blog/jpeg-preparation.js';

function fixture(): Buffer {
  const width = 600, height = 300, data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4;
    data[index] = x < 200 ? 240 : 20; data[index + 1] = x >= 200 && x < 400 ? 240 : 20; data[index + 2] = x >= 400 ? 240 : 20; data[index + 3] = 255;
  }
  return jpeg.encode({ data, width, height }, 90).data;
}
const sample = fixture();
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const isError = (code: JpegPreparationError['code']) => (error: unknown) => error instanceof JpegPreparationError && error.code === code;
function segment(marker: number, payload: Buffer): Buffer {
  const data = Buffer.alloc(payload.length + 4); data.writeUInt16BE(0xff00 | marker); data.writeUInt16BE(payload.length + 2, 2); payload.copy(data, 4); return data;
}
function exif(orientation: number, little = true): Buffer {
  const payload = Buffer.alloc(32); payload.write('Exif\0\0', 0, 'ascii'); payload.write(little ? 'II' : 'MM', 6, 'ascii');
  const u16 = (value: number, at: number) => little ? payload.writeUInt16LE(value, at) : payload.writeUInt16BE(value, at);
  const u32 = (value: number, at: number) => little ? payload.writeUInt32LE(value, at) : payload.writeUInt32BE(value, at);
  u16(42, 8); u32(8, 10); u16(1, 14); u16(0x0112, 16); u16(3, 18); u32(1, 20); u16(orientation, 24); return segment(0xe1, payload);
}
function withSegments(...segments: Buffer[]): Buffer { return Buffer.concat([sample.subarray(0, 2), ...segments, sample.subarray(2)]); }

test('real JPEG produces three exact-size content-addressed variants deterministically and preserves owned original bytes', () => {
  const input = Buffer.from(sample); const first = prepareJpegVariants(input); const second = prepareJpegVariants(input);
  assert.equal(first.original.sha256, sha(sample)); assert.equal(first.original.width, 600); assert.equal(first.original.height, 300);
  assert.deepEqual(first.original.bytes, sample); input.fill(0); assert.deepEqual(first.original.bytes, sample);
  const exposed = first.original.bytes; exposed.fill(0); assert.deepEqual(first.original.bytes, sample, 'a returned buffer cannot mutate an immutable original');
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(first.original)), 'bytes'), false, 'ordinary metadata logs must not serialize original bytes or EXIF');
  assert.equal(first.variants.length, 3);
  assert.deepEqual(first.variants.map((v) => v.sha256), second.variants.map((v) => v.sha256));
  assert.equal(first.original.sha256, '14b7bac953270f9fff696ac3651c9b2177481f0455fb22ddabcdf0f118454d27');
  assert.deepEqual(first.variants.map((v) => v.sha256), [
    '1847de36a44ba4fc01f725c58107fdc3b47ae74d6e9af0dd792327388d68d1a6',
    '8a68a34f30460357ea2677449a4391fc41b8c7482177ee47a79b44ec14e1380b',
    '6166c7285aabfc332b3f9869a78a4f8634b959ec7848e0f6ea91504f026ad7e8',
  ], 'the pinned codec/recipe must preserve exact approved bytes across retries');
  for (const variant of first.variants) {
    assert.ok(variant.recipe); const expected = JPEG_VARIANT_PROFILES[variant.recipe.profile];
    const decoded = jpeg.decode(variant.bytes, { useTArray: true });
    assert.equal(decoded.width, expected.width); assert.equal(decoded.height, expected.height);
    assert.equal(variant.sha256, sha(variant.bytes)); assert.equal(variant.recipe.sourceSha256, first.original.sha256);
    assert.equal(variant.recipe.version, 'r72-jpeg-focal-v1'); assert.equal(variant.recipe.metadataStripped, true);
    assert.ok(variant.bytes.length <= JPEG_PREPARATION_LIMITS.outputBytes);
    assert.ok(Math.abs(variant.recipe.crop.width / variant.recipe.crop.height - expected.width / expected.height) < 1e-10);
    assert.ok(Object.isFrozen(variant)); assert.ok(Object.isFrozen(variant.recipe)); assert.ok(Object.isFrozen(variant.recipe.focal));
    const oldSha = variant.sha256; variant.bytes.fill(0); assert.equal(sha(variant.bytes), oldSha);
  }
});

test('focal extremes preserve the actual red/blue subject rather than stretching or always centre-cropping', () => {
  const left = prepareJpegVariants(sample, { profiles: ['instagram'], focal: { x: 0, y: 0 } }).variants[0]!;
  const right = prepareJpegVariants(sample, { profiles: ['instagram'], focal: { x: 1, y: 1 } }).variants[0]!;
  const colour = (bytes: Buffer) => { const image = jpeg.decode(bytes, { useTArray: true }); const index = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4; return Array.from(image.data.subarray(index, index + 3)); };
  const red = colour(left.bytes), blue = colour(right.bytes);
  assert.ok(red[0]! > red[2]! + 100); assert.ok(blue[2]! > blue[0]! + 100);
  assert.equal(left.recipe!.crop.x, 0); assert.ok(right.recipe!.crop.x + right.recipe!.crop.width <= 600);
  assert.notEqual(left.sha256, right.sha256);
});

test('identity EXIF and private comments are preserved in original and stripped from decoded derivatives', () => {
  const note = Buffer.from('private-location-and-camera-note'); const input = withSegments(exif(1), segment(0xfe, note));
  const result = prepareJpegVariants(input, { profiles: ['linkedin'] });
  assert.deepEqual(result.original.bytes, input); assert.ok(result.original.bytes.includes(note));
  const output = result.variants[0]!.bytes; const decoded = jpeg.decode(output, { useTArray: true });
  assert.equal(output.includes(note), false); assert.equal(output.includes(Buffer.from('Exif\0\0')), false);
  assert.deepEqual(decoded.comments ?? [], []);
});

test('non-identity EXIF is rejected in either byte order and even after scan data, before any decoder allocation', (t) => {
  let calls = 0; t.mock.method(jpeg, 'decode', () => { calls++; throw new Error('decoder must not be called'); });
  for (const little of [true, false]) assert.throws(() => prepareJpegVariants(withSegments(exif(6, little))), isError('orientation'));
  const late = Buffer.concat([sample.subarray(0, -2), exif(8), sample.subarray(-2)]);
  assert.throws(() => prepareJpegVariants(late), isError('orientation')); assert.equal(calls, 0);
});

test('oversized JPEG headers and byte input are rejected before the codec is invoked', (t) => {
  let calls = 0; t.mock.method(jpeg, 'decode', () => { calls++; throw new Error('decoder must not be called'); });
  const frame = sample.indexOf(Buffer.from([0xff, 0xc0])); assert.ok(frame > 0);
  const wide = Buffer.from(sample); wide.writeUInt16BE(8193, frame + 7);
  assert.throws(() => prepareJpegVariants(wide), isError('pixel_limit'));
  const many = Buffer.from(sample); many.writeUInt16BE(4000, frame + 5); many.writeUInt16BE(4000, frame + 7);
  assert.throws(() => prepareJpegVariants(many), isError('pixel_limit'));
  assert.throws(() => prepareJpegVariants(Buffer.alloc(JPEG_PREPARATION_LIMITS.inputBytes + 1)), isError('invalid_input'));
  assert.equal(calls, 0);
});

test('malformed, truncated, non-JPEG, invalid EXIF and unsupported recipes fail safely', () => {
  assert.throws(() => prepareJpegVariants(Buffer.from('not a jpeg')), isError('unsupported'));
  assert.throws(() => prepareJpegVariants(sample.subarray(0, -2)), isError('malformed'));
  assert.throws(() => prepareJpegVariants(Buffer.concat([sample, Buffer.from([0])])), isError('malformed'));
  assert.throws(() => prepareJpegVariants(withSegments(segment(0xe1, Buffer.from('Exif\0')))), isError('malformed'));
  const invalidOffset = exif(1); invalidOffset.writeUInt32LE(0xffffffff, 14);
  assert.throws(() => prepareJpegVariants(withSegments(invalidOffset)), isError('malformed'));
  assert.throws(() => prepareJpegVariants(sample, { profiles: ['instagram', 'instagram'] }), isError('recipe'));
  assert.throws(() => prepareJpegVariants(sample, { profiles: [] }), isError('recipe'));
  for (const focal of [{ x: NaN, y: 0 }, { x: -1, y: 0 }, { x: 0, y: Infinity }, { x: 0, y: 1.01 }]) assert.throws(() => prepareJpegVariants(sample, { focal }), isError('recipe'));
});

test('one bounded decode is reused sequentially, uses strict resource options and limits encoding retries', (t) => {
  const realDecode = jpeg.decode; const realEncode = jpeg.encode; let decodes = 0; const encoded: { width: number; height: number }[] = [];
  t.mock.method(jpeg, 'decode', (bytes: Buffer, options: Parameters<typeof realDecode>[1]) => {
    decodes++; assert.equal(options!.tolerantDecoding, false); assert.equal(options!.maxResolutionInMP, 8); assert.equal(options!.maxMemoryUsageInMB, 128);
    return realDecode(bytes, options);
  });
  t.mock.method(jpeg, 'encode', (data: Parameters<typeof realEncode>[0], quality: number) => { encoded.push({ width: data.width, height: data.height }); return realEncode(data, quality); });
  const result = prepareJpegVariants(sample); assert.equal(decodes, 1); assert.equal(result.variants.length, 3);
  assert.deepEqual(encoded, Object.values(JPEG_VARIANT_PROFILES));
  t.mock.restoreAll();
  let attempts = 0;
  t.mock.method(jpeg, 'encode', () => { attempts++; return { width: 1600, height: 900, data: Buffer.alloc(JPEG_PREPARATION_LIMITS.outputBytes + 1) }; });
  assert.throws(() => prepareJpegVariants(sample, { profiles: ['blog'] }), isError('output_limit')); assert.equal(attempts, 3);
});
