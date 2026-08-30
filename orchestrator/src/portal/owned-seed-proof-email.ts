import { createHash } from 'node:crypto';
import {
  PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
} from '../company-content-adapter/property-predator-ai-inventory.js';
import {
  canonicalCompanyContentEmailDraft,
  type CreateCompanyContentEmailDraftVersionCommand,
} from '../company-content-pg/index.js';
import {
  PROPERTY_PREDATOR_OWNED_SEED_ATTESTATION_MAX_AGE_MS,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_RECIPIENT_BOUNDARY,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_SYSTEM,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_VERSION,
} from '../company-content-pg/property-predator-owned-seed-attestation-policy.js';

export {
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_RECIPIENT_BOUNDARY,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_VERSION,
};
export const PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT =
  'Property Predator Growth HQ — founder delivery proof' as const;
/**
 * Recipient-neutral by construction.
 *
 * The previous copy named office@propertypredator.com, a mailbox the founder
 * does not own, which made the proof unusable and would have addressed a real
 * message to an address nobody had verified. The recipient is now resolved from
 * the verified endpoint on the Lead 360 contact at authorisation time and never
 * written here, so no address of any kind lives in this repository.
 */
export const PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY =
  `This is the founder-only delivery proof for Property Predator Growth HQ.
No customers or affiliates are included. This message is addressed only to the verified founder email endpoint shown in Lead 360.
Reply RECEIVED to prove the full loop:
Mailgun EU → signed receipt → Conversion Inbox → Lead 360 → next action.
No other message is authorised by this proof.` as const;

export interface PropertyPredatorOwnedSeedProofRevision {
  readonly contentItemId: string;
  readonly previousVersionId: string;
  readonly sourceVersion: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function propertyPredatorOwnedSeedProofEmailCommand(
  commandKey: string,
  now: number,
  revision?: PropertyPredatorOwnedSeedProofRevision,
): CreateCompanyContentEmailDraftVersionCommand {
  const checkedAt = new Date(now);
  if (!Number.isFinite(checkedAt.getTime())) throw new Error('Owned-seed proof time is invalid');
  const canonical = canonicalCompanyContentEmailDraft(
    PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT,
    PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY,
  );
  const evidenceManifest = JSON.stringify({
    brandSha256: PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
    contentSha256: sha256(canonical),
    recipientBoundary: PROPERTY_PREDATOR_OWNED_SEED_PROOF_RECIPIENT_BOUNDARY,
    sourceItem: PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM,
    sourceVersion: revision?.sourceVersion ?? PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_VERSION,
  });
  const evidenceSha256 = sha256(evidenceManifest);
  const sourceVersion = revision?.sourceVersion
    ?? PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_VERSION;
  return Object.freeze({
    commandKey,
    ...(revision ? {
      contentItemId: revision.contentItemId,
      previousVersionId: revision.previousVersionId,
    } : {}),
    origin: 'generated',
    title: 'Growth HQ owned-seed delivery proof',
    subject: PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT,
    bodyText: PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY,
    source: Object.freeze({
      system: PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_SYSTEM,
      itemId: PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM,
      version: sourceVersion,
    }),
    blob: Object.freeze({
      storageKey: `company-content/${PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM}/${sourceVersion}`,
      sha256: sha256(canonical),
    }),
    brand: Object.freeze({
      snapshotRef: `propertypredator:brand:${PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256}`,
      sha256: PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
    }),
    attestation: Object.freeze({
      catalogSha256: evidenceSha256,
      checkedAt: checkedAt.toISOString(),
      // This is deterministic company-owned proof copy rather than a volatile
      // third-party feed. Keep the attestation long enough to complete the
      // session-bound 30-minute workflow; Prepare creates a new immutable
      // revision when this evidence eventually expires.
      expiresAt: new Date(
        checkedAt.getTime() + PROPERTY_PREDATOR_OWNED_SEED_ATTESTATION_MAX_AGE_MS,
      ).toISOString(),
    }),
    metadata: Object.freeze({
      evidenceSha256,
      providerEffects: false,
      purpose: 'owned_seed_delivery_proof',
      recipientBoundary: PROPERTY_PREDATOR_OWNED_SEED_PROOF_RECIPIENT_BOUNDARY,
    }),
  });
}
