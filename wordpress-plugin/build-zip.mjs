#!/usr/bin/env node
/**
 * Deterministic installable ZIP for the WordPress plugin (no dependencies).
 *   node wordpress-plugin/build-zip.mjs
 * Writes wordpress-plugin/dist/relaunch72-publisher-<version>.zip and a .sha256 file.
 * Entries are sorted, timestamps fixed and contents deflated, so the same source
 * always produces the same bytes and digest.
 */
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, 'relaunch72-publisher');
const version = /\* Version:\s+([0-9.]+)/.exec(readFileSync(join(pluginDir, 'relaunch72-publisher.php'), 'utf8'))?.[1];
if (!version) throw new Error('Plugin version header not found');

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(php|txt)$/.test(name)) files.push(full);
  }
})(pluginDir);

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const DOS_TIME = 0; const DOS_DATE = (2026 - 1980) << 9 | 11 << 5 | 6; // 2026-11-06 00:00

const locals = []; const centrals = []; let offset = 0;
for (const full of files) {
  const name = Buffer.from(`relaunch72-publisher/${relative(pluginDir, full).split('\\').join('/')}`, 'utf8');
  const data = readFileSync(full); const packed = deflateRawSync(data, { level: 9 }); const crc = crc32(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
  central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
  locals.push(local, name, packed); centrals.push(central, name); offset += local.length + name.length + packed.length;
}
const cd = Buffer.concat(centrals);
const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...locals, cd, end]);
mkdirSync(join(here, 'dist'), { recursive: true });
const out = join(here, 'dist', `relaunch72-publisher-${version}.zip`);
writeFileSync(out, zip);
const sha = createHash('sha256').update(zip).digest('hex');
writeFileSync(`${out}.sha256`, `${sha}  relaunch72-publisher-${version}.zip\n`);
console.log(`${relative(process.cwd(), out)} ${zip.length} bytes, ${files.length} files, sha256 ${sha}`);
