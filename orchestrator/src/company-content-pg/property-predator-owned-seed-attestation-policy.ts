/**
 * The normal catalogue window is intentionally short because most company
 * content originates outside Growth HQ. The one exception below is fixed,
 * deterministic, company-owned proof copy addressed by a separate database
 * rail only to the owned office mailbox.
 */
export const COMPANY_CONTENT_DEFAULT_ATTESTATION_MAX_AGE_MS = 15 * 60 * 1_000;
export const PROPERTY_PREDATOR_OWNED_SEED_ATTESTATION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export const PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_SYSTEM =
  'propertypredator.company-content' as const;
export const PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM =
  'growth-hq-owned-seed-delivery-proof' as const;
export const PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_VERSION =
  'operational-proof-v1' as const;
export const PROPERTY_PREDATOR_OWNED_SEED_PROOF_CONTENT_SHA256 =
  '6dd76f99e782b91b6db96ed15d1867bdab9f70d9594719e75b33e6cafcb19148' as const;

const PROPERTY_PREDATOR_OWNED_SEED_PROOF_REVISION =
  /^operational-proof-[0-9]{17}-[0-9a-f]{16}$/u;

export interface CompanyContentAttestationPolicyInput {
  readonly sourceSystem: string;
  readonly sourceItemId: string;
  readonly sourceVersion: string;
  readonly contentSha256: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function isPropertyPredatorOwnedSeedProof(
  input: CompanyContentAttestationPolicyInput,
): boolean {
  return input.sourceSystem === PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_SYSTEM
    && input.sourceItemId === PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM
    && (input.sourceVersion === PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_VERSION
      || PROPERTY_PREDATOR_OWNED_SEED_PROOF_REVISION.test(input.sourceVersion))
    && input.contentSha256 === PROPERTY_PREDATOR_OWNED_SEED_PROOF_CONTENT_SHA256
    && input.metadata.purpose === 'owned_seed_delivery_proof'
    && input.metadata.recipientBoundary === 'fixed_owned_office'
    && input.metadata.providerEffects === false;
}

export function companyContentAttestationMaxAgeMs(
  input: CompanyContentAttestationPolicyInput,
): number {
  return isPropertyPredatorOwnedSeedProof(input)
    ? PROPERTY_PREDATOR_OWNED_SEED_ATTESTATION_MAX_AGE_MS
    : COMPANY_CONTENT_DEFAULT_ATTESTATION_MAX_AGE_MS;
}
