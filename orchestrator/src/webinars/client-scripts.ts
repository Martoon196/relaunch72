/**
 * Browser scripts served from our own origin (CSP script-src 'self'). Plain
 * ES2019, no build step. Signals are only sent from real player events: a page
 * load records nothing beyond the server-side 'room_accessed'.
 */

export const PUBLIC_ROOM_SCRIPT = String.raw`(function () {
  'use strict';
  var fmt = { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  Array.prototype.forEach.call(document.querySelectorAll('time[data-local-time]'), function (t) {
    try { var d = new Date(t.getAttribute('datetime')); t.title = t.textContent; t.textContent = d.toLocaleString(undefined, fmt) + ' (your time)'; } catch (e) {}
  });
  var root = document.querySelector('[data-room]');
  if (!root) return;
  var base = '/w/' + root.getAttribute('data-key');
  var $ = function (s) { return root.querySelector(s); };
  var video = $('[data-video]'), overlay = $('[data-overlay]'), label = $('[data-state-label]'), message = $('[data-state-message]');
  var countdown = $('[data-countdown]'), playBtn = $('[data-play]'), note = $('[data-note]');
  var ctaBox = $('[data-cta]'), ctaLabel = $('[data-cta-label]'), ctaBody = $('[data-cta-body]'), ctaLink = $('[data-cta-link]');
  var state = null, skew = 0, fetchedAt = 0, hls = null, src = null, srcExpires = 0, srcMode = null, started = false, lastPos = null, timer = null;
  var nativePlayback = false, recoveryTimer = null, recoveryAttempts = 0, mediaIssue = false, autoplayBlocked = false, playbackSeen = false;
  var PLAYING = { live: 1, scheduled_playing: 1, replay: 1, on_demand: 1 };

  function now() { return Date.now() + skew; }
  function setNote(t) { note.textContent = t || ''; }
  function post(path, data) {
    return fetch(base + path, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }).catch(function () { return null; });
  }
  function signal(kind, extra) {
    var mode = state && state.playMode ? state.playMode : 'waiting';
    var payload = { kind: kind, mode: mode };
    if (extra) { payload.from = extra.from; payload.to = extra.to; }
    post('/signal', payload);
  }
  // Content position: wall clock since the session opened for live; the player for everything else.
  function position() {
    if (state && state.playMode === 'live' && state.sessionStartedAt) return Math.max(0, (now() - Date.parse(state.sessionStartedAt)) / 1000);
    return video.currentTime || 0;
  }
  function expectedOffset() {
    if (!state || state.playMode !== 'scheduled_recording' || state.offsetSeconds == null) return null;
    return state.offsetSeconds + (Date.now() - fetchedAt) / 1000;
  }
  function loadHls() {
    return new Promise(function (resolve) {
      if (window.Hls) return resolve(window.Hls);
      var s = document.createElement('script'); s.src = '/w/_assets/hls.js';
      s.onload = function () { resolve(window.Hls || null); }; s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
  }
  function tryPlay() {
    // Only offer "Start watching" when there is real video attached; never a button with nothing behind it.
    if (!src) { playBtn.hidden = true; return; }
    var expected = src;
    var p = video.play();
    if (p && p.then) p.then(function () {
      if (src !== expected) return;
      autoplayBlocked = false; paintPlayback();
    }, function (error) {
      if (src !== expected || !src || (error && error.name === 'AbortError')) return;
      if (error && error.name === 'NotAllowedError') { autoplayBlocked = true; paintPlayback(); }
      else recoverPlayback();
    });
  }
  function clearRecovery() { clearTimeout(recoveryTimer); recoveryTimer = null; }
  function paintPlayback() {
    if (!state || !src) return;
    overlay.hidden = playbackSeen && !autoplayBlocked && !mediaIssue;
    playBtn.hidden = !autoplayBlocked && !(mediaIssue && recoveryAttempts >= 12);
    playBtn.textContent = autoplayBlocked ? 'Start watching' : 'Try playback again';
    message.textContent = autoplayBlocked ? 'Press play to start watching.' : mediaIssue ? 'Video is reconnecting…' : playbackSeen ? state.message : 'Starting video…';
    setNote(autoplayBlocked ? 'Your browser needs a tap to play sound.' : mediaIssue
      ? recoveryAttempts >= 12 ? 'Video could not start. Tap Try playback again to retry.' : 'Waiting for the video stream — retrying automatically.'
      : !playbackSeen ? 'Connecting to the video stream…'
      : state.playMode === 'scheduled_recording' ? 'This is a recording shown at a scheduled time. Everyone watches the same moment, so skipping is turned off.'
      : state.playMode === 'live' ? 'You are watching live.' : state.replayUntil ? 'Replay available until ' + new Date(state.replayUntil).toLocaleString(undefined, fmt) + ' (your time).' : '');
  }
  function recoverPlayback() {
    if (!src) return;
    mediaIssue = true; lastPos = null;
    // Native HLS can permanently stop after a first manifest/segment request
    // races the encoder. State polling alone does not reload that failed URL.
    if (nativePlayback && recoveryTimer == null && recoveryAttempts < 12) {
      var expected = src;
      recoveryTimer = setTimeout(function () {
        recoveryTimer = null;
        if (!src || src !== expected || !state || !PLAYING[state.state]) return;
        recoveryAttempts++; video.load(); tryPlay(); paintPlayback();
      }, 3000);
    }
    paintPlayback();
  }
  function attach(url, mode) {
    var keep = mode === srcMode && (mode === 'replay' || mode === 'on_demand') ? video.currentTime : null;
    clearRecovery(); recoveryAttempts = 0; mediaIssue = false; autoplayBlocked = false; playbackSeen = false;
    nativePlayback = false; src = url; srcMode = mode;
    var done = function () {
      video.addEventListener('loadedmetadata', function once() {
        video.removeEventListener('loadedmetadata', once);
        var exp = expectedOffset();
        if (exp != null) video.currentTime = exp;
        else if (keep) video.currentTime = keep;
        else if (mode === 'replay' || mode === 'on_demand') {
          try { var saved = Number(localStorage.getItem('wb:pos:' + base)); if (saved > 10 && (!video.duration || saved < video.duration - 15)) video.currentTime = saved; } catch (e) {}
        }
      });
      tryPlay();
    };
    if (video.canPlayType('application/vnd.apple.mpegurl')) { nativePlayback = true; video.src = url; done(); return; }
    loadHls().then(function (Hls) {
      if (!Hls || !Hls.isSupported()) { setNote('This browser cannot play the video. Please use a current Chrome, Edge, Firefox or Safari.'); return; }
      if (hls) hls.destroy();
      hls = new Hls({ lowLatencyMode: mode === 'live', backBufferLength: 60 });
      hls.on(Hls.Events.ERROR, function (_e, d) {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) { setNote('Connection interrupted — reconnecting…'); setTimeout(function () { hls && hls.startLoad(); }, 3000); }
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      });
      hls.loadSource(url); hls.attachMedia(video); done();
    });
  }
  function detach() {
    clearRecovery(); nativePlayback = false; mediaIssue = false; autoplayBlocked = false; playbackSeen = false;
    if (hls) { hls.destroy(); hls = null; }
    if (src) { video.removeAttribute('src'); video.load(); }
    src = null; srcMode = null;
  }
  function human(ms) {
    if (ms <= 0) return '';
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
    if (h > 0) return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
    return m + 'm ' + (sec < 10 ? '0' : '') + sec + 's';
  }
  function renderCountdown() {
    if (!state || PLAYING[state.state]) { countdown.textContent = ''; return; }
    var target = state.state === 'not_started' ? state.opensAt : (state.state === 'waiting' ? state.startsAt : null);
    countdown.textContent = target ? human(Date.parse(target) - now()) : '';
  }
  function renderCta() {
    var c = state && state.cta;
    var show = false;
    if (c && PLAYING[state.state]) show = c.atSeconds != null ? position() >= c.atSeconds : c.visible;
    if (c && !PLAYING[state.state] && c.visible && state.state !== 'not_started') show = true;
    if (!c || !show) { ctaBox.hidden = true; return; }
    ctaLabel.textContent = c.label; ctaBody.textContent = c.body || ''; ctaLink.textContent = c.label; ctaLink.href = c.url; ctaBox.hidden = false;
  }
  function apply(s) {
    var prev = state;
    state = s; fetchedAt = Date.now(); skew = Date.parse(s.serverNow) - Date.now();
    label.textContent = s.label; label.className = 'state' + (s.state === 'live' ? ' live' : '');
    var playing = !!PLAYING[s.state] && !!s.hlsUrl;
    if (playing) {
      var expiring = srcExpires && Date.parse(s.expiresAt) > srcExpires && srcExpires - Date.now() < 10 * 60 * 1000;
      if (!src || s.playMode !== srcMode || expiring) { srcExpires = Date.parse(s.expiresAt); attach(s.hlsUrl, s.playMode); }
      paintPlayback();
      video.controls = true;
    } else {
      if (src) detach();
      overlay.hidden = false; message.textContent = s.message; playBtn.hidden = true;
      setNote(s.state === 'interrupted' ? 'Stay on this page — the video will resume automatically.' : '');
    }
    if (prev && prev.state !== s.state && s.state === 'live') tryPlay();
    renderCountdown(); renderCta();
  }
  function poll() {
    fetch(base + '/state', { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(function (r) {
      if (r.status === 401) { location.href = base; return null; }
      return r.ok ? r.json() : null;
    }).then(function (s) { if (s) apply(s); }).catch(function () { setNote('Connection problem — retrying…'); }).then(schedule);
  }
  function schedule() {
    clearTimeout(timer);
    var st = state ? state.state : '';
    var fast = st === 'waiting' || st === 'host_connecting' || st === 'interrupted' || st === 'processing' ||
      (st === 'not_started' && state.opensAt && Date.parse(state.opensAt) - now() < 20 * 60 * 1000);
    var delay = fast ? 5000 : (st === 'live' || st === 'scheduled_playing') ? 10000 : 30000;
    timer = setTimeout(poll, document.hidden ? Math.max(delay, 30000) : delay);
  }
  // Player-reported viewing only.
  video.addEventListener('playing', function () {
    clearRecovery(); recoveryAttempts = 0; mediaIssue = false; autoplayBlocked = false; playbackSeen = true; paintPlayback();
    if (!started) { started = true; signal('player_started'); }
    lastPos = position();
  });
  video.addEventListener('error', recoverPlayback);
  video.addEventListener('pause', function () { lastPos = null; });
  video.addEventListener('seeking', function () {
    var exp = expectedOffset();
    if (exp != null && Math.abs(video.currentTime - exp) > 3) video.currentTime = exp;
    lastPos = null;
  });
  setInterval(function () {
    if (video.paused || !state || !PLAYING[state.state]) return;
    var pos = position();
    if (lastPos != null && pos > lastPos && pos - lastPos <= 120) signal('watch_interval', { from: Math.round(lastPos * 10) / 10, to: Math.round(pos * 10) / 10 });
    lastPos = pos;
    if (state.playMode === 'replay' || state.playMode === 'on_demand') { try { localStorage.setItem('wb:pos:' + base, String(Math.floor(video.currentTime))); } catch (e) {} }
  }, 30000);
  setInterval(function () { renderCountdown(); renderCta(); }, 1000);
  playBtn.addEventListener('click', function () {
    if (mediaIssue && nativePlayback) { clearRecovery(); recoveryAttempts = 0; video.load(); }
    tryPlay();
  });
  ctaLink.addEventListener('click', function () { signal('cta_clicked'); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });

  // Questions.
  var list = $('[data-questions]'), ask = $('[data-ask]'), askStatus = $('[data-ask-status]');
  function renderQuestions(items) {
    if (!list) return;
    list.textContent = '';
    if (!items.length) { var li0 = document.createElement('li'); li0.className = 'muted small'; li0.textContent = 'No questions yet.'; list.appendChild(li0); return; }
    items.forEach(function (q) {
      var li = document.createElement('li');
      var p = document.createElement('div'); p.textContent = q.body; li.appendChild(p);
      if (q.mine && q.status === 'pending') { var w = document.createElement('div'); w.className = 'small muted'; w.textContent = 'Your question · waiting for the host'; li.appendChild(w); }
      if (q.answer) { var a = document.createElement('div'); a.className = 'ans small'; a.textContent = q.answer; li.appendChild(a); }
      list.appendChild(li);
    });
  }
  function loadQuestions() {
    if (!list) return;
    fetch(base + '/questions', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) renderQuestions(d.questions || []); }).catch(function () {});
  }
  if (ask) {
    ask.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var text = ask.elements.body.value.trim();
      if (!text) return;
      var btn = ask.querySelector('button'); btn.disabled = true; askStatus.textContent = 'Sending…';
      post('/questions', { body: text }).then(function (r) { return r ? r.json().then(function (j) { return { status: r.status, body: j }; }) : null; }).then(function (r) {
        btn.disabled = false;
        if (r && r.status === 200) { ask.reset(); askStatus.textContent = 'Sent.'; loadQuestions(); }
        else askStatus.textContent = r && r.status === 429 ? 'Please wait a few minutes before asking again.' : 'Your question could not be sent.';
      });
    });
    setInterval(loadQuestions, 20000);
    loadQuestions();
  }
  poll();
})();`;

export const PORTAL_WEBINAR_SCRIPT = String.raw`(function () {
  'use strict';
  Array.prototype.forEach.call(document.querySelectorAll('form[data-confirm]'), function (f) {
    f.addEventListener('submit', function (ev) { if (!window.confirm(f.getAttribute('data-confirm'))) ev.preventDefault(); });
  });
  function loadHls() {
    return new Promise(function (resolve) {
      if (window.Hls) return resolve(window.Hls);
      var s = document.createElement('script'); s.src = '/portal/webinars/_assets/hls.js';
      s.onload = function () { resolve(window.Hls || null); }; s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
  }

  // ── Resumable (tus) upload straight to Cloudflare Stream ──
  var up = document.querySelector('[data-upload]');
  if (up) {
    var input = up.querySelector('input[type=file]'), start = up.querySelector('[data-upload-start]');
    var bar = up.querySelector('.wb-progress span'), status = up.querySelector('[data-upload-status]');
    var id = up.getAttribute('data-event'), csrf = up.getAttribute('data-csrf');
    var CHUNK = 50 * 1024 * 1024; // multiple of 256 KiB, above the 5 MiB minimum
    input.addEventListener('change', function () { start.disabled = !input.files || !input.files[0]; });
    function say(t) { status.textContent = t; }
    function api(path, body) {
      return fetch('/portal/webinars/' + id + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, accept: 'application/json' }, body: JSON.stringify(body || {}) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Request failed'); return j; }); });
    }
    function offsetOf(url) {
      return fetch(url, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } }).then(function (r) { return Number(r.headers.get('Upload-Offset')); });
    }
    function send(url, file, offset, tries) {
      if (offset >= file.size) return Promise.resolve();
      var chunk = file.slice(offset, Math.min(offset + CHUNK, file.size));
      return fetch(url, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }, body: chunk })
        .then(function (r) {
          if (r.status !== 204 && r.status !== 200) throw new Error('Upload chunk refused (' + r.status + ')');
          var next = Number(r.headers.get('Upload-Offset')) || offset + chunk.size;
          bar.style.width = Math.round(next / file.size * 100) + '%';
          say('Uploading… ' + Math.round(next / file.size * 100) + '%');
          return send(url, file, next, 0);
        }, function () { throw new Error('network'); })
        .catch(function (err) {
          if (tries >= 5) throw err;
          say('Connection dropped — resuming…');
          return new Promise(function (r) { setTimeout(r, 2000 * (tries + 1)); })
            .then(function () { return offsetOf(url); })
            .then(function (o) { return send(url, file, isFinite(o) ? o : offset, tries + 1); }, function () { return send(url, file, offset, tries + 1); });
        });
    }
    start.addEventListener('click', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      start.disabled = true; input.disabled = true; say('Starting upload…');
      api('/upload', { bytes: file.size, name: file.name }).then(function (r) { return send(r.uploadUrl, file, 0, 0); })
        .then(function () { say('Upload complete. Cloudflare is processing the video…'); return api('/upload/done'); })
        .then(function () { location.reload(); })
        .catch(function (err) { say('Upload failed: ' + err.message + '. You can try again.'); start.disabled = false; input.disabled = false; });
    });
  }

  // ── Host screen: status polling and private preview ──
  var host = document.querySelector('[data-host]');
  if (host) {
    var hid = host.getAttribute('data-event');
    var preview = host.querySelector('[data-preview]'), pstat = host.querySelector('[data-preview-status]');
    var roomLabel = host.querySelector('[data-room-label]'), liveLabel = host.querySelector('[data-live-state]');
    var hls = null, current = null, lastState = null;
    if (preview && pstat) preview.addEventListener('playing', function () { pstat.textContent = 'Private preview: this is what Cloudflare is receiving.'; });
    var names = { idle: 'Encoder not connected', connected: 'Encoder connected', reconnecting: 'Encoder reconnecting', disconnected: 'Encoder disconnected', unknown: 'Status unknown', not_provisioned: 'No live input', provisioning: 'Creating live input' };
    function play(url) {
      if (!url || url === current) return;
      current = url;
      if (preview.canPlayType('application/vnd.apple.mpegurl')) { preview.src = url; preview.play().catch(function () {}); return; }
      loadHls().then(function (Hls) {
        if (!Hls || !Hls.isSupported()) { pstat.textContent = 'This browser cannot play the preview.'; return; }
        if (hls) hls.destroy();
        hls = new Hls({ lowLatencyMode: true }); hls.loadSource(url); hls.attachMedia(preview);
        hls.on(Hls.Events.ERROR, function (_e, d) { if (d.fatal) pstat.textContent = 'No video yet. Start your encoder; the preview appears within a few seconds of Cloudflare receiving it.'; });
        hls.on(Hls.Events.MANIFEST_PARSED, function () { pstat.textContent = 'Private preview — attendees do not see this until you go live.'; preview.play().catch(function () {}); });
      });
    }
    function tick() {
      fetch('/portal/webinars/' + hid + '/host/state', { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
          if (!s) return;
          if (roomLabel) roomLabel.textContent = s.roomLabel;
          if (liveLabel) { liveLabel.textContent = names[s.liveState] || s.liveState; liveLabel.className = 'wb-status ' + (s.liveState === 'connected' ? 'ok' : s.liveState === 'disconnected' ? 'bad' : 'warn'); }
          if (lastState && lastState !== s.liveState && s.liveState === 'connected') current = null;
          lastState = s.liveState;
          if (s.preview && s.preview.hlsUrl && (!current || s.liveState === 'connected')) play(s.preview.hlsUrl);
          else if (!s.preview) pstat.textContent = 'Nothing to preview yet.';
        }).catch(function () {});
    }
    tick(); setInterval(tick, 10000);

    var cam = host.querySelector('[data-camera]');
    if (cam) {
      var startB = host.querySelector('[data-camera-start]'), stopB = host.querySelector('[data-camera-stop]'), meter = host.querySelector('[data-meter]'), cstat = host.querySelector('[data-camera-status]');
      var media = null, ctx = null, raf = 0;
      startB.addEventListener('click', function () {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { cstat.textContent = 'This browser cannot access a camera.'; return; }
        navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(function (stream) {
          media = stream; cam.srcObject = stream; cam.play();
          var AC = window.AudioContext || window.webkitAudioContext;
          if (AC) {
            ctx = new AC(); var an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an);
            var data = new Uint8Array(an.fftSize);
            (function draw() { an.getByteTimeDomainData(data); var peak = 0; for (var i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128)); meter.style.width = Math.min(100, peak / 128 * 140) + '%'; raf = requestAnimationFrame(draw); })();
          }
          var v = stream.getVideoTracks()[0], a = stream.getAudioTracks()[0];
          cstat.textContent = 'Camera: ' + (v ? v.label || 'on' : 'none') + ' · Microphone: ' + (a ? a.label || 'on' : 'none') + '. Speak to see the level move. This check never leaves your device.';
          startB.disabled = true; stopB.disabled = false;
        }, function (err) { cstat.textContent = 'Camera or microphone blocked: ' + err.name + '. Allow access in your browser settings and try again.'; });
      });
      stopB.addEventListener('click', function () {
        if (media) media.getTracks().forEach(function (t) { t.stop(); });
        if (ctx) ctx.close(); cancelAnimationFrame(raf); meter.style.width = '0'; cam.srcObject = null; startB.disabled = false; stopB.disabled = true; cstat.textContent = 'Check stopped.';
      });
    }
  }
})();`;

/** Ticks the studio compositor from a worker so a backgrounded tab (host presenting slides) keeps drawing. */
export const STUDIO_TICK_SCRIPT = String.raw`setInterval(function () { postMessage(0); }, 33);`;

/**
 * Browser studio: camera + microphone + screen share composited on a canvas,
 * recorded as H.264/Opus and sent over a same-origin WebSocket to the server
 * relay, which forwards it to the webinar's recorded Cloudflare live input. The
 * page never sees the stream key; it holds only a one-time ticket.
 */
export const STUDIO_SCRIPT = String.raw`(function () {
  'use strict';
  var root = document.querySelector('[data-studio]');
  if (!root) return;
  function $(s) { return root.querySelector(s); }
  var base = '/portal/webinars/' + root.getAttribute('data-event');
  var csrf = root.getAttribute('data-csrf');
  var canvas = $('[data-studio-canvas]'), g = canvas.getContext('2d');
  var devStart = $('[data-devices-start]'), camToggle = $('[data-cam-toggle]'), micToggle = $('[data-mic-toggle]'), screenToggle = $('[data-screen-toggle]');
  var camSelect = $('[data-cam-select]'), micSelect = $('[data-mic-select]'), quality = $('[data-quality]'), meter = $('[data-studio-meter]');
  var sendStart = $('[data-send-start]'), sendStop = $('[data-send-stop]'), relayState = $('[data-relay-state]'), liveState = $('[data-live-state]'), roomLabel = $('[data-room-label]');
  var status = $('[data-studio-status]'), devices = $('[data-studio-devices]');
  var layouts = root.querySelectorAll('input[name="wb-layout"]');
  var camVideo = document.createElement('video'), scrVideo = document.createElement('video');
  [camVideo, scrVideo].forEach(function (v) { v.muted = true; v.playsInline = true; v.autoplay = true; });
  var camStream = null, micStream = null, scrStream = null, camOn = true, micOn = true, layout = 'camera';
  var actx = null, dest = null, micGain = null, analyser = null, micNode = null, scrNode = null, levels = null;
  var recorder = null, ws = null, sending = false, stopping = false, outStream = null;
  var blocked = root.hasAttribute('data-blocked');

  var MIMES = ['video/webm;codecs=h264,opus', 'video/webm;codecs=avc1,opus', 'video/x-matroska;codecs=avc1,opus', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus'];
  var mime = null;
  if (window.MediaRecorder && MediaRecorder.isTypeSupported) for (var i = 0; i < MIMES.length; i++) if (MediaRecorder.isTypeSupported(MIMES[i])) { mime = MIMES[i]; break; }
  var capable = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && canvas.captureStream && mime && window.WebSocket);
  if (!capable) {
    blocked = true;
    say(devices, 'This browser cannot broadcast from the studio (it needs H.264 recording). Use Chrome, Edge or Safari on a computer, or an encoder from Broadcast setup.');
    [devStart, screenToggle].forEach(function (b) { b.disabled = true; });
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) screenToggle.disabled = true;

  function say(el, text) { if (el) el.textContent = text; }
  function pill(el, text, cls) { if (!el) return; el.textContent = text; el.className = 'wb-status' + (cls ? ' ' + cls : ''); }

  // ── drawing ──
  function fit(v, x, y, w, h, cover) {
    var vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    var s = cover ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
    var dw = vw * s, dh = vh * s;
    if (cover) {
      var sw = w / s, sh = h / s;
      g.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h);
    } else {
      g.drawImage(v, 0, 0, vw, vh, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    }
  }
  function rounded(x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function placeholder(x, y, w, h, text) {
    g.fillStyle = '#1b1f27'; g.fillRect(x, y, w, h);
    g.fillStyle = '#9aa3b2'; g.font = '600 ' + Math.round(h / 14) + 'px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, x + w / 2, y + h / 2);
  }
  function draw() {
    var W = canvas.width, H = canvas.height;
    g.fillStyle = '#0f1115'; g.fillRect(0, 0, W, H);
    var cam = camOn && camStream && camVideo.readyState >= 2;
    var scr = scrStream && scrVideo.readyState >= 2;
    var L = layout;
    if (!scr && L !== 'camera') L = 'camera';
    if (L === 'camera') {
      if (cam) fit(camVideo, 0, 0, W, H, true); else placeholder(0, 0, W, H, camStream ? 'Camera off' : 'Turn on your camera to preview');
    } else if (L === 'screen') {
      fit(scrVideo, 0, 0, W, H, false);
    } else if (L === 'pip') {
      fit(scrVideo, 0, 0, W, H, false);
      if (cam) {
        var pw = Math.round(W * 0.24), ph = Math.round(pw * 9 / 16), px = W - pw - Math.round(W * 0.02), py = H - ph - Math.round(W * 0.02);
        g.save(); rounded(px, py, pw, ph, Math.round(ph * 0.08)); g.clip(); fit(camVideo, px, py, pw, ph, true); g.restore();
        g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 3; rounded(px, py, pw, ph, Math.round(ph * 0.08)); g.stroke();
      }
    } else if (L === 'side') {
      var sw = Math.round(W * 0.68), gap = Math.round(W * 0.012);
      fit(scrVideo, gap, gap, sw - gap, H - 2 * gap, false);
      var cx = sw + gap, cw = W - cx - gap, ch = Math.round(cw * 3 / 4), cy = Math.round((H - ch) / 2);
      g.save(); rounded(cx, cy, cw, ch, 14); g.clip();
      if (cam) fit(camVideo, cx, cy, cw, ch, true); else placeholder(cx, cy, cw, ch, 'Camera off');
      g.restore();
    }
    if (analyser && levels) {
      analyser.getByteTimeDomainData(levels);
      var peak = 0;
      for (var k = 0; k < levels.length; k++) peak = Math.max(peak, Math.abs(levels[k] - 128));
      meter.style.width = (micOn ? Math.min(100, peak / 128 * 180) : 0) + '%';
    }
  }
  var ticker = null;
  try { ticker = new Worker(root.getAttribute('data-tick')); ticker.onmessage = draw; } catch (e) { ticker = null; }
  if (!ticker) setInterval(draw, 33);
  draw();

  // ── audio graph: always one outgoing audio track, even when muted ──
  function ensureAudio() {
    if (actx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    actx = new AC();
    dest = actx.createMediaStreamDestination();
    micGain = actx.createGain();
    micGain.connect(dest);
    analyser = actx.createAnalyser(); analyser.fftSize = 512; levels = new Uint8Array(analyser.fftSize);
  }
  function attachMic(stream) {
    if (micNode) { try { micNode.disconnect(); } catch (e) {} }
    micStream = stream;
    if (!stream || !stream.getAudioTracks().length) return;
    micNode = actx.createMediaStreamSource(stream);
    micNode.connect(micGain); micNode.connect(analyser);
  }
  function stopTracks(s) { if (s) s.getTracks().forEach(function (t) { t.stop(); }); }

  function listDevices() {
    return navigator.mediaDevices.enumerateDevices().then(function (list) {
      function fill(sel, kind, current) {
        var opts = list.filter(function (d) { return d.kind === kind; });
        sel.innerHTML = '';
        opts.forEach(function (d, n) { var o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || (kind === 'videoinput' ? 'Camera ' : 'Microphone ') + (n + 1); if (d.deviceId === current) o.selected = true; sel.appendChild(o); });
        sel.disabled = opts.length === 0;
      }
      fill(camSelect, 'videoinput', camStream && camStream.getVideoTracks()[0] && camStream.getVideoTracks()[0].getSettings().deviceId);
      fill(micSelect, 'audioinput', micStream && micStream.getAudioTracks()[0] && micStream.getAudioTracks()[0].getSettings().deviceId);
    });
  }

  function openDevices(camId, micId) {
    ensureAudio();
    if (actx.state === 'suspended') actx.resume();
    var q = quality.value === '1080' ? { width: { ideal: 1920 }, height: { ideal: 1080 } } : { width: { ideal: 1280 }, height: { ideal: 720 } };
    var video = camId ? Object.assign({ deviceId: { exact: camId } }, q) : q;
    var audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (micId) audio.deviceId = { exact: micId };
    say(devices, 'Asking for camera and microphone…');
    return navigator.mediaDevices.getUserMedia({ video: video, audio: audio }).then(function (stream) {
      stopTracks(camStream); stopTracks(micStream);
      camStream = new MediaStream(stream.getVideoTracks());
      camVideo.srcObject = camStream; camVideo.play().catch(function () {});
      attachMic(new MediaStream(stream.getAudioTracks()));
      camToggle.disabled = false; micToggle.disabled = false; sendStart.disabled = blocked;
      devStart.textContent = 'Camera and microphone on'; devStart.disabled = true;
      say(devices, 'Camera and microphone are on. Nothing is sent until you press Start sending.');
      return listDevices();
    }).catch(function (err) {
      say(devices, err && err.name === 'NotAllowedError' ? 'Camera or microphone permission was refused. Allow it in the browser address bar and try again.'
        : 'Could not open the camera or microphone (' + (err && err.name || 'error') + ').');
    });
  }

  devStart.addEventListener('click', function () { openDevices(null, null); });
  camSelect.addEventListener('change', function () { openDevices(camSelect.value, micSelect.value); });
  micSelect.addEventListener('change', function () { openDevices(camSelect.value, micSelect.value); });
  quality.addEventListener('change', function () {
    canvas.width = quality.value === '1080' ? 1920 : 1280; canvas.height = quality.value === '1080' ? 1080 : 720;
    if (sending) say(status, 'The new quality applies the next time you start sending.');
  });
  camToggle.addEventListener('click', function () {
    camOn = !camOn;
    if (camStream) camStream.getVideoTracks().forEach(function (t) { t.enabled = camOn; });
    camToggle.textContent = camOn ? 'Camera off' : 'Camera on';
  });
  micToggle.addEventListener('click', function () {
    micOn = !micOn;
    if (micGain) micGain.gain.value = micOn ? 1 : 0;
    micToggle.textContent = micOn ? 'Mute' : 'Unmute';
    micToggle.className = 'button' + (micOn ? ' secondary' : '');
  });
  function setLayout(v) {
    layout = v;
    Array.prototype.forEach.call(layouts, function (r) { r.checked = r.value === v; });
  }
  Array.prototype.forEach.call(layouts, function (r) { r.addEventListener('change', function () { if (r.checked) layout = r.value; }); });
  function stopScreen() {
    if (scrNode) { try { scrNode.disconnect(); } catch (e) {} scrNode = null; }
    stopTracks(scrStream); scrStream = null; scrVideo.srcObject = null;
    screenToggle.textContent = 'Share screen';
    Array.prototype.forEach.call(layouts, function (r) { if (r.value !== 'camera') r.disabled = true; });
    setLayout('camera');
  }
  screenToggle.addEventListener('click', function () {
    if (scrStream) { stopScreen(); return; }
    ensureAudio();
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true }).then(function (stream) {
      scrStream = stream;
      scrVideo.srcObject = new MediaStream(stream.getVideoTracks()); scrVideo.play().catch(function () {});
      if (stream.getAudioTracks().length) { scrNode = actx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())); scrNode.connect(dest); }
      stream.getVideoTracks()[0].addEventListener('ended', stopScreen);
      screenToggle.textContent = 'Stop sharing';
      Array.prototype.forEach.call(layouts, function (r) { r.disabled = false; });
      if (layout === 'camera') setLayout(camStream ? 'pip' : 'screen');
      if (!camStream) sendStart.disabled = blocked;
    }).catch(function () { say(devices, 'Screen sharing was cancelled.'); });
  });

  // ── sending ──
  function resetSending(message) {
    sending = false; stopping = false;
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (e) {} }
    recorder = null; ws = null;
    sendStart.hidden = false; sendStart.disabled = blocked || !(camStream || scrStream); sendStop.hidden = true;
    pill(relayState, 'Not sending', '');
    if (message) say(status, message);
  }
  function startSending() {
    if (sending) return;
    sendStart.disabled = true;
    say(status, 'Preparing a secure connection…');
    fetch(base + '/studio/ticket', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{}' })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error || 'The studio could not start.'); return j; }); })
      .then(function (j) {
        var socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + j.path);
        ws = socket; sending = true;
        socket.binaryType = 'arraybuffer';
        sendStart.hidden = true; sendStop.hidden = false;
        pill(relayState, 'Connecting', 'warn');
        socket.onopen = function () {
          socket.send(JSON.stringify({ type: 'start', mimeType: mime }));
          var bps = quality.value === '1080' ? 4500000 : 2500000;
          outStream = new MediaStream([canvas.captureStream(30).getVideoTracks()[0], dest.stream.getAudioTracks()[0]]);
          var opts = { mimeType: mime, videoBitsPerSecond: bps, audioBitsPerSecond: 128000, videoKeyFrameIntervalDuration: 2000 };
          try { recorder = new MediaRecorder(outStream, opts); } catch (e) { delete opts.videoKeyFrameIntervalDuration; recorder = new MediaRecorder(outStream, opts); }
          recorder.ondataavailable = function (ev) {
            if (!ev.data || !ev.data.size || socket.readyState !== 1) return;
            if (socket.bufferedAmount > 32 * 1024 * 1024) { stopSending('Your upload cannot keep up with this quality. Choose 720p or check your connection.'); return; }
            socket.send(ev.data);
            if (socket.bufferedAmount > 8 * 1024 * 1024) say(status, 'Your upload is falling behind. Attendees may see a delay.');
          };
          recorder.onerror = function () { stopSending('The browser encoder stopped. Press Start sending to try again.'); };
          recorder.onstop = function () { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'stop' })); };
          recorder.start(500);
        };
        socket.onmessage = function (ev) {
          if (typeof ev.data !== 'string') return;
          var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.type !== 'status') return;
          if (m.state === 'sending') pill(relayState, 'Sending', 'ok');
          else if (m.state === 'starting' || m.state === 'idle') pill(relayState, 'Connecting', 'warn');
          else if (m.state === 'stopping') pill(relayState, 'Stopping', 'warn');
          else if (m.state === 'error') pill(relayState, 'Stopped', 'bad');
          if (m.message) say(status, m.message);
        };
        socket.onclose = function (ev) {
          var unexpected = sending && !stopping;
          resetSending(unexpected ? 'The studio connection closed' + (ev.code === 1011 ? '' : ' unexpectedly') + '. If you are live, attendees see "reconnecting": press Start sending to resume.' : null);
          if (unexpected) pill(relayState, 'Disconnected', 'bad');
        };
      })
      .catch(function (err) { resetSending(err.message || 'The studio could not start.'); });
  }
  function stopSending(reason) {
    if (!sending) return;
    stopping = true;
    pill(relayState, 'Stopping', 'warn');
    if (reason) say(status, reason);
    if (recorder && recorder.state !== 'inactive') recorder.stop(); else if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'stop' }));
  }
  sendStart.addEventListener('click', startSending);
  sendStop.addEventListener('click', function () { stopSending(null); });
  window.addEventListener('beforeunload', function (e) { if (sending) { e.preventDefault(); e.returnValue = ''; } });

  // Host actions must never navigate away from the recorder/WebSocket.
  // Reuse the existing same-origin form and CSRF guard; only update its controls.
  var sessionControls = $('[data-studio-session-controls]'), sessionPending = false;
  function changeSession(form) {
    if (sessionPending) return;
    sessionPending = true;
    var action = form.querySelector('input[name="action"]').value;
    var buttons = sessionControls.querySelectorAll('button');
    Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
    say(status, action === 'end' ? 'Ending the session…' : 'Opening the broadcast…');
    fetch(form.getAttribute('action'), { method: 'POST', credentials: 'same-origin', body: new URLSearchParams(new FormData(form)) })
      .then(function (r) { return r.text().then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var error = doc.querySelector('[role="alert"]');
        if (!r.ok || error || new URL(r.url).searchParams.has('e')) {
          var reason = error || doc.querySelector('.page-heading p');
          throw new Error(reason ? reason.textContent : 'The session change was refused (' + r.status + ').');
        }
        var fresh = doc.querySelector('[data-studio-session-controls]');
        var freshRoot = doc.querySelector('[data-studio]');
        if (!fresh || !freshRoot) throw new Error('Your session could not be confirmed. Keep the studio open and try again.');
        sessionControls.innerHTML = fresh.innerHTML;
        root.setAttribute('data-session-state', freshRoot.getAttribute('data-session-state'));
        var badge = document.querySelector('[data-event-status]'), nextBadge = doc.querySelector('[data-event-status]');
        if (badge && nextBadge) badge.innerHTML = nextBadge.innerHTML;
        var oldNotice = document.querySelector('.notice[role="status"]');
        if (oldNotice) oldNotice.remove();
        if (action === 'end') { blocked = true; stopSending(null); sendStart.disabled = true; }
        var notice = doc.querySelector('.notice[role="status"]');
        say(status, notice ? notice.textContent : action === 'end' ? 'Session ended.' : 'You are live.');
      }); })
      .catch(function (err) {
        say(status, err.message || 'The session could not be changed. Try again.');
        Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; });
      }).then(function () { sessionPending = false; });
  }
  if (sessionControls) sessionControls.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form.matches('form[data-studio-session]')) return;
    ev.preventDefault();
    if (form.querySelector('input[name="action"]').value !== 'end') { changeSession(form); return; }
    if (form.querySelector('[data-studio-end-confirm]')) return;
    var confirmation = document.createElement('div');
    confirmation.setAttribute('data-studio-end-confirm', '');
    confirmation.setAttribute('role', 'group');
    confirmation.setAttribute('aria-label', 'Confirm ending the session');
    var label = document.createElement('p'); label.textContent = 'End the session for everyone? The recording becomes the replay.';
    var yes = document.createElement('button'); yes.type = 'button'; yes.className = 'button'; yes.textContent = 'End for everyone';
    var no = document.createElement('button'); no.type = 'button'; no.className = 'button secondary'; no.textContent = 'Keep broadcasting';
    yes.addEventListener('click', function () { changeSession(form); });
    no.addEventListener('click', function () { confirmation.remove(); });
    confirmation.append(label, yes, no); form.appendChild(confirmation); yes.focus();
  });

  // ── Cloudflare's view (the provider's truth, not the browser's) ──
  var names = { idle: 'Encoder not connected', connected: 'Encoder connected', reconnecting: 'Encoder reconnecting', disconnected: 'Encoder disconnected', unknown: 'Status unknown', not_provisioned: 'No live input', provisioning: 'Creating live input' };
  function poll() {
    fetch(base + '/host/state', { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
      if (!s) return;
      pill(liveState, names[s.liveState] || s.liveState, s.liveState === 'connected' ? 'ok' : s.liveState === 'disconnected' ? 'bad' : 'warn');
      pill(roomLabel, s.roomLabel, s.roomState === 'live' ? 'live' : '');
    }).catch(function () {}).then(function () { setTimeout(poll, sending ? 5000 : 10000); });
  }
  poll();
})();`;
