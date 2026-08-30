/**
 * The immutable founder-pilot policy asset.
 *
 * This is a founder and operator compliance review of one individually
 * consented proof email. It is not legal advice, and recording it claims no
 * solicitor approval: the ledger entries it produces name the review that
 * produced them, in full, so nobody reading them can mistake what they are.
 *
 * It lives in the deployed build rather than in a form field on purpose. The
 * database derives every reference and digest from this asset, the approved
 * copy, the current consent event, the acting user, the request and the
 * verified endpoint. Nothing about the review can be asserted from a browser.
 */

import { createHash } from 'node:crypto';

export const FOUNDER_PILOT_POLICY_ASSET_KEY = 'propertypredator-founder-pilot' as const;
export const FOUNDER_PILOT_POLICY_ASSET_VERSION = 'founder-operator-review-v1' as const;

/**
 * How the ledger describes the authority behind this review.
 *
 * The database writes this same string, and the founder-facing panel shows it
 * before anything is confirmed.
 */
export const FOUNDER_PILOT_REVIEW_AUTHORITY =
  'founder-operator-review-not-legal-advice' as const;

/** How long the recorded authority stays in force. */
export const FOUNDER_PILOT_AUTHORITY_DAYS = 7 as const;

/** The exact facts this pilot fixes, and cannot widen. */
export const FOUNDER_PILOT_ROUTE_CLASSIFICATION = 'individual_consent' as const;
export const FOUNDER_PILOT_SENDER = 'Property Predator' as const;
export const FOUNDER_PILOT_INSTIGATOR = 'Property Predator' as const;

export interface FounderPilotPolicyClause {
  readonly ref: string;
  readonly heading: string;
  readonly text: string;
}

export interface FounderPilotPolicyDocumentRef {
  readonly contentSha256: string;
  readonly documentId: string;
  readonly documentType: string;
  readonly documentVersion: string;
}

/**
 * The complete policy the founder confirms. Every clause is shown before the
 * confirmation phrase is accepted; none of it is summarised at the boundary.
 */
export const FOUNDER_PILOT_POLICY_CLAUSES: readonly FounderPilotPolicyClause[] =
  Object.freeze([
    Object.freeze({
      ref: 'scope',
      heading: 'What this authorises',
      text: 'One email, to one verified endpoint on one Lead 360 contact, under '
        + 'the purpose property_predator_marketing. It authorises no campaign, '
        + 'no second recipient and no repeat send.',
    }),
    Object.freeze({
      ref: 'authority',
      heading: 'Who reviewed this',
      text: 'The founder, acting as operator. This is a founder and operator '
        + 'compliance review. It is not legal advice, and no solicitor has '
        + 'approved it. The ledger records it under that description.',
    }),
    Object.freeze({
      ref: 'pecr-route',
      heading: 'PECR route',
      text: 'Individual consent. The recipient is an individual subscriber who '
        + 'gave consent for this purpose, recorded on the permission rail and '
        + 're-checked at the moment of sending. Neither soft opt-in nor the '
        + 'corporate subscriber exemption is relied on.',
    }),
    Object.freeze({
      ref: 'parties',
      heading: 'Sender and instigator',
      text: 'Property Predator is both the sender and the instigator. No third '
        + 'party instigates this message and no affiliate is involved.',
    }),
    Object.freeze({
      ref: 'ownership',
      heading: 'Ownership and control evidence',
      text: 'None is supplied and none is claimed. The recorded decisions carry '
        + 'ownership_control_checked = false, because this workflow receives no '
        + 'ownership or control evidence and will not invent it.',
    }),
    Object.freeze({
      ref: 'withdrawal',
      heading: 'Withdrawal',
      text: 'A reply, an unsubscribe or a suppression withdraws consent. The '
        + 'suppression and consent ledgers are re-read at enqueue, so a '
        + 'withdrawal recorded after this review still stops the send.',
    }),
    Object.freeze({
      ref: 'effects',
      heading: 'What recording this does not do',
      text: 'Recording the review queues nothing and calls no provider. '
        + 'Authorising the send remains a separate, explicit act.',
    }),
  ] as const);

const UNIT = String.fromCharCode(31);

/**
 * Structured document refs the compliance pack records, one per clause.
 *
 * The affiliate-compliance boundary deliberately rejects raw strings. Each
 * reference therefore carries the exact metadata shape enforced by its insert
 * guard, while the content digest remains derived from the clause displayed to
 * the founder.
 */
export const FOUNDER_PILOT_POLICY_DOCUMENT_REFS:
readonly FounderPilotPolicyDocumentRef[] = Object.freeze(
  FOUNDER_PILOT_POLICY_CLAUSES.map((clause) => Object.freeze({
    contentSha256: createHash('sha256').update([
      'propertypredator.founder-pilot-policy-clause/v1',
      FOUNDER_PILOT_POLICY_ASSET_KEY,
      FOUNDER_PILOT_POLICY_ASSET_VERSION,
      clause.ref,
      clause.heading,
      clause.text,
    ].join(UNIT), 'utf8').digest('hex'),
    documentId: `${FOUNDER_PILOT_POLICY_ASSET_KEY}.${clause.ref}`,
    documentType: clause.ref,
    documentVersion: FOUNDER_PILOT_POLICY_ASSET_VERSION,
  })),
);

/**
 * The bundle digest of the asset above.
 *
 * Computed from the clauses themselves rather than stored as a constant, so the
 * digest and the words a founder reads can never drift apart: editing a clause
 * changes the digest, which changes every derived reference and makes the next
 * record a conflict rather than a silent amendment.
 */
export function founderPilotPolicyBundleSha256(): string {
  return createHash('sha256').update([
    'propertypredator.founder-pilot-policy/v1',
    FOUNDER_PILOT_POLICY_ASSET_KEY,
    FOUNDER_PILOT_POLICY_ASSET_VERSION,
    FOUNDER_PILOT_REVIEW_AUTHORITY,
    FOUNDER_PILOT_ROUTE_CLASSIFICATION,
    ...FOUNDER_PILOT_POLICY_CLAUSES.flatMap(
      (clause) => [clause.ref, clause.heading, clause.text],
    ),
  ].join(UNIT), 'utf8').digest('hex');
}

const COMMIT = /^[0-9a-f]{7,40}$/u;

/**
 * Drafting provenance only, and the ledger column says so.
 *
 * It records which build the wording came from. It is never evidence that
 * anyone approved anything.
 */
export function founderPilotPolicySourceCommit(): string {
  const supplied = process.env.PROPERTY_PREDATOR_BUILD_COMMIT?.trim().toLowerCase() ?? '';
  if (COMMIT.test(supplied)) return supplied;
  // Deterministic fallback derived from the asset itself, so provenance is
  // still recorded when the build does not stamp a commit.
  return founderPilotPolicyBundleSha256().slice(0, 40);
}
