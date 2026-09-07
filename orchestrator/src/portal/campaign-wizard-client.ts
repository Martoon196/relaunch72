export const CAMPAIGN_WIZARD_CLIENT_ROUTE = '/portal/assets/campaign-wizard.js' as const;

export const CAMPAIGN_WIZARD_CLIENT_SOURCE = String.raw`(() => {
  'use strict';
  const SPECS = Object.freeze({
    linkedin: [1200, 630], facebook: [1200, 630], instagram: [1080, 1920],
    x: [1200, 630], tiktok: [1080, 1920],
  });
  const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']);
  const form = document.querySelector('[data-channel-pack-form]');
  if (!form) return;
  const drop = form.querySelector('[data-pack-media-drop]');
  const input = form.querySelector('[data-pack-media-input]');
  const choose = form.querySelector('[data-pack-media-choose]');
  const status = form.querySelector('[data-pack-media-status]');
  const previews = form.querySelector('[data-pack-media-previews]');
  const submit = form.querySelector('[type="submit"]');
  let file = null;
  let busy = false;
  let generation = 0;
  let objectUrls = [];

  const say = (message, state) => {
    if (status) status.textContent = message;
    if (drop) drop.dataset.state = state || '';
  };
  const selectedPlatforms = () => Array.from(form.querySelectorAll('[name="platform"]:checked'))
    .map((entry) => entry.value).filter((value) => Object.hasOwn(SPECS, value));
  const clearVariants = () => {
    form.querySelectorAll('[data-pack-media-variant]').forEach((entry) => entry.remove());
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls = [];
    if (previews) previews.replaceChildren();
  };
  const digest = async (blob) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
    .map((value) => value.toString(16).padStart(2, '0')).join('');
  const upload = async (blob, filename, contentType, platform, current) => {
    const endpoint = new URL(form.dataset.mediaUploadUrl || '', window.location.origin);
    if (endpoint.origin !== window.location.origin) throw new Error('Media upload is unavailable.');
    const request = new URLSearchParams();
    request.set('_csrf', form.querySelector('[name="_csrf"]').value || '');
    request.set('command_key', (form.dataset.mediaCommandKey || '') + ':' + platform + ':' + current);
    request.set('filename', filename);
    request.set('content_type', contentType);
    request.set('size', String(blob.size));
    const preparedResponse = await fetch(endpoint.href, {
      method: 'POST', body: request, credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-Requested-With': 'CampaignPackMedia' },
    });
    const prepared = await preparedResponse.json();
    if (!preparedResponse.ok || prepared.ok !== true || typeof prepared.uploadUrl !== 'string'
        || typeof prepared.publicUrl !== 'string') {
      throw new Error(typeof prepared.message === 'string' ? prepared.message : 'Media upload could not be prepared.');
    }
    const uploaded = await fetch(prepared.uploadUrl, {
      method: 'PUT', body: blob, headers: { 'Content-Type': contentType },
    });
    if (!uploaded.ok) throw new Error('Media upload did not complete.');
    return prepared.publicUrl;
  };
  const imageBlob = async (bitmap, width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('This browser cannot prepare image versions.');
    context.fillStyle = '#050608'; context.fillRect(0, 0, width, height);
    const scale = Math.max(width / bitmap.width, height / bitmap.height);
    const drawWidth = bitmap.width * scale; const drawHeight = bitmap.height * scale;
    context.drawImage(bitmap, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    return new Promise((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Image conversion failed.')),
      'image/webp', 0.9,
    ));
  };
  const addVariant = (variant, previewBlob) => {
    const hidden = document.createElement('input');
    hidden.type = 'hidden'; hidden.name = 'media_variant'; hidden.dataset.packMediaVariant = 'true';
    hidden.value = JSON.stringify(variant); form.appendChild(hidden);
    if (!previews) return;
    const item = document.createElement('figure');
    const visual = document.createElement(variant.mediaType === 'image' ? 'img' : 'video');
    const localUrl = URL.createObjectURL(previewBlob); objectUrls.push(localUrl); visual.src = localUrl;
    if (variant.mediaType === 'image') visual.alt = variant.platform + ' media crop preview';
    else { visual.muted = true; visual.controls = true; }
    const caption = document.createElement('figcaption');
    caption.textContent = variant.platform + ' · ' + variant.width + '×' + variant.height;
    item.append(visual, caption); previews.appendChild(item);
  };
  const videoDimensions = (source) => new Promise((resolve, reject) => {
    const video = document.createElement('video'); const url = URL.createObjectURL(source);
    video.preload = 'metadata'; video.onloadedmetadata = () => {
      URL.revokeObjectURL(url); resolve([video.videoWidth, video.videoHeight]);
    };
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Video metadata could not be read.')); };
    video.src = url;
  });
  const prepare = async (source) => {
    const current = ++generation; clearVariants();
    const platforms = selectedPlatforms();
    if (!platforms.length) { say('Choose at least one channel.', 'failed'); return; }
    if (!ALLOWED.has(source.type) || source.size < 1 || source.size > 500000000) {
      say('Choose a JPG, PNG, WebP, MP4, MOV or WebM file up to 500 MB.', 'failed'); return;
    }
    busy = true; if (submit) submit.disabled = true;
    say('Building ' + platforms.length + ' platform-ready media version' + (platforms.length === 1 ? '' : 's') + '…', 'working');
    try {
      if (source.type.startsWith('image/')) {
        const bitmap = await createImageBitmap(source);
        const groups = new Map();
        platforms.forEach((platform) => {
          const [width, height] = SPECS[platform]; const key = width + 'x' + height;
          groups.set(key, { width, height, platforms: [...(groups.get(key)?.platforms || []), platform] });
        });
        for (const group of groups.values()) {
          if (current !== generation) return;
          const blob = await imageBlob(bitmap, group.width, group.height);
          const label = group.width > group.height ? 'landscape' : 'tall';
          const url = await upload(blob, 'property-predator-' + label + '.webp', 'image/webp', label, current);
          const contentSha256 = await digest(blob);
          group.platforms.forEach((platform) => addVariant({ platform, mediaType: 'image', url,
            width: group.width, height: group.height, contentSha256,
            treatment: 'browser_cover_crop' }, blob));
        }
        bitmap.close();
      } else {
        const [width, height] = await videoDimensions(source);
        const url = await upload(source, source.name, source.type, 'video', current);
        const contentSha256 = await digest(source);
        platforms.forEach((platform) => addVariant({ platform, mediaType: 'video', url, width, height,
          contentSha256, treatment: 'original_video' }, source));
      }
      say(platforms.length + ' media version' + (platforms.length === 1 ? '' : 's') + ' ready. Nothing has been scheduled or published.', 'ready');
    } catch (error) {
      clearVariants();
      say('Media preparation failed — ' + (error instanceof Error ? error.message : 'try again.'), 'failed');
    } finally {
      if (current === generation) { busy = false; if (submit) submit.disabled = false; }
    }
  };
  const accept = (candidate) => { if (candidate) { file = candidate; void prepare(candidate); } };
  choose?.addEventListener('click', () => input?.click());
  input?.addEventListener('change', () => accept(input.files && input.files[0]));
  drop?.addEventListener('dragover', (event) => { event.preventDefault(); drop.dataset.drag = 'true'; });
  drop?.addEventListener('dragleave', () => delete drop.dataset.drag);
  drop?.addEventListener('drop', (event) => {
    event.preventDefault(); delete drop.dataset.drag; accept(event.dataTransfer?.files?.[0]);
  });
  form.querySelectorAll('[name="platform"]').forEach((entry) => entry.addEventListener('change', () => {
    if (file) void prepare(file);
  }));
  form.addEventListener('submit', (event) => {
    if (busy || (file && form.querySelectorAll('[data-pack-media-variant]').length !== selectedPlatforms().length)) {
      event.preventDefault(); say(busy ? 'Wait for the media versions to finish.' : 'Prepare the selected media again.', 'failed');
    }
  });
})();`;
