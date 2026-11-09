/**
 * Minimal RFC 6455 WebSocket server endpoint for the browser studio: one
 * authenticated upload channel per host, so it does not justify a dependency.
 * Supports text/binary messages, fragmentation, ping/pong and close, requires
 * masked client frames, and bounds every frame and message.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WebSocketLimits {
  /** Largest single frame payload accepted (bytes). */
  readonly maxFrame: number;
  /** Largest reassembled message accepted (bytes). */
  readonly maxMessage: number;
}

export interface WebSocketHandlers {
  onMessage(data: Buffer, text: boolean): void;
  onClose(code: number, reason: string): void;
}

/** Validates the upgrade request and returns the Sec-WebSocket-Accept value, or null. */
export function handshakeAccept(req: IncomingMessage): string | null {
  if (req.method !== 'GET') return null;
  if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return null;
  if (!/\bupgrade\b/i.test(String(req.headers.connection ?? ''))) return null;
  if (req.headers['sec-websocket-version'] !== '13') return null;
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return null;
  return createHash('sha1').update(key + GUID).digest('base64');
}

export function encodeFrame(opcode: number, payload: Buffer, mask?: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? 2 : len < 65_536 ? 4 : 10;
  const out = Buffer.alloc(head + (mask ? 4 : 0) + len);
  out[0] = 0x80 | opcode;
  if (len < 126) out[1] = len;
  else if (len < 65_536) { out[1] = 126; out.writeUInt16BE(len, 2); }
  else { out[1] = 127; out.writeBigUInt64BE(BigInt(len), 2); }
  if (mask) {
    out[1]! |= 0x80;
    mask.copy(out, head);
    for (let i = 0; i < len; i++) out[head + 4 + i] = payload[i]! ^ mask[i % 4]!;
  } else {
    payload.copy(out, head);
  }
  return out;
}

export class WebSocketConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentSize = 0;
  private closed = false;

  constructor(private readonly socket: Duplex, private readonly limits: WebSocketLimits, private readonly handlers: WebSocketHandlers) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('close', () => this.finish(1006, 'connection lost'));
    socket.on('error', () => this.finish(1006, 'connection error'));
  }

  /** Completes the 101 handshake on a validated upgrade. */
  static accept(req: IncomingMessage, socket: Duplex, head: Buffer, limits: WebSocketLimits, handlers: WebSocketHandlers): WebSocketConnection | null {
    const accept = handshakeAccept(req);
    if (!accept) return null;
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = new WebSocketConnection(socket, limits, handlers);
    if (head.length) conn.receive(head);
    return conn;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  get bufferedAmount(): number {
    return this.socket.writableLength;
  }

  sendText(text: string): void {
    if (!this.closed) this.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8')));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason.slice(0, 120)));
    body.writeUInt16BE(code, 0);
    body.write(reason.slice(0, 120), 2, 'utf8');
    this.socket.end(encodeFrame(0x8, body));
    this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.handlers.onClose(code, reason);
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  private fail(code: number, reason: string): void {
    this.close(code, reason);
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0]!, b1 = this.buffer[1]!;
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      if (b0 & 0x70) return this.fail(1002, 'reserved bits set');
      if (!masked) return this.fail(1002, 'client frames must be masked');
      let len = b1 & 0x7f, offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2); offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.limits.maxFrame)) return this.fail(1009, 'frame too large');
        len = Number(big); offset = 10;
      }
      if (len > this.limits.maxFrame) return this.fail(1009, 'frame too large');
      if (this.buffer.length < offset + 4 + len) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      this.buffer = this.buffer.subarray(offset + 4 + len);
      if (opcode >= 0x8) {
        if (!fin || len > 125) return this.fail(1002, 'invalid control frame');
        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          const echo = Buffer.alloc(2);
          echo.writeUInt16BE(1000, 0);
          this.socket.end(encodeFrame(0x8, echo));
          this.finish(code, payload.subarray(2).toString('utf8'));
          return;
        }
        if (opcode === 0x9) this.socket.write(encodeFrame(0xA, payload));
        continue; // pong or ping handled
      }
      if (opcode === 0x0) {
        if (!this.fragmentOpcode) return this.fail(1002, 'unexpected continuation');
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (this.fragmentOpcode) return this.fail(1002, 'interleaved message');
        this.fragmentOpcode = opcode;
      } else {
        return this.fail(1002, 'unknown opcode');
      }
      this.fragmentSize += payload.length;
      if (this.fragmentSize > this.limits.maxMessage) return this.fail(1009, 'message too large');
      this.fragments.push(payload);
      if (fin) {
        const data = this.fragments.length === 1 ? this.fragments[0]! : Buffer.concat(this.fragments);
        const text = this.fragmentOpcode === 0x1;
        this.fragments = []; this.fragmentOpcode = 0; this.fragmentSize = 0;
        this.handlers.onMessage(data, text);
        if (this.closed) return;
      }
    }
  }
}
