/**
 * Brand knowledge uploads: validation and readable-text extraction.
 *
 * Supported: PDF (text layer only — no OCR in this release), DOCX, TXT,
 * Markdown, pasted text, and PNG/JPEG/WebP visual references (stored as
 * references; never "read"). Every result says exactly what was ingested.
 * Extracted text is brand context, never instructions.
 */

import { createHash } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { decodeEntities } from './html.js';
import type { ExtractionStatus, KnowledgeFormat } from './types.js';

export interface UploadLimits {
  readonly documentBytes: number;
  readonly imageBytes: number;
  readonly pastedChars: number;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = Object.freeze({
  documentBytes: Number(process.env.SEO_BLOG_MAX_DOCUMENT_BYTES ?? 20 * 1024 * 1024),
  imageBytes: Number(process.env.SEO_BLOG_MAX_IMAGE_BYTES ?? 10 * 1024 * 1024),
  pastedChars: 200_000,
});

export interface ExtractionResult {
  readonly format: KnowledgeFormat | null;
  readonly mime: string | null;
  readonly status: ExtractionStatus;
  readonly detail: string;
  readonly text: string | null;
  readonly pagesRead: number | null;
  readonly pagesTotal: number | null;
  readonly sha256: string;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

const MIME: Record<KnowledgeFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  markdown: 'text/markdown',
  pasted_text: 'text/plain',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export function detectFormat(filename: string, bytes: Buffer): KnowledgeFormat | null {
  const ext = (/\.([a-z0-9]+)$/i.exec(filename)?.[1] ?? '').toLowerCase();
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) return ext === 'docx' ? 'docx' : null;
  if (ext === 'md' || ext === 'markdown') return looksLikeText(bytes) ? 'markdown' : null;
  if (ext === 'txt' || ext === 'text') return looksLikeText(bytes) ? 'txt' : null;
  return null;
}

function looksLikeText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  const text = bytes.toString('utf8');
  const replacement = (text.match(/�/g) ?? []).length;
  return replacement <= Math.max(2, text.length / 1000);
}

export function cleanText(text: string): string {
  return text
    .normalize('NFC')
    // Control characters (other than newline/tab) are never meaningful brand text.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‍⁠﻿‪-‮⁦-⁩]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractKnowledge(input: {
  readonly filename: string | null;
  readonly bytes: Buffer | null;
  readonly pastedText?: string | null;
  readonly limits?: UploadLimits;
}): ExtractionResult {
  const limits = input.limits ?? DEFAULT_UPLOAD_LIMITS;
  if (input.pastedText !== undefined && input.pastedText !== null) {
    const text = cleanText(input.pastedText);
    const sha256 = sha256Hex(text);
    if (text.length === 0) return reject(sha256, 'The pasted text was empty.');
    if (text.length > limits.pastedChars) return reject(sha256, `Pasted text is limited to ${limits.pastedChars.toLocaleString('en-GB')} characters.`);
    return { format: 'pasted_text', mime: MIME.pasted_text, status: 'extracted', detail: `${wordTotal(text)} words of pasted text.`, text, pagesRead: null, pagesTotal: null, sha256 };
  }
  const bytes = input.bytes ?? Buffer.alloc(0);
  const sha256 = sha256Hex(bytes);
  if (bytes.length === 0) return reject(sha256, 'The file was empty.');
  const format = detectFormat(input.filename ?? '', bytes);
  if (!format) {
    return { format: null, mime: null, status: 'unsupported', detail: 'This file type is not supported. Upload PDF, DOCX, TXT, Markdown, PNG, JPEG or WebP.', text: null, pagesRead: null, pagesTotal: null, sha256 };
  }
  const isImage = format === 'png' || format === 'jpeg' || format === 'webp';
  const max = isImage ? limits.imageBytes : limits.documentBytes;
  if (bytes.length > max) {
    return { ...reject(sha256, `${isImage ? 'Images' : 'Documents'} are limited to ${Math.round(max / 1024 / 1024)} MiB.`), format, mime: MIME[format] };
  }
  if (isImage) {
    return { format, mime: MIME[format], status: 'image_reference', detail: 'Stored as a visual reference. Images are not read as text.', text: null, pagesRead: null, pagesTotal: null, sha256 };
  }
  try {
    if (format === 'txt' || format === 'markdown') {
      const text = cleanText(bytes.toString('utf8'));
      if (!text) return { format, mime: MIME[format], status: 'unreadable', detail: 'The file contains no readable text.', text: null, pagesRead: null, pagesTotal: null, sha256 };
      return { format, mime: MIME[format], status: 'extracted', detail: `${wordTotal(text)} words read.`, text, pagesRead: null, pagesTotal: null, sha256 };
    }
    if (format === 'docx') {
      const text = cleanText(extractDocxText(bytes));
      if (!text) return { format, mime: MIME[format], status: 'unreadable', detail: 'The document contains no readable text.', text: null, pagesRead: null, pagesTotal: null, sha256 };
      return { format, mime: MIME[format], status: 'extracted', detail: `${wordTotal(text)} words read.`, text, pagesRead: null, pagesTotal: null, sha256 };
    }
    const pdf = extractPdfText(bytes);
    const text = cleanText(pdf.pages.join('\n\n'));
    const readPages = pdf.pages.filter((p) => wordTotal(p) >= 5).length;
    if (!text || readPages === 0) {
      return {
        format, mime: MIME[format], status: 'unreadable',
        detail: pdf.pageCount > 0
          ? `No text layer was found on any of the ${pdf.pageCount} pages. It may be scanned or image-only; OCR is not available, so nothing from it was used.`
          : 'No readable text was found. OCR is not available, so nothing from it was used.',
        text: null, pagesRead: 0, pagesTotal: pdf.pageCount || null, sha256,
      };
    }
    const total = Math.max(pdf.pageCount, pdf.pages.length);
    const partial = readPages < total;
    return {
      format, mime: MIME[format], status: partial ? 'partial' : 'extracted',
      detail: partial
        ? `Text was read from ${readPages} of ${total} pages. The other pages had no text layer (OCR is not available) and were not used.`
        : `${wordTotal(text)} words read from ${total} page${total === 1 ? '' : 's'}.`,
      text, pagesRead: readPages, pagesTotal: total, sha256,
    };
  } catch (error) {
    return { format, mime: MIME[format], status: 'unreadable', detail: `The file could not be read (${(error as Error).message}). Nothing from it was used.`, text: null, pagesRead: null, pagesTotal: null, sha256 };
  }
}

function reject(sha256: string, detail: string): ExtractionResult {
  return { format: null, mime: null, status: 'rejected', detail, text: null, pagesRead: null, pagesTotal: null, sha256 };
}

function wordTotal(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ─── ZIP (DOCX) ──────────────────────────────────────────────────────────────

const MAX_INFLATED = 60 * 1024 * 1024;

export function readZipEntry(zip: Buffer, wanted: string): Buffer | null {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a valid ZIP container');
  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt ZIP directory');
    const method = zip.readUInt16LE(offset + 10);
    const compressed = zip.readUInt32LE(offset + 20);
    const uncompressed = zip.readUInt32LE(offset + 24);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted) continue;
    if (uncompressed > MAX_INFLATED) throw new Error('document is too large once decompressed');
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error('corrupt ZIP entry');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_INFLATED });
    throw new Error('unsupported ZIP compression');
  }
  return null;
}

export function extractDocxText(bytes: Buffer): string {
  const xml = readZipEntry(bytes, 'word/document.xml');
  if (!xml) throw new Error('this is not a Word document');
  const body = xml.toString('utf8');
  const paragraphs: string[] = [];
  const pRe = /<w:p\b[\s\S]*?<\/w:p>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pRe.exec(body)) !== null) {
    const p = pm[0];
    const parts: string[] = [];
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(p)) !== null) {
      if (tm[1] !== undefined) parts.push(decodeEntities(tm[1]));
      else parts.push(tm[0].startsWith('<w:tab') ? '\t' : '\n');
    }
    const isListItem = /<w:numPr\b/.test(p);
    const line = parts.join('').trim();
    if (line) paragraphs.push(isListItem ? `- ${line}` : line);
  }
  return paragraphs.join('\n');
}

// ─── PDF (text layer only) ───────────────────────────────────────────────────

function pdfLiteral(src: string, start: number): { value: string; end: number } {
  let depth = 0;
  let out = '';
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') {
      const n = src[i + 1] ?? '';
      const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
      if (map[n] !== undefined) { out += map[n]; i++; continue; }
      if (/[0-7]/.test(n)) {
        const oct = /^[0-7]{1,3}/.exec(src.slice(i + 1, i + 4))![0];
        out += String.fromCharCode(parseInt(oct, 8));
        i += oct.length;
        continue;
      }
      if (n === '\n' || n === '\r') { i++; continue; }
      continue;
    }
    if (c === '(') { depth++; if (depth > 1) out += c; continue; }
    if (c === ')') { depth--; if (depth === 0) return { value: out, end: i }; out += c; continue; }
    if (depth >= 1) out += c;
  }
  return { value: out, end: src.length };
}

function pdfHex(hex: string): string {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const bytes = Buffer.from(clean.length % 2 ? `${clean}0` : clean, 'hex');
  // Two-byte (UTF-16BE / Identity-H) strings are common; prefer them when they decode to text.
  if (bytes.length >= 2 && bytes.length % 2 === 0 && bytes[0] === 0) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 2) s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    return s;
  }
  return bytes.toString('latin1');
}

function contentStreamText(stream: string): string {
  const out: string[] = [];
  let i = 0;
  let line = '';
  const flush = () => { if (line.trim()) out.push(line); line = ''; };
  while (i < stream.length) {
    const c = stream[i]!;
    if (c === '(') {
      const lit = pdfLiteral(stream, i);
      i = lit.end + 1;
      const op = /^\s*(Tj|'|"|\])/.exec(stream.slice(i, i + 4));
      line += lit.value;
      if (op && (op[1] === "'" || op[1] === '"')) flush();
      continue;
    }
    if (c === '<' && stream[i + 1] !== '<') {
      const end = stream.indexOf('>', i);
      if (end < 0) break;
      line += pdfHex(stream.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === 'T' && (stream[i + 1] === '*' || stream[i + 1] === 'd' || stream[i + 1] === 'D')) { flush(); i += 2; continue; }
    if (c === 'E' && stream[i + 1] === 'T') { flush(); i += 2; continue; }
    if (c === '-' || (c >= '0' && c <= '9')) {
      // A large negative kern inside TJ is a word gap.
      const num = /^-?\d+(\.\d+)?/.exec(stream.slice(i, i + 12));
      if (num) { if (Number(num[0]) < -200 && line && !line.endsWith(' ')) line += ' '; i += num[0].length; continue; }
    }
    i++;
  }
  flush();
  return out.join('\n');
}

export function extractPdfText(bytes: Buffer): { pages: string[]; pageCount: number } {
  const raw = bytes.toString('latin1');
  if (/\/Encrypt\s/.test(raw)) throw new Error('the PDF is encrypted');
  const pageCount = (raw.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  const pages: string[] = [];
  const streamRe = /(<<(?:(?!>>)[\s\S]){0,2000}?>>)\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  let budget = 0;
  while ((m = streamRe.exec(raw)) !== null) {
    const dict = m[1] ?? '';
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    streamRe.lastIndex = end;
    if (/\/Subtype\s*\/Image|\/Type\s*\/XObject|\/Type\s*\/(XRef|ObjStm|Metadata)|\/Length1|\/FontFile/.test(dict)) continue;
    let data = bytes.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try { data = inflateSync(data, { maxOutputLength: 20 * 1024 * 1024 }); } catch { continue; }
    } else if (/\/Filter/.test(dict)) {
      continue;
    }
    budget += data.length;
    if (budget > MAX_INFLATED) throw new Error('the PDF is too large to read');
    const text = contentStreamText(data.toString('latin1'));
    const printable = text.replace(/[^\x20-\x7E -ɏ‘-‟–—£€\n]/g, '');
    // Glyph-indexed text without a usable mapping looks like noise; do not pretend it is text.
    if (text.trim() && printable.length >= text.length * 0.85) pages.push(printable);
  }
  return { pages, pageCount };
}
