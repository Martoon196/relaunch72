import {
  PROPERTY_PREDATOR_MARKETING_PACK,
  PROPERTY_PREDATOR_MARKETING_SOURCE_BYTE_LENGTH,
  PROPERTY_PREDATOR_MARKETING_SOURCE_FILE_COUNT,
  PROPERTY_PREDATOR_MARKETING_SOURCE_INVENTORY_SHA256,
} from '../company-content-adapter/property-predator-marketing-pack-registry.js';
import type {
  PortalBrandBrainAdaptedMethodPack,
  PortalBrandBrainExternalProfile,
} from './brand-brain-service.js';

/**
 * Safe portal metadata for founder-owned consumer profiles. The founder has
 * supplied and authorised the current instructions/knowledge for adaptation
 * into the private Property Predator marketing method pack. These entries are
 * still deliberately inert: Growth HQ has no consumer-product token or call
 * path and must use the reviewed internal runtime instead.
 */
export const PROPERTY_PREDATOR_BRAND_BRAIN_EXTERNAL_PROFILES:
readonly PortalBrandBrainExternalProfile[] = Object.freeze([
  Object.freeze({
    profileId: 'founder-gpt.content-marketer',
    name: 'Content Marketer',
    purpose: 'Founder-trained Property Predator content and customer-avatar specialist.',
    status: 'adapted_internal',
    callable: false,
  }),
  Object.freeze({
    profileId: 'founder-gpt.image-maker',
    name: 'Image Maker',
    purpose: 'Founder-trained visual concepts, art direction and image recipes.',
    status: 'adapted_internal',
    callable: false,
  }),
  Object.freeze({
    profileId: 'founder-gpt.social-media-manager',
    name: 'Social Media Manager',
    purpose: 'Founder-trained channel planning, social copy and engagement workflows.',
    status: 'adapted_internal',
    callable: false,
  }),
  Object.freeze({
    profileId: 'founder-gpt.offer-architect',
    name: 'Offer Architect',
    purpose: 'Founder-trained offer design, value architecture and ecosystem specialist.',
    status: 'adapted_internal',
    callable: false,
  }),
  Object.freeze({
    profileId: 'founder-gpt.direct-response-copywriter',
    name: 'Direct Response Copywriter',
    purpose: 'Founder-trained angle, proof, persuasion and conversion-copy specialist.',
    status: 'adapted_internal',
    callable: false,
  }),
]);

/**
 * Metadata-and-hashes-only projection of the owned adapted method registry.
 * The referenced pack contract forbids prompt bodies, execution and provider
 * access, so composing it cannot create a generation or publishing surface.
 */
export const PROPERTY_PREDATOR_BRAND_BRAIN_ADAPTED_METHOD_PACKS:
readonly PortalBrandBrainAdaptedMethodPack[] = Object.freeze([
  Object.freeze({
    pack: PROPERTY_PREDATOR_MARKETING_PACK,
    sourceInventorySha256: PROPERTY_PREDATOR_MARKETING_SOURCE_INVENTORY_SHA256,
    sourceFileCount: PROPERTY_PREDATOR_MARKETING_SOURCE_FILE_COUNT,
    sourceByteLength: PROPERTY_PREDATOR_MARKETING_SOURCE_BYTE_LENGTH,
  }),
]);
