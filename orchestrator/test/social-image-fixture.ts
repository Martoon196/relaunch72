import { socialImageFromDataUrl } from '../src/company-content-pg/social-image.js';
/** Synthetic structural JPEG fixture; browser decoding is checked separately. */
export const JPEG_FIXTURE = 'data:image/jpeg;base64,'
  + Buffer.from('ffd8ffe000044a46ffc000110800c800c803011100021100031100ffd9', 'hex').toString('base64');
export const IMAGE_FIXTURE = socialImageFromDataUrl(JPEG_FIXTURE, 'An appraisal screenshot');
