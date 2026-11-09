import type { PortalCompanyContentReviewSnapshot } from './company-content-service.js';
import type { RenderPortalCompanyContentReviewOptions } from './company-content-review-view.js';
import { CONTENT_SOCIAL_REVISION_ROUTE } from './content-control-room-actions.js';
import { escapeHtml as e } from './ui.js';
import { socialImageCreationPaused } from './social-image-recovery.js';

export function socialImageView(snapshot: PortalCompanyContentReviewSnapshot,
  options: RenderPortalCompanyContentReviewOptions): string {
  const { review, workspace } = snapshot;
  if (!review.social) return '';
  const image = review.social.image;
  const preview = image
    ? `<img src="/portal/content/items/${e(review.contentItemId)}/versions/${e(review.contentVersionId)}/image" alt="${e(image.alt)}" width="${image.width}" height="${image.height}" style="display:block;width:100%;height:auto;max-height:650px;object-fit:contain"><p class="pcr-help">This is the saved image. Approval covers this picture and the words above.</p>`
    : '<p>No image attached yet. Add one before reviewing the finished post.</p>';
  const security = options.security;
  if (socialImageCreationPaused()) return `<section class="pcr-panel" id="post-image"><header class="pcr-panel-head"><h2>Your image</h2></header><div class="pcr-readable">${preview}<p>Adding new pictures is temporarily paused. Your saved post is safe.</p></div></section>`;
  const editable = workspace.canWrite && review.isLatest && !review.approvalStale
    && /^[A-Za-z0-9_-]{20,512}$/u.test(security?.csrfToken ?? '')
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,121}$/u.test(security?.revisionCommandKey ?? '')
    && /^[A-Za-z0-9._-]{20,768}$/u.test(security?.exactRevisionToken ?? '');
  const hidden = (name: string, value: string): string => `<input type="hidden" name="${name}" value="${e(value)}">`;
  const form = !editable || !security ? '' : `<form id="post-image-form" method="post" action="${CONTENT_SOCIAL_REVISION_ROUTE}">
    ${hidden('_csrf', security.csrfToken)}${hidden('command_key', `${security.revisionCommandKey}:image`)}
    ${hidden('content_item_id', review.contentItemId)}${hidden('previous_version_id', review.contentVersionId)}
    ${hidden('expected_content_sha256', review.contentSha256)}${hidden('exact_revision_token', security.exactRevisionToken!)}
    ${hidden('return_exact_item_id', review.contentItemId)}${hidden('return_exact_version_id', review.contentVersionId)}
    ${hidden('publication_copy', review.social.publicationCopy)}${hidden('artwork_instructions', review.social.artworkInstructions ?? '')}
    <input type="hidden" name="image_data_url" id="post-image-data">
    <div id="post-image-drop" style="border:2px dashed #537c77;border-radius:12px;padding:20px;margin:16px 0;background:#f3faf8;color:#153e39">
    <p><strong>Drop a picture here</strong>, or choose one from your device.</p>
    <div style="display:flex;flex-wrap:wrap;gap:12px;margin:16px 0">
      <button type="button" class="pcr-action-link" id="post-image-create">${image ? 'Try another image' : 'Create image'}</button>
      <button type="button" class="pcr-action-link" id="post-image-choose">Choose a picture</button>
      <input type="file" id="post-image-file" accept="image/png,image/jpeg,image/webp" hidden>
    </div>
    <p class="pcr-help" style="color:inherit">JPG, PNG or WebP, up to 15 MB. Use a real screenshot when showing how Property Predator works.</p>
    </div>
    <div id="post-image-maker" hidden>
      <iframe id="post-image-frame" title="Create your post image" allow="identity-credentials-get" style="display:block;box-sizing:border-box;width:100%;height:760px;border:1px solid #537c77;border-radius:12px"></iframe>
    </div>
    <div id="post-image-selection" hidden>
      <img id="post-image-preview" alt="Selected image, not saved yet" style="display:block;max-width:100%;max-height:500px">
      <label for="post-image-alt">Describe the picture for people who cannot see it</label>
      <input id="post-image-alt" name="image_alt" maxlength="500" style="display:block;width:100%;min-height:44px;margin:10px 0" placeholder="For example: Property Predator appraisal showing buying costs">
      <button type="submit" class="pcr-action-link">Save image with this post</button>
      <p class="pcr-help">This saves a draft. Nothing is approved or published.</p>
    </div>
    <p id="post-image-status" role="status" aria-live="polite"></p>
  </form><script src="/portal/content/social-image.js" defer></script>`;
  return `<section class="pcr-panel" id="post-image"><header class="pcr-panel-head"><h2>Your image</h2></header><div class="pcr-readable">${preview}${form}</div></section>`;
}
