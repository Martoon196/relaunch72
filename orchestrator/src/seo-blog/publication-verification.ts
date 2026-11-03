/** Stable first independent verification. Latest observations never move campaign dates. */
import { SeoBlogError, type Publication } from './types.js';
function instant(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
export function preservePublicationVerificationAnchor(previous: Publication, proposed: Publication): Publication {
  const { firstVerifiedAt: _untrusted, ...next } = proposed;
  if (previous.firstVerifiedAt !== undefined) {
    if (previous.firstVerifiedAt !== null && !instant(previous.firstVerifiedAt)) throw new SeoBlogError(409, 'The stored first-verification receipt needs review.');
    return { ...next, firstVerifiedAt: previous.firstVerifiedAt };
  }
  // Legacy verified history has no provably immutable first timestamp. An exact owner pin is the remedy.
  if (previous.state === 'published' || previous.verifiedAt !== null) return { ...next, firstVerifiedAt: null };
  if (proposed.state === 'published' && instant(proposed.verifiedAt) && proposed.websiteDelivery?.article.state === 'verified'
    && proposed.websiteDelivery.article.url === proposed.publicUrl && previous.id === proposed.id && previous.versionId === proposed.versionId
    && previous.articleId === proposed.articleId && previous.contentSha === proposed.contentSha && previous.publicUrl === proposed.publicUrl) {
    return { ...next, firstVerifiedAt: proposed.verifiedAt };
  }
  return next;
}
