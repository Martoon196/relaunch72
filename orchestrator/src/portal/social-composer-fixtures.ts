import { createPropertyPredatorContentCatalogFixture } from './content-control-room-fixtures.js';
import type {
  SocialComposerArtworkSnapshot,
  SocialComposerChannel,
  SocialComposerSnapshot,
  SocialComposerVariantSnapshot,
} from './social-composer-presenter.js';

export const PROPERTY_PREDATOR_SOCIAL_COMPOSER_AS_OF = '2026-08-26T08:42:00.000Z';

const CONTENT_VERSION_ID = '82000000-0000-4000-8000-000000000001';
const CONTENT_SHA256 = '0'.repeat(63) + '1';

function artwork(input: Readonly<{
  index: number;
  assetId: string;
  title: string;
  aspectRatio: SocialComposerArtworkSnapshot['aspectRatio'];
  altText: string;
  channels: readonly SocialComposerChannel[];
}>): SocialComposerArtworkSnapshot {
  return Object.freeze({
    assetId: input.assetId,
    title: input.title,
    aspectRatio: input.aspectRatio,
    altText: input.altText,
    blobSha256: input.index.toString(16).padStart(64, '0'),
    sourceItemId: `asset:predator-evidence-card-${input.aspectRatio.replace(':', 'x')}`,
    channels: Object.freeze([...input.channels]),
  });
}

function variant(input: Omit<SocialComposerVariantSnapshot, 'derivedFromContentVersionId' | 'derivedFromContentSha256' | 'approvalState'>): SocialComposerVariantSnapshot {
  return Object.freeze({
    ...input,
    derivedFromContentVersionId: CONTENT_VERSION_ID,
    derivedFromContentSha256: CONTENT_SHA256,
    approvalState: 'working_draft',
  });
}

/**
 * Fictional TEST composition data derived from the already-owned Affiliate
 * Stash source catalogue. Nothing here calls a generator or provider.
 */
export function createPropertyPredatorSocialComposerFixture(): SocialComposerSnapshot {
  const catalogItem = createPropertyPredatorContentCatalogFixture().items[0];
  if (!catalogItem) throw new Error('Property Predator company-content fixture is empty');
  return Object.freeze({
    catalogItem,
    sourceCopy: Object.freeze({
      eyebrow: 'Property intelligence · evidence first',
      headline: 'The postcode is not the opportunity. The evidence is.',
      body: 'A postcode can put a deal on your radar. It cannot tell you whether the numbers survive contact with reality. Property Predator brings planning context, ownership clues, comparables and development evidence into one focused investigation — so your next conversation starts with proof, not hope.',
      ctaLabel: 'Run the opportunity autopsy',
    }),
    variants: Object.freeze([
      variant({
        variantId: 'variant-linkedin-evidence-v1',
        channel: 'linkedin',
        label: 'Founder authority · evidence gap',
        headline: 'Most property opportunities do not fail because of the postcode.',
        body: 'Most property opportunities do not fail because of the postcode.\n\nThey fail in the gap between an exciting headline and the evidence underneath it.\n\nBefore you commit time, capital or credibility, ask:\n→ What does planning history reveal?\n→ Who actually controls the opportunity?\n→ Do the comparables survive context?\n→ What could kill the deal first?\n\nProperty Predator turns that scattered evidence into one focused investigation. Start with proof. Then decide whether the opportunity deserves you.',
        subject: null,
        preheader: null,
        ctaLabel: 'Run the opportunity autopsy',
        artworkAssetId: 'artwork-landscape-evidence',
      }),
      variant({
        variantId: 'variant-instagram-evidence-v1',
        channel: 'instagram',
        label: 'Carousel caption · proof before postcode',
        headline: 'The postcode gets attention. The evidence earns conviction.',
        body: 'The postcode gets attention. The evidence earns conviction.\n\nPlanning context. Ownership clues. Comparable evidence. Development risk. One focused investigation before you fall in love with the deal.\n\nSave this for the next opportunity that looks “too good to miss”.\n\n#PropertyDevelopment #PropertyInvestment #DealAnalysis #PropertyPredator',
        subject: null,
        preheader: null,
        ctaLabel: 'See the evidence stack',
        artworkAssetId: 'artwork-portrait-evidence',
      }),
      variant({
        variantId: 'variant-facebook-evidence-v1',
        channel: 'facebook',
        label: 'Community education · opportunity autopsy',
        headline: 'Would you still want the deal after seeing what could kill it?',
        body: 'Would you still want the deal after seeing what could kill it?\n\nThe attractive postcode is only the opening clue. Property Predator helps you investigate the planning story, ownership picture, comparable evidence and development risks before excitement becomes expensive.\n\nUse the Opportunity Autopsy to turn “this looks interesting” into a decision backed by evidence.',
        subject: null,
        preheader: null,
        ctaLabel: 'Run the opportunity autopsy',
        artworkAssetId: 'artwork-landscape-evidence',
      }),
      variant({
        variantId: 'variant-x-evidence-v1',
        channel: 'x',
        label: 'Sharp insight · evidence stack',
        headline: 'A postcode is a clue, not a conclusion.',
        body: 'A postcode is a clue, not a conclusion.\n\nPlanning context. Ownership signals. Comparable evidence. Risks that could kill the deal.\n\nProperty Predator turns scattered clues into one focused investigation — before excitement gets expensive.',
        subject: null,
        preheader: null,
        ctaLabel: 'Run the autopsy',
        artworkAssetId: 'artwork-square-evidence',
      }),
      variant({
        variantId: 'variant-email-evidence-v1',
        channel: 'email',
        label: 'Lead nurture · evidence-first diagnosis',
        headline: 'The evidence your postcode cannot give you',
        body: 'Hi {{first_name}},\n\nA promising postcode can put an opportunity on your radar. But it cannot tell you whether the numbers, planning context and ownership picture survive a proper investigation.\n\nThat is why we built the Property Predator Opportunity Autopsy: a focused way to expose the evidence, the gaps and the risks before you spend weeks chasing the wrong deal.\n\nStart with proof. Then decide whether the opportunity deserves your time.\n\n— Property Predator',
        subject: 'The postcode is only the first clue',
        preheader: 'See the evidence stack before excitement gets expensive.',
        ctaLabel: 'Run my opportunity autopsy',
        artworkAssetId: 'artwork-email-evidence',
      }),
    ]),
    artwork: Object.freeze([
      artwork({
        index: 21,
        assetId: 'artwork-landscape-evidence',
        title: 'Evidence beats postcode · landscape card',
        aspectRatio: '1.91:1',
        altText: 'Property Predator evidence card contrasting a postcode clue with planning, ownership, comparables and risk evidence.',
        channels: ['linkedin', 'facebook'],
      }),
      artwork({
        index: 22,
        assetId: 'artwork-portrait-evidence',
        title: 'Opportunity Autopsy · portrait carousel cover',
        aspectRatio: '4:5',
        altText: 'Property Predator Opportunity Autopsy cover with a four-part property evidence stack.',
        channels: ['instagram'],
      }),
      artwork({
        index: 23,
        assetId: 'artwork-square-evidence',
        title: 'A clue, not a conclusion · square card',
        aspectRatio: '1:1',
        altText: 'A Property Predator square artwork reading: A postcode is a clue, not a conclusion.',
        channels: ['x', 'instagram', 'facebook'],
      }),
      artwork({
        index: 24,
        assetId: 'artwork-email-evidence',
        title: 'Evidence stack · email header',
        aspectRatio: '16:9',
        altText: 'A dark Property Predator header illustrating planning, ownership, comparable and risk evidence.',
        channels: ['email'],
      }),
    ]),
    tracking: Object.freeze({
      destinationUrl: 'https://propertypredator.co.uk/opportunity-autopsy',
      campaign: 'opportunity_autopsy_launch',
      content: 'evidence_over_postcode_v3',
    }),
    association: Object.freeze({
      offerId: 'offer-opportunity-autopsy',
      offerLabel: 'Opportunity Autopsy',
      journeyId: 'journey-property-predator-core',
      journeyLabel: 'Property Predator · Evidence to Enquiry',
      milestoneId: 'milestone-proof-consumed',
      milestoneLabel: 'Evidence-first education',
    }),
  });
}
