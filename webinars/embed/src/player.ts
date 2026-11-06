/**
 * <ghq-player> — native <video> with our own chrome. No vendor logo, no "watch on" link.
 *  - Live low-latency: WebRTC (WHEP) first, automatic fallback to HLS.
 *  - HLS: native where supported (Safari/iOS), hls.js lazily loaded elsewhere.
 *  - Evergreen: playhead locked to "now − slot start"; seeking is undone.
 *  - On-demand/replay: free seeking, resumes where the viewer left off.
 * Emits `ghq-time` ({ position, playing }) about once a second.
 */
import { html, css, LitElement, nothing, type PropertyValues } from 'lit';
import { icon } from './icons.js';
import { base } from './styles.js';
import { store } from './api.js';
import type { Playback } from './types.js';

type HlsLike = { loadSource(u: string): void; attachMedia(v: HTMLVideoElement): void; destroy(): void; on(ev: string, cb: (e: unknown, d: { fatal?: boolean }) => void): void };

export class GhqPlayer extends LitElement {
  static properties = {
    playback: { attribute: false },
    fetchedAt: { attribute: false },
    resumeKey: { attribute: false },
    title: {},
    _needsTap: { state: true },
    _mode: { state: true },
    _muted: { state: true },
    _paused: { state: true },
    _captions: { state: true },
    _loading: { state: true },
    _hasCaptions: { state: true },
  };
  declare playback: Playback | null;
  declare fetchedAt: number;
  declare resumeKey: string | null;
  declare title: string;
  declare _needsTap: boolean;
  declare _mode: 'webrtc' | 'hls' | 'idle';
  declare _muted: boolean;
  declare _paused: boolean;
  declare _captions: boolean;
  declare _loading: boolean;
  declare _hasCaptions: boolean;

  private hls: HlsLike | null = null;
  private pc: RTCPeerConnection | null = null;
  private lastEmit = 0;
  private lastSave = 0;
  private currentSrc = '';

  static styles = [base, css`
    .wrap { position: relative; background: #000; border-radius: var(--ghq-radius); overflow: hidden; aspect-ratio: 16 / 9; box-shadow: var(--ghq-shadow); isolation: isolate; }
    .wrap:fullscreen { border-radius: 0; }
    video { width: 100%; height: 100%; display: block; background: #000; }
    .overlay { position: absolute; inset: 0; display: grid; place-items: center; background: radial-gradient(ellipse at center, rgba(0,0,0,.25), rgba(0,0,0,.65)); }
    .overlay button { background: #fff; color: #111; border-color: #fff; padding: 12px 24px 12px 18px; font-size: 1rem; box-shadow: 0 10px 30px -8px rgba(0,0,0,.6); }
    .overlay button svg { width: 22px; height: 22px; }
    .spinner { width: 42px; height: 42px; border-radius: 50%; border: 3px solid rgba(255,255,255,.25); border-top-color: #fff; animation: ghq-spin .9s linear infinite; }
    @keyframes ghq-spin { to { transform: rotate(360deg); } }
    .bar {
      position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 4px; padding: 10px 10px 8px;
      background: linear-gradient(transparent, rgba(0,0,0,.75)); opacity: 0; transition: opacity .25s;
    }
    .wrap:hover .bar, .wrap:focus-within .bar, .bar.show { opacity: 1; }
    .bar button { min-height: 38px; width: 38px; padding: 0; border-radius: 10px; background: rgba(255,255,255,.12); border-color: transparent; color: #fff; backdrop-filter: blur(6px); }
    .bar button:hover { background: rgba(255,255,255,.22); transform: none; box-shadow: none; }
    .bar button[aria-pressed='true'] { background: #fff; color: #111; }
    .bar .state { margin-left: 6px; display: inline-flex; align-items: center; gap: 7px; color: #fff; font-size: .72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .bar .state .dot { background: #e11d48; color: #e11d48; }
    .spacer { flex: 1; }
  `];

  constructor() {
    super();
    this.playback = null;
    this.fetchedAt = Date.now();
    this.resumeKey = null;
    this.title = 'Webinar video';
    this._needsTap = false;
    this._mode = 'idle';
    this._muted = false;
    this._paused = true;
    this._captions = false;
    this._loading = true;
    this._hasCaptions = false;
  }

  get video(): HTMLVideoElement | null {
    return this.renderRoot.querySelector('video');
  }

  /** Where an evergreen viewer should be right now. */
  private expectedPosition(): number | null {
    const p = this.playback;
    if (!p || p.seekable || p.offset_s === null) return null;
    return p.offset_s + (Date.now() - this.fetchedAt) / 1000;
  }

  protected updated(changed: PropertyValues) {
    if (changed.has('playback')) void this.load();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.teardown();
  }

  private teardown() {
    this.hls?.destroy();
    this.hls = null;
    this.pc?.close();
    this.pc = null;
  }

  private async load() {
    const v = this.video;
    const p = this.playback;
    if (!v || !p) return;
    // Token refresh for the same stream: keep the WebRTC connection; swap HLS source in place.
    if (this._mode === 'webrtc' && this.pc && p.low_latency) return;
    const keepAt = this._mode === 'hls' && !v.paused ? v.currentTime : null;
    this.teardown();
    this._loading = true;
    if (p.low_latency && p.webrtc && 'RTCPeerConnection' in window) {
      try {
        await this.whep(p.webrtc, v);
        this._mode = 'webrtc';
        return this.tryPlay();
      } catch (err) {
        console.warn('[ghq-player] low-latency playback unavailable, falling back to HLS', err);
        this.pc?.close();
        this.pc = null;
      }
    }
    await this.loadHls(p.hls, v);
    this._mode = 'hls';
    v.addEventListener('loadedmetadata', () => {
      this._hasCaptions = Array.from(v.textTracks).some((t) => t.kind === 'captions' || t.kind === 'subtitles');
      const exp = this.expectedPosition();
      if (exp !== null) v.currentTime = exp;
      else if (keepAt !== null) v.currentTime = keepAt;
      else if (this.resumeKey && p.seekable) {
        const saved = Number(store.get(this.resumeKey));
        if (saved > 5 && (!v.duration || saved < v.duration - 10)) v.currentTime = saved;
      }
    }, { once: true });
    this.tryPlay();
  }

  private async loadHls(src: string, v: HTMLVideoElement) {
    this.currentSrc = src;
    v.srcObject = null;
    if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = src;
      return;
    }
    const { default: Hls } = (await import('hls.js')) as unknown as { default: { new (cfg?: object): HlsLike; isSupported(): boolean } };
    if (!Hls.isSupported()) {
      v.src = src;
      return;
    }
    const hls = new Hls({ lowLatencyMode: !!this.playback?.low_latency, backBufferLength: 60 });
    hls.on('hlsError', (_e, data) => {
      if (data.fatal) {
        console.warn('[ghq-player] fatal HLS error, retrying');
        setTimeout(() => this.currentSrc === src && this.load(), 3000);
      }
    });
    hls.loadSource(src);
    hls.attachMedia(v);
    this.hls = hls;
  }

  /** WebRTC-HTTP Egress Protocol: POST an SDP offer, get the answer. */
  private async whep(url: string, v: HTMLVideoElement) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], bundlePolicy: 'max-bundle' });
    this.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const stream = new MediaStream();
    pc.ontrack = (e) => {
      stream.addTrack(e.track);
      v.srcObject = stream;
    };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const t = setTimeout(resolve, 2000);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
    });
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: pc.localDescription!.sdp });
    if (!res.ok) throw new Error(`WHEP ${res.status}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebRTC connect timeout')), 8000);
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'connected') { clearTimeout(t); resolve(); }
        if (pc.connectionState === 'failed') { clearTimeout(t); reject(new Error('WebRTC failed')); }
      });
    });
    pc.addEventListener('connectionstatechange', () => {
      if ((pc.connectionState === 'failed' || pc.connectionState === 'disconnected') && this.pc === pc && this.playback) {
        // Mid-stream failure → HLS.
        this.pc = null;
        pc.close();
        void this.loadHls(this.playback.hls, v).then(() => { this._mode = 'hls'; this.tryPlay(); });
      }
    });
  }

  private tryPlay() {
    const v = this.video;
    if (!v) return;
    v.play().then(() => { this._needsTap = false; }).catch(() => { this._needsTap = true; this._loading = false; });
  }

  private onTime() {
    const v = this.video!;
    const now = Date.now();
    if (now - this.lastEmit > 1000) {
      this.lastEmit = now;
      this.dispatchEvent(new CustomEvent('ghq-time', { detail: { position: v.currentTime, playing: !v.paused } }));
    }
    if (this.resumeKey && this.playback?.seekable && now - this.lastSave > 5000) {
      this.lastSave = now;
      store.set(this.resumeKey, String(Math.floor(v.currentTime)));
    }
  }

  private onSeeking() {
    const exp = this.expectedPosition();
    const v = this.video!;
    if (exp !== null && Math.abs(v.currentTime - exp) > 3) v.currentTime = exp;
  }

  private onPlay() {
    this._paused = false;
    // Evergreen: resuming after a pause rejoins "now", like a live broadcast.
    const exp = this.expectedPosition();
    const v = this.video!;
    if (exp !== null && Math.abs(v.currentTime - exp) > 3) v.currentTime = exp;
  }

  private toggleCaptions() {
    const v = this.video;
    if (!v) return;
    this._captions = !this._captions;
    for (const t of Array.from(v.textTracks)) t.mode = this._captions && (t.kind === 'captions' || t.kind === 'subtitles') ? 'showing' : 'disabled';
  }

  private fullscreen() {
    const el = this.renderRoot.querySelector<HTMLElement>('.wrap');
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (el.requestFullscreen) void el.requestFullscreen();
    else (this.video as HTMLVideoElement & { webkitEnterFullscreen?: () => void })?.webkitEnterFullscreen?.();
  }

  render() {
    const p = this.playback;
    const custom = !!p && !p.seekable; // live + evergreen: no scrub bar
    const live = !!p?.low_latency;
    return html`
      <div class="wrap">
        <video
          playsinline
          ?controls=${!custom}
          controlslist="nodownload noplaybackrate noremoteplayback"
          disablepictureinpicture
          aria-label=${this.title}
          @timeupdate=${this.onTime}
          @seeking=${this.onSeeking}
          @play=${this.onPlay}
          @playing=${() => (this._loading = false)}
          @waiting=${() => (this._loading = true)}
          @pause=${() => (this._paused = true)}
          @volumechange=${() => (this._muted = !!this.video?.muted)}
          @contextmenu=${(e: Event) => e.preventDefault()}
        ></video>
        ${custom ? html`
          <div class="bar ${this._paused ? 'show' : ''}">
            <button @click=${() => (this.video!.paused ? this.tryPlay() : this.video!.pause())} aria-label=${this._paused ? 'Play' : 'Pause'}>${this._paused ? icon.play() : icon.pause()}</button>
            <button @click=${() => { const v = this.video!; v.muted = !v.muted; }} aria-label=${this._muted ? 'Unmute' : 'Mute'}>${this._muted ? icon.muted() : icon.volume()}</button>
            <span class="state"><span class="dot ${live ? 'pulse' : ''}"></span>${live ? 'Live' : 'Scheduled replay'}</span>
            <span class="spacer"></span>
            ${this._hasCaptions ? html`<button @click=${this.toggleCaptions} aria-pressed=${this._captions ? 'true' : 'false'} aria-label="Captions">${icon.captions()}</button>` : nothing}
            <button @click=${this.fullscreen} aria-label="Full screen">${icon.expand()}</button>
          </div>` : nothing}
        ${this._needsTap ? html`<div class="overlay"><button class="rise" @click=${() => this.tryPlay()}>${icon.play()} Click to watch</button></div>`
          : this._loading && p ? html`<div class="overlay" aria-label="Loading video"><div class="spinner"></div></div>` : nothing}
      </div>`;
  }
}

customElements.get('ghq-player') || customElements.define('ghq-player', GhqPlayer);
