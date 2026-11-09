/** Pure exact media-use pinning; SQL performs the actual same-transaction public release. */
import type { Article, ArticleVersion, Publication } from './types.js';
import { SeoBlogError } from './types.js';
const RELEASE_PATH = /^\/api\/public\/seo-blog\/media\/([0-9a-f-]{36})\/([0-9a-f]{64})\.jpg$/u;
export interface PublicationMediaRelease {
  readonly ownerAuthorizationId: string;
  readonly reviewedIntentSha256: string;
  readonly releaseId: string;
}
/** Call only around the current media effect assertion/release, never unrelated database work. */
export async function publicationMediaEffectBoundary(operation: () => Promise<void>): Promise<void> {
  try { await operation(); }
  catch (error) {
    if ((error as {code?:string}).code === '55000') throw new SeoBlogError(409, 'Image use needs review. Check its current quality approval, exact owner authorization and withdrawal controls before a new publication.', 'media_effect_held');
    throw error;
  }
}
export function publicationMediaPin(article: Article, version: ArticleVersion, publication: Publication): PublicationMediaRelease | null {
  const image = version.body.image;
  if (!image.url) return null;
  let url: URL; try { url = new URL(image.url); } catch { return null; }
  const native = RELEASE_PATH.exec(url.pathname);
  if (!native) return null;
  if (url.origin !== 'https://app.relaunch72.com' && image.url !== article.heroMedia?.reservation.prospectiveUrl && !publication.mediaRelease) return null;
  const intent = publication.websiteSnapshot?.reviewedIntentSha ?? version.websiteTarget?.deliverySha ?? version.contentSha;
  if (publication.mediaRelease) {
    if (publication.mediaRelease.releaseId !== native[1] || publication.mediaRelease.reviewedIntentSha256 !== intent) throw new SeoBlogError(409, 'The pinned media release does not match this publication.');
    return publication.mediaRelease;
  }
  const selected = article.heroMedia;
  if (!selected || selected.reservation.articleId !== article.id || selected.reservation.prospectiveReleaseId !== native[1]
    || selected.reservation.assetSha256 !== native[2] || selected.reservation.prospectiveUrl !== image.url || selected.reservation.presentation.alt !== image.alt) throw new SeoBlogError(409, 'Select and authorize the exact reviewed hero image for this version before publishing.');
  const authorization = selected.authorizations.find(a => a.articleVersionId === version.id && a.articleContentSha256 === version.contentSha
    && a.reviewedIntentSha256 === intent && a.reservationCommandId === selected.reservation.commandId && a.assetSha256 === native[2]);
  if (!authorization) throw new SeoBlogError(409, 'Authorize the exact hero image use for this final article version before publishing.');
  return { ownerAuthorizationId: authorization.id, reviewedIntentSha256: intent, releaseId: native[1]! };
}
