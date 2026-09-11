import { parseCompanyContentSocialImage } from '../company-content-pg/social-image.js';
import type { ZernioCalendarMediaResolver } from './zernio-calendar-live.js';
import { ZernioPostingError, type ZernioPostingClient } from './zernio-posting-client.js';

/** The provider receives the same bytes the human saw, only after job authorization. */
export function createCombinedSocialImageMediaResolver(input: Readonly<{
  legacy: ZernioCalendarMediaResolver;
  posting: Pick<ZernioPostingClient, 'prepareMediaUpload'>;
  fetch: typeof globalThis.fetch;
}>): ZernioCalendarMediaResolver {
  return Object.freeze({ async resolve(request: Parameters<ZernioCalendarMediaResolver['resolve']>[0]) {
    const urls: string[] = [];
    for (const item of request.media) {
      if (!item.inlineImage) {
        if (item.storageKey.startsWith('hq-social-image/')) throw new ZernioPostingError('invalid_request');
        const legacy = await input.legacy.resolve({ ...request, media: [item] });
        if (legacy.length !== 1) throw new ZernioPostingError('invalid_request');
        urls.push(legacy[0]!); continue;
      }
      const image = parseCompanyContentSocialImage(item.inlineImage);
      if (image.sha256 !== item.blobSha256 || image.mimeType !== item.mimeType
          || item.storageKey !== `hq-social-image/${image.sha256}`) throw new ZernioPostingError('invalid_request');
      const bytes = Buffer.from(image.base64, 'base64');
      const upload = await input.posting.prepareMediaUpload({ requestId: request.jobId,
        filename: `${image.sha256}.jpg`, contentType: 'image/jpeg', size: bytes.length });
      const destination = new URL(upload.uploadUrl);
      const publicUrl = new URL(upload.publicUrl);
      if (destination.protocol !== 'https:' || destination.username || destination.password
          || destination.port || !destination.hostname.endsWith('.r2.cloudflarestorage.com')
          || publicUrl.protocol !== 'https:' || publicUrl.hostname !== 'media.zernio.com'
          || publicUrl.username || publicUrl.password || publicUrl.port) throw new ZernioPostingError('invalid_provider_response');
      const response = await input.fetch(upload.uploadUrl, { method: 'PUT',
        headers: { 'content-type': 'image/jpeg' }, body: new Uint8Array(bytes),
        redirect: 'error', signal: AbortSignal.timeout(10_000) });
      await response.body?.cancel();
      if (!response.ok) throw new ZernioPostingError('provider_rejected');
      urls.push(upload.publicUrl);
    }
    return Object.freeze(urls);
  } });
}
