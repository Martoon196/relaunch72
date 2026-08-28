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
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_SYSTEM,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_VERSION,
} from '../company-content-pg/property-predator-owned-seed-attestation-policy.js';

export {
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_VERSION,
};
export const PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT =
  'Property Predator Growth HQ — owned-seed delivery proof' as const;
export const PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY =
  `This is the internal delivery proof for Property Predator Growth HQ.

No customers or affiliates are included. It is addressed only to office@propertypredator.com.

Reply RECEIVED to verify that the Conversion Inbox can capture and reconcile the owned-seed response.` as const;

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
    recipientBoundary: 'office@propertypredator.com',
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
      recipientBoundary: 'fixed_owned_office',
    }),
  });
}
