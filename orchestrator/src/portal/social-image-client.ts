export const SOCIAL_IMAGE_CLIENT_SOURCE = String.raw`(() => {
  'use strict';
  const form = document.getElementById('post-image-form');
  if (!form) return;
  const status = document.getElementById('post-image-status');
  const selection = document.getElementById('post-image-selection');
  const preview = document.getElementById('post-image-preview');
  const data = document.getElementById('post-image-data');
  const alt = document.getElementById('post-image-alt');
  const file = document.getElementById('post-image-file');
  const maker = document.getElementById('post-image-maker');
  const frame = document.getElementById('post-image-frame');
  const drop = document.getElementById('post-image-drop');
  let nonce = null, selectedUrl = null, busy = false;
  async function selectImage(blob) {
    if (busy) return;
    busy = true;
    status.textContent = 'Preparing your image…';
    try {
      if (!blob || blob.size > 15000000) throw new Error('Choose an image smaller than 15 MB.');
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type))
        throw new Error('Choose a JPG, PNG or WebP picture.');
      const bitmap = await createImageBitmap(blob);
      try {
        if (bitmap.width < 200 || bitmap.height < 200 || bitmap.width * bitmap.height > 40000000)
          throw new Error('Choose a picture at least 200 pixels wide and tall.');
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
        if (Math.min(canvas.width, canvas.height) < 200) throw new Error('Choose a less narrow picture.');
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        let encoded;
        for (const quality of [0.9, 0.8, 0.7, 0.6]) {
          encoded = canvas.toDataURL('image/jpeg', quality);
          if (encoded.length <= 800022) break;
        }
        if (!encoded || encoded.length > 800022) throw new Error('This image is too detailed. Choose a smaller picture.');
        data.value = encoded;
        if (selectedUrl) URL.revokeObjectURL(selectedUrl);
        const bytes = Uint8Array.from(atob(encoded.split(',')[1]), c => c.charCodeAt(0));
        selectedUrl = URL.createObjectURL(new Blob([bytes], {type:'image/jpeg'}));
        preview.src = selectedUrl; selection.hidden = false; alt.required = true;
        status.textContent = 'Image selected. Check it, describe it, then save it with your post.';
        alt.focus();
      } finally { bitmap.close(); }
    } catch (error) { status.textContent = error.message || 'That image could not be opened.'; }
    finally { busy = false; }
  }
  file.addEventListener('change', () => { if (file.files[0]) selectImage(file.files[0]); });
  document.getElementById('post-image-choose').addEventListener('click', () => file.click());
  drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.style.borderStyle = 'solid'; });
  drop.addEventListener('dragleave', () => { drop.style.borderStyle = 'dashed'; });
  drop.addEventListener('drop', (event) => {
    event.preventDefault(); drop.style.borderStyle = 'dashed';
    if (event.dataTransfer.files.length !== 1) { status.textContent = 'Drop one picture at a time.'; return; }
    selectImage(event.dataTransfer.files[0]);
  });
  document.getElementById('post-image-create').addEventListener('click', () => {
    if (!nonce) {
      nonce = crypto.randomUUID();
      frame.src = 'https://propertypredator.com/image-maker.html?hqImage=' + nonce;
    }
    maker.hidden = false;
    status.textContent = 'Create your picture below, then choose Use this image. Nothing is published.';
  });
  window.addEventListener('message', (event) => {
    if (event.origin !== 'https://propertypredator.com' || !nonce || event.source !== frame.contentWindow
        || !event.data || event.data.nonce !== nonce) return;
    if (event.data.type === 'pp-image-ready') {
      const notes = document.querySelector('#edit-version textarea[name="artwork_instructions"]');
      frame.contentWindow.postMessage({type:'pp-image-brief', nonce,
        prompt: (notes ? notes.value : form.elements.artwork_instructions.value).slice(0,1800)}, 'https://propertypredator.com');
    }
    if (event.data.type === 'pp-image-selected' && typeof event.data.image === 'string'
        && event.data.image.length <= 20000000
        && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(event.data.image)) {
      const bytes = Uint8Array.from(atob(event.data.image.split(',')[1]), c => c.charCodeAt(0));
      selectImage(new Blob([bytes], {type: event.data.image.split(';')[0].slice(5)}));
      maker.hidden = true;
    }
  });
  form.addEventListener('submit', (event) => {
    if (busy || !data.value) { event.preventDefault(); status.textContent = 'Choose an image first.'; return; }
    const editor = document.querySelector('#edit-version textarea[name="publication_copy"]');
    const notes = document.querySelector('#edit-version textarea[name="artwork_instructions"]');
    if (editor) form.elements.publication_copy.value = editor.value;
    if (notes) form.elements.artwork_instructions.value = notes.value;
    form.querySelector('button[type="submit"]').disabled = true;
    status.textContent = 'Saving the image and words together…';
  });
})();`;
