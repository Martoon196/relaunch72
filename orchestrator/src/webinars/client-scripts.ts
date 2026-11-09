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
    var p = video.play();
    if (p && p.then) p.then(function () { playBtn.hidden = true; }, function () { if (!src) return; playBtn.hidden = false; overlay.hidden = false; message.textContent = 'Press play to start watching.'; });
  }
  function attach(url, mode) {
    var keep = mode === srcMode && (mode === 'replay' || mode === 'on_demand') ? video.currentTime : null;
    src = url; srcMode = mode;
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
    if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; done(); return; }
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
      overlay.hidden = true; message.textContent = s.message;
      var expiring = srcExpires && Date.parse(s.expiresAt) > srcExpires && srcExpires - Date.now() < 10 * 60 * 1000;
      if (!src || s.playMode !== srcMode || expiring) { srcExpires = Date.parse(s.expiresAt); attach(s.hlsUrl, s.playMode); }
      setNote(s.playMode === 'scheduled_recording' ? 'This is a recording shown at a scheduled time. Everyone watches the same moment, so skipping is turned off.'
        : s.playMode === 'live' ? 'You are watching live.' : s.replayUntil ? 'Replay available until ' + new Date(s.replayUntil).toLocaleString(undefined, fmt) + ' (your time).' : '');
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
    if (!started) { started = true; signal('player_started'); }
    lastPos = position();
  });
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
  playBtn.addEventListener('click', function () { tryPlay(); });
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
