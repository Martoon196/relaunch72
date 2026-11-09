import { createHash } from 'node:crypto';
import {
  parseFounderSpecialistPack,
  type FounderSpecialistPack,
} from './founder-specialist-pack.js';

const OWNERSHIP_EVIDENCE_ID = 'internal-use-attestation';
const PRIVACY_ATTESTATION = 'founder-attested-no-secrets-credentials-or-customer-data' as const;

/**
 * Sanitised metadata projection of the private adapted marketing method pack.
 * The repository intentionally contains no prompt bodies, reference bodies,
 * source archive names, provider credentials or executable integration.
 */
const HASH_INPUT: Omit<FounderSpecialistPack, 'packageSha256'> = {
  schemaVersion: 1,
  packId: 'property-predator-marketing',
  source: 'founder-supplied-offline-export',
  specialist: {
    specialistId: 'property-predator-marketing',
    name: 'Property Predator Marketing Method Pack',
    sourceKind: 'codex-skill',
    proposalCapabilities: [
      'content-proposal',
      'email-proposal',
      'image-brief-proposal',
      'paid-media-proposal',
      'social-proposal',
      'strategy-proposal',
      'video-script-proposal',
      'workflow-guidance',
    ],
  },
  files: [
    {
      fileId: 'asset.app-icon',
      path: 'assets/pp-app-icon-512.png',
      mediaType: 'image/png',
      byteLength: 11_317,
      contentSha256: '5eba03fb26c53cd4f77b7f061bba69f5c594cafcba3ce19b5900d099fafef5ca',
      role: 'skill-asset',
      ownershipEvidenceId: OWNERSHIP_EVIDENCE_ID,
      privacyAttestation: PRIVACY_ATTESTATION,
    },
    {
      fileId: 'asset.avatar',
      path: 'assets/pp-avatar-1024.png',
      mediaType: 'image/png',
      byteLength: 32_867,
      contentSha256: 'b021095eb6bfdc7275e09898dfb751de307e2fd0e59dd238bb54fbff112f0bfe',
      role: 'skill-asset',
      ownershipEvidenceId: OWNERSHIP_EVIDENCE_ID,
      privacyAttestation: PRIVACY_ATTESTATION,
    },
    {
      fileId: 'instructions.primary',
      path: 'SKILL.md',
      mediaType: 'text/markdown',
      byteLength: 3_507,
      contentSha256: 'ddabda030f6ff845b3974eb9307a6a686ec42fe6e830da139884aeae7bf8cbad',
      role: 'primary-instructions',
      ownershipEvidenceId: OWNERSHIP_EVIDENCE_ID,
      privacyAttestation: PRIVACY_ATTESTATION,
    },
    {
      fileId: 'reference.approval-output',
      path: 'references/approval-and-output.md',
      mediaType: 'text/markdown',
      byteLength: 2_586,
      contentSha256: '044ed79d9332f09aff63e38119f632918128c4d5bc5374d78f679f8ac0eea160',
      role: 'skill-reference',
      ownershipEvidenceId: OWNERSHIP_EVIDENCE_ID,
      privacyAttestation: PRIVACY_ATTESTATION,
    },
    {
      fileId: 'reference.authority',
      path: 'references/authority.md',
      mediaType: 'text/markdown',
      byteLength: 2_593,
      contentSha256: '3363688e276a505db758ec791763cbd21989d748ac59dc2b1a3a140385ea20b7',
      role: 'skill-reference',
      ownershipEvidenceId: OWNERSHIP_EVIDENCE_ID,
      privacyAttestation: PRIVACY_ATTESTATION,
    },
    {
      fileId: 'reference.brand-guidelines',
      path: 'references/brand-guidelines.md',
      mediaType: 'text/markdown',
      byteLength: 42_080,
      contentSha256: '824e165d76feb2ec558a48c2fbbdcca3c34b4f335de2fe39f840a6ebf165e5e2',
      role: 'knowledge-reference',
      ownershipEvidenceId: OWNERSHIP_EVIDENCE_ID,
      privacyAttestation: PRIVACY_ATTESTATION,
    },
    {
      fileId: 'reference.laps',
      path: 'references/laps.md',
      mediaType: 'text/markdown',
      byteLength: 3_214,
      contentSha256: 'd3ee32ee663ad13605af79d656c63ac8fb11b1c9b13abcd6caad7a5775d0ee74',
      role: 'workflow-reference',
      ownershipEvidenceId: OWNERSHIP_EVIDENCE_ID,
      privacyAttestation: PRIVACY_ATTESTATION,
    },
    {
      fileId: 'reference.licensed-methods',
      path: 'references/licensed-methods.md',
      mediaType: 'text/markdown',
      byteLength: 3_406,
      contentSha256: '80ae7a3141b86178d88a34591ade6424be51662876e9a1695bf798b889c7371d',
      role: 'skill-reference',
      ownershipEvidenceId: OWNERSHIP_EVIDENCE_ID,
      privacyAttestation: PRIVACY_ATTESTATION,
    },
    {
      fileId: 'reference.proposal-schema',
      path: 'references/proposal.schema.json',
      mediaType: 'application/json',
      byteLength: 3_700,
      contentSha256: 'a4c543749833efd1fa6f31da55972f39060aa66dbbc98ad3de05362304c55504',
      role: 'skill-template',
      ownershipEvidenceId: OWNERSHIP_EVIDENCE_ID,
      privacyAttestation: PRIVACY_ATTESTATION,
    },
    {
      fileId: 'reference.provenance',
      path: 'references/provenance.md',
      mediaType: 'text/markdown',
      byteLength: 1_892,
      contentSha256: '270182b2fa4f57629a0869c474559674fd92ed17ea426f5bdaf46b8ec9b968bb',
      role: 'skill-reference',
      ownershipEvidenceId: OWNERSHIP_EVIDENCE_ID,
      privacyAttestation: PRIVACY_ATTESTATION,
    },
    {
      fileId: 'reference.routing',
      path: 'references/routing.md',
      mediaType: 'text/markdown',
      byteLength: 3_613,
      contentSha256: '427f001b5cadf8b673e2ddbbc2d89c422885381be556eb1e7828954e185f6ce0',
      role: 'workflow-reference',
      ownershipEvidenceId: OWNERSHIP_EVIDENCE_ID,
      privacyAttestation: PRIVACY_ATTESTATION,
    },
    {
      fileId: 'reference.runtime-facts',
      path: 'references/runtime-facts.md',
      mediaType: 'text/markdown',
      byteLength: 2_282,
      contentSha256: 'bc8c9b32b6490f86a9088d7642875f8ee08947d9383749b6b78b3e5978f348b4',
      role: 'skill-reference',
      ownershipEvidenceId: OWNERSHIP_EVIDENCE_ID,
      privacyAttestation: PRIVACY_ATTESTATION,
    },
    {
      fileId: 'reference.specialists',
      path: 'references/specialists.md',
      mediaType: 'text/markdown',
      byteLength: 4_003,
      contentSha256: 'cf855c15b32a57ada2ec8502ad69d2e23bc2945abd208b87c42487a7cbb48604',
      role: 'skill-reference',
      ownershipEvidenceId: OWNERSHIP_EVIDENCE_ID,
      privacyAttestation: PRIVACY_ATTESTATION,
    },
  ],
  ownershipEvidence: [
    {
      evidenceId: OWNERSHIP_EVIDENCE_ID,
      path: 'evidence/property-predator/internal-use-attestation.md',
      mediaType: 'text/markdown',
      byteLength: 2_890,
      contentSha256: 'e1ca1980b7e083c71ed6a75c30507e182e237bbed65726993f9a99050b846c3f',
      assertion: 'founder-asserted-owned-or-licensed',
      reviewStatus: 'review-required',
    },
  ],
  handling: {
    payload: 'metadata-and-hashes-only',
    promptBodyAccess: 'forbidden',
    archiveHandling: 'never-unpack',
    execution: 'forbidden',
    providerAccess: 'forbidden',
  },
  callable: false,
  effects: 'none',
  reviewStatus: 'review-required',
};

const packageSha256 = 'd73c1a3c299dba60f3be74813a5d7d766a6514e88baeac2522c6c7482e4bc21d';

export const PROPERTY_PREDATOR_MARKETING_PACK: FounderSpecialistPack =
  parseFounderSpecialistPack({ ...HASH_INPUT, packageSha256 });

export const PROPERTY_PREDATOR_MARKETING_SOURCE_INVENTORY_SHA256 =
  '352068edf5fb1be30b9d692ff5a6a11aa91e500019b7da86b9f60aae50c0cf3b';
export const PROPERTY_PREDATOR_MARKETING_SOURCE_FILE_COUNT = 13;
export const PROPERTY_PREDATOR_MARKETING_SOURCE_BYTE_LENGTH = 117_060;

const sourceInventoryRows = PROPERTY_PREDATOR_MARKETING_PACK.files
  .map((file) => Object.freeze({
    key: file.path.toLocaleLowerCase('en-GB'),
    row: `${file.path}\t${file.byteLength}\t${file.contentSha256}`,
  }))
  .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  .map(({ row }) => row);
const sourceInventorySha256 = createHash('sha256')
  .update(sourceInventoryRows.join('\n'), 'utf8')
  .digest('hex');
const sourceByteLength = PROPERTY_PREDATOR_MARKETING_PACK.files
  .reduce((total, file) => total + file.byteLength, 0);
if (sourceInventorySha256 !== PROPERTY_PREDATOR_MARKETING_SOURCE_INVENTORY_SHA256
    || PROPERTY_PREDATOR_MARKETING_PACK.files.length !== PROPERTY_PREDATOR_MARKETING_SOURCE_FILE_COUNT
    || sourceByteLength !== PROPERTY_PREDATOR_MARKETING_SOURCE_BYTE_LENGTH) {
  throw new Error('Property Predator adapted marketing source inventory failed exact verification');
}
