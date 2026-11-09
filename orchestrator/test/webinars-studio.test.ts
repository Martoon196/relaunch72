/**
 * Browser-studio relay: WebSocket codec and ticket rules (always), plus a real
 * ffmpeg end-to-end relay into a local RTMP receiver standing in for Cloudflare
 * (skipped when ffmpeg with libx264/libopus is not installed). No provider is called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STUDIO_WS_ROUTE, StudioRelay, acceptedStudioMime, ffmpegArgs, redactIngest } from '../src/webinars/studio.js';
import { encodeFrame } from '../src/webinars/websocket.js';

const ffmpegReady = (() => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  return r.status === 0 && /libx264/.test(r.stdout) && /libopus/.test(r.stdout);
})();

// ── a tiny masked WebSocket client (exercises the server codec exactly as a browser frames data) ──
class RawClient {
  readonly messages: { type: string; state?: string; message?: string }[] = [];
  closed: number | null = null;
  status = 0;
  private buf = Buffer.alloc(0);
  private constructor(private readonly socket: Socket) {}

  static open(port: number, query: string, origin: string | null): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      const client = new RawClient(socket);
      let head = '';
      let upgraded = false;
      socket.on('data', (d: Buffer) => {
        if (!upgraded) {
          head += d.toString('latin1');
          const end = head.indexOf('\r\n\r\n');
          if (end < 0) return;
          client.status = Number(head.slice(9, 12));
          upgraded = true;
          if (client.status !== 101) { resolve(client); socket.destroy(); return; }
          client.feed(Buffer.from(head.slice(end + 4), 'latin1'));
          resolve(client);
          return;
        }
        client.feed(d);
      });
      socket.on('error', reject);
      socket.on('close', () => { if (client.closed === null) client.closed = 1006; });
      socket.write(`GET ${STUDIO_WS_ROUTE}${query} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${origin ? `Origin: ${origin}\r\n` : ''}\r\n`);
    });
  }

  private feed(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 2) {
      let len = this.buf[1]! & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      if (this.buf.length < off + len) return;
      const op = this.buf[0]! & 0x0f;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (op === 0x1) this.messages.push(JSON.parse(payload.toString('utf8')));
      if (op === 0x8) this.closed = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
    }
  }

  send(data: Buffer | string, fragment = false): void {
    const text = typeof data === 'string';
    const body = text ? Buffer.from(data) : data;
    if (!fragment || body.length < 4) { this.socket.write(encodeFrame(text ? 0x1 : 0x2, body, randomBytes(4))); return; }
    // Split into a non-final first frame and a final continuation frame.
    const a = encodeFrame(text ? 0x1 : 0x2, body.subarray(0, body.length >> 1), randomBytes(4));
    a[0] = a[0]! & 0x7f;
    this.socket.write(a);
    this.socket.write(encodeFrame(0x0, body.subarray(body.length >> 1), randomBytes(4)));
  }

  async until(pred: () => boolean, ms = 20_000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error(`timed out; messages: ${JSON.stringify(this.messages)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  raw(b: Buffer): void { this.socket.write(b); }

  end(): void { this.socket.destroy(); }
}

async function relayServer(relay: StudioRelay): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => { if (!relay.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as { port: number }).port };
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  });
}

const ticketInput = (port: number, key = 'synthetickey0123') => ({ workspaceId: 'w', eventId: 'e', userId: 'u', ingestUrl: `rtmp://127.0.0.1:${port}/live/`, streamKey: key });

test('studio accepts only H.264 recordings and never puts the ingest address or key in messages', () => {
  for (const ok of ['video/webm;codecs=h264,opus', 'video/webm; codecs="avc1.42E01F,opus"', 'video/x-matroska;codecs=avc1,opus', 'video/mp4;codecs=avc1,mp4a.40.2']) assert.equal(acceptedStudioMime(ok), true, ok);
  for (const bad of ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'text/html', null, 'video/webm;codecs=h264,opus;x=' + 'a'.repeat(200)]) assert.equal(acceptedStudioMime(bad), false, String(bad));
  const key = 'abcdEFGH1234secret';
  const target = `rtmps://live.cloudflare.com:443/live/${key}`;
  const text = `[flv @ 0x1] Failed to connect to ${target}: Connection refused (key ${key})`;
  const red = redactIngest(text, [key, target]);
  assert.doesNotMatch(red, new RegExp(key));
  assert.doesNotMatch(red, /live\.cloudflare\.com\/live\//);
  const args = ffmpegArgs(target);
  assert.equal(args.at(-1), target, 'target is a single argv entry (no shell)');
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 2), ['-c:v', 'copy'], 'video is never transcoded');
});

test('studio tickets: unavailable without ffmpeg, Cloudflare RTMPS only, single use, same-origin only', async () => {
  const missing = new StudioRelay({ ffmpegPath: '/nonexistent/ffmpeg', maxSessions: 1, maxMinutes: 10 });
  assert.equal((await missing.probe()).available, false);
  assert.throws(() => missing.issueTicket({ workspaceId: 'w', eventId: 'e', userId: 'u', ingestUrl: 'rtmps://live.cloudflare.com:443/live/', streamKey: 'k'.repeat(32) }), /not available on this server/);
  if (!ffmpegReady) return;
  const relay = new StudioRelay({ ffmpegPath: 'ffmpeg', maxSessions: 1, maxMinutes: 10 }, { log: () => undefined });
  assert.equal((await relay.probe()).available, true);
  assert.throws(() => relay.issueTicket({ ...ticketInput(1935) }), /not a Cloudflare RTMPS ingest/, 'local ingest refused outside tests');
  assert.throws(() => relay.issueTicket({ ...ticketInput(1935), ingestUrl: 'rtmps://evil.example/live/' }), /not a Cloudflare RTMPS ingest/);
  const { ticket } = relay.issueTicket({ workspaceId: 'w', eventId: 'e', userId: 'u', ingestUrl: 'rtmps://live.cloudflare.com:443/live/', streamKey: 'k'.repeat(32) });
  const { server, port } = await relayServer(relay);
  try {
    assert.equal((await RawClient.open(port, `?ticket=${ticket}`, null)).status, 403, 'no Origin');
    assert.equal((await RawClient.open(port, `?ticket=${ticket}`, 'https://evil.example')).status, 403, 'cross-site Origin');
    assert.equal((await RawClient.open(port, `?ticket=${'A'.repeat(43)}`, `http://127.0.0.1:${port}`)).status, 401, 'unknown ticket');
    const ok = await RawClient.open(port, `?ticket=${ticket}`, `http://127.0.0.1:${port}`);
    assert.equal(ok.status, 101);
    ok.send(JSON.stringify({ type: 'start', mimeType: 'video/webm;codecs=vp8,opus' }));
    await ok.until(() => ok.closed !== null);
    assert.match(ok.messages.at(-1)?.message ?? '', /does not record H\.264/);
    assert.equal((await RawClient.open(port, `?ticket=${ticket}`, `http://127.0.0.1:${port}`)).status, 401, 'a ticket works once');
  } finally {
    relay.stopAll();
    server.closeAllConnections();
    server.close();
  }
});

test('studio relay remuxes browser H.264/Opus into RTMP with AAC, end to end through real ffmpeg', { skip: ffmpegReady ? false : 'ffmpeg with libx264/libopus not installed', timeout: 90_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'r72-studio-'));
  const source = path.join(dir, 'source.mkv');
  const received = path.join(dir, 'received.flv');
  // What Chrome's MediaRecorder produces: WebM with H.264 video and Opus audio.
  const gen = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-f', 'matroska', source]);
  assert.equal(gen.status, 0, gen.stderr?.toString());
  const rtmpPort = await freePort();
  const key = 'synthetickey0123';
  // Local RTMP receiver standing in for Cloudflare's ingest.
  const receiver = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', `rtmp://127.0.0.1:${rtmpPort}/live/${key}`, '-c', 'copy', '-f', 'flv', received]);
  const receiverDone = new Promise<number | null>((r) => receiver.on('close', r));
  await new Promise((r) => setTimeout(r, 700));
  const logs: string[] = [];
  const relay = new StudioRelay({ ffmpegPath: 'ffmpeg', maxSessions: 1, maxMinutes: 10, allowLocalIngest: true }, { log: (l) => logs.push(l) });
  assert.equal((await relay.probe()).available, true);
  const { server, port } = await relayServer(relay);
  try {
    const { ticket } = relay.issueTicket(ticketInput(rtmpPort, key));
    const client = await RawClient.open(port, `?ticket=${ticket}`, `http://127.0.0.1:${port}`);
    assert.equal(client.status, 101);
    client.send(JSON.stringify({ type: 'start', mimeType: 'video/webm;codecs=h264,opus' }), true);
    const bytes = readFileSync(source);
    for (let i = 0; i < bytes.length; i += 48 * 1024) {
      client.send(bytes.subarray(i, i + 48 * 1024), i % (96 * 1024) === 0);
      await new Promise((r) => setTimeout(r, 5));
    }
    await client.until(() => client.messages.some((m) => m.state === 'sending'));
    assert.equal(relay.sessionFor('e')?.state, 'sending');
    client.send(JSON.stringify({ type: 'stop' }));
    await client.until(() => client.closed !== null, 30_000);
    assert.equal(client.closed, 1000, JSON.stringify(client.messages));
    assert.match(client.messages.at(-1)?.message ?? '', /Stopped/);
    assert.equal(await Promise.race([receiverDone, new Promise((r) => setTimeout(() => r('timeout'), 20_000))]), 0);
    assert.ok(existsSync(received));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', received], { encoding: 'utf8' });
    const info = JSON.parse(probe.stdout) as { streams: { codec_name: string }[]; format: { duration: string } };
    assert.deepEqual(info.streams.map((s) => s.codec_name).sort(), ['aac', 'h264'], 'video copied as H.264, audio converted to AAC');
    assert.ok(Number(info.format.duration) > 4.5, `duration ${info.format.duration}`);
    assert.ok(client.messages.every((m) => !JSON.stringify(m).includes(key)), 'the stream key never reaches the browser');
    assert.ok(logs.every((l) => !l.includes(key)));
    assert.equal(relay.sessionFor('e'), null);
  } finally {
    relay.stopAll();
    receiver.kill('SIGKILL');
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('studio channel refuses unmasked and oversized frames', { skip: ffmpegReady ? false : 'ffmpeg not installed' }, async () => {
  const relay = new StudioRelay({ ffmpegPath: 'ffmpeg', maxSessions: 2, maxMinutes: 10, allowLocalIngest: true }, { log: () => undefined });
  await relay.probe();
  const { server, port } = await relayServer(relay);
  try {
    const a = await RawClient.open(port, `?ticket=${relay.issueTicket({ ...ticketInput(1935), eventId: 'a' }).ticket}`, `http://127.0.0.1:${port}`);
    a.raw(encodeFrame(0x1, Buffer.from('{"type":"start"}')));
    await a.until(() => a.closed !== null);
    assert.equal(a.closed, 1002, 'unmasked client frame');
    const b = await RawClient.open(port, `?ticket=${relay.issueTicket({ ...ticketInput(1935), eventId: 'b' }).ticket}`, `http://127.0.0.1:${port}`);
    const head = Buffer.alloc(14);
    head[0] = 0x82; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(64 * 1024 * 1024), 2);
    b.raw(head);
    await b.until(() => b.closed !== null);
    assert.equal(b.closed, 1009, 'frame above the limit');
    assert.equal(relay.sessionFor('a'), null);
    assert.equal(relay.sessionFor('b'), null);
  } finally {
    relay.stopAll();
    server.closeAllConnections();
    server.close();
  }
});

test('studio probe uses the ffmpeg on PATH and names each missing capability', { skip: ffmpegReady ? false : 'ffmpeg not installed' }, async () => {
  const { probeFfmpeg, resolveOnPath } = await import('../src/webinars/studio.js');
  const real = resolveOnPath('ffmpeg')!;
  const ok = await probeFfmpeg('ffmpeg');
  assert.equal(ok.available, true, ok.detail);
  assert.equal(ok.path, real, 'resolved from PATH');
  assert.match(ok.detail, /^ffmpeg \S+ at \//);
  assert.ok(ok.checks.find((c) => c.id === 'smoke-chrome')?.ok);
  // Wrapper executables that hide one capability each from the real ffmpeg.
  const { writeFileSync, chmodSync } = await import('node:fs');
  const wrapper = (name: string, body: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), `r72-ff-${name}-`));
    writeFileSync(path.join(dir, 'ffmpeg'), `#!/bin/sh\n${body}\nexec ${real} "$@"\n`);
    chmodSync(path.join(dir, 'ffmpeg'), 0o755);
    return dir;
  };
  const noRtmps = await probeFfmpeg('ffmpeg', undefined, wrapper('nortmps', `if [ "$2" = "-protocols" ]; then ${real} "$@" | grep -v rtmps; exit 0; fi`));
  assert.equal(noRtmps.available, false);
  assert.match(noRtmps.detail, /failed: Sends to Cloudflare over RTMPS \(protocol "rtmps"/);
  const noSafari = await probeFfmpeg('ffmpeg', undefined, wrapper('nomp4', `if [ "$2" = "-demuxers" ]; then ${real} "$@" | grep -v "mov,mp4"; exit 0; fi`));
  assert.deepEqual([noSafari.available, noSafari.safari], [true, false], 'Chrome/Edge still work; Safari reported unsupported');
  const brokenPipeline = await probeFfmpeg('ffmpeg', undefined, wrapper('broken', 'case "$*" in *pipe:1*) echo "simulated failure" >&2; exit 1;; esac'));
  assert.equal(brokenPipeline.available, false, 'finding the executable is not enough');
  assert.match(brokenPipeline.detail, /failed: Smoke test: Chrome\/Edge-shaped clip through the relay pipeline \(remux failed: simulated failure\)/);
  assert.equal(brokenPipeline.checks.find((c) => c.id === 'smoke-chrome')?.ok, false);
  const absent = await probeFfmpeg('ffmpeg', undefined, mkdtempSync(path.join(tmpdir(), 'r72-ff-empty-')));
  assert.deepEqual([absent.available, absent.detail], [false, 'ffmpeg was not found on PATH.']);
  assert.equal((await probeFfmpeg('/nonexistent/ffmpeg')).detail, 'ffmpeg was not found at /nonexistent/ffmpeg.');
});
